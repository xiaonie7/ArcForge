package session

import (
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

// The conversation stream store is the authoritative relay state for chat:
// one ordered event log per conversation with a monotonic seq, a single
// current-run activity record, and persistent per-conversation subscribers.
// Runs are events inside the stream, not stream boundaries.
//
// Invariants (all enforced under the single store mutex):
//  1. Seq is conversation-scoped and monotonic; runs do not own seq.
//  2. run_finished is emitted exactly once per run — the first terminal
//     signal wins, later duplicates are swallowed via the finished-run ring.
//  3. Run handoff is supersession: run_started(B) while A is running
//     atomically synthesizes run_finished(A) first.
//  4. Activity events are composed inside the locked transition that changed
//     them, so they always carry the run id.
//  5. Subscriber sends happen under the mutex (non-blocking); an overflowing
//     subscriber is closed and resumes by re-subscribing with after_seq.
const (
	conversationEventRetention    = 10 * time.Minute
	conversationMaxEvents         = 4096
	conversationMaxEventBytes     = 8 << 20
	conversationIdleRetention     = 30 * time.Minute
	conversationStaleRunTimeout   = 10 * time.Minute
	conversationOfflineRunTimeout = 30 * time.Minute
	conversationReaperInterval    = time.Minute
	conversationFinishedRunMemory = 8
	conversationSubscriberBuffer  = 256
	pendingChatRunRetention       = 5 * time.Minute
	chatCommandDedupeRetention    = 24 * time.Hour
	chatCommandRecoveryGrace      = 30 * time.Second
	// conversationRunReportLostTimeout is the grace window before a run absent
	// from the desktop's run reports is finalized as lost.
	conversationRunReportLostTimeout = 15 * time.Second
)

const (
	RunActivityQueued     = "queued"
	RunActivityRunning    = "running"
	RunActivityCancelling = "cancelling"
)

// Normalized event types appended to the conversation log.
const (
	StreamEventRunStarted  = "run_started"
	StreamEventRunFinished = "run_finished"
	StreamEventRunQueued   = "run_queued"
	StreamEventSnapshot    = "snapshot"
	// StreamEventRebased signals an edit-resend truncation: subscribers drop
	// the edited user message and everything after it before the new
	// user_message arrives. Seeded by the gateway for webui edit_resend
	// commands and synthesized on ingress for GUI-local edits.
	StreamEventRebased = "rebased"
)

// RunActivity describes the current run of a conversation. A nil activity
// means the conversation is idle.
type RunActivity struct {
	ConversationID         string
	RunID                  string
	ClientRequestID        string
	State                  string
	ToolStatus             string
	ToolStatusIsCompaction bool
	StartedSeq             int64
	Workdir                string
	UpdatedAt              time.Time
}

// RunSnapshot is the latest runtime snapshot for a conversation's run. It is
// not part of the seq log; it hydrates late joiners when the buffer cannot
// cover the active run from its start.
type RunSnapshot struct {
	RunID                  string
	Revision               int64
	EntriesJSON            string
	ToolStatus             string
	ToolStatusIsCompaction bool
	Workdir                string
	// AsOfSeq is the conversation's last log seq when this snapshot was
	// ingested: the snapshot already represents every event up to and
	// including it, so clients rebuilding from the snapshot must only apply
	// replayed events with a higher seq.
	AsOfSeq   int64
	UpdatedAt time.Time
}

// ConversationEvent is one entry of a conversation log. Payload is the final
// wire shape (including conversation_id/run_id/seq/type) and is frozen after
// append — subscribers must never mutate it.
type ConversationEvent struct {
	ConversationID string
	RunID          string
	Seq            int64
	Type           string
	Payload        map[string]any
	ReceivedAt     time.Time

	approxBytes int
}

// ConversationActivityEvent is the broadcast shape for the chat.activity hub.
type ConversationActivityEvent struct {
	ConversationID  string
	RunID           string
	ClientRequestID string
	Running         bool
	State           string
	Workdir         string
	UpdatedAt       time.Time
}

// ChatCommandUpdate notifies the connection that issued a chat command about
// dispatch progress and terminal outcomes.
type ChatCommandUpdate struct {
	RunID           string
	ClientRequestID string
	ConversationID  string
	Phase           string // dispatch phase or completed | failed | cancelled | unknown
	ErrorCode       string
	Message         string
	RunStarted      bool
}

type streamSubscriber struct {
	id         int
	ch         chan *ConversationEvent
	overflowed bool
	closed     bool
}

type conversationStream struct {
	conversationID    string
	streamEpoch       string
	workdir           string
	lastSeq           int64
	events            []*ConversationEvent
	eventsBytes       int
	evictedThroughSeq int64
	activity          *RunActivity
	finishedRuns      []string
	latestSnapshot    *RunSnapshot
	agentEpoch        uint64
	snapshotDirty     bool
	// runNeedsSnapshot marks an active run whose early events the buffer
	// cannot reproduce (gateway restarted mid-run, or the agent reconnected
	// mid-run and tokens were lost) — late joiners hydrate from the snapshot.
	runNeedsSnapshot bool
	subscribers      map[int]*streamSubscriber
	lastEventAt      time.Time
	updatedAt        time.Time
}

type chatRunRecord struct {
	conversationID  string
	clientRequestID string
	// userMessageSeeded marks runs whose user_message the gateway appended at
	// accept time; the agent's later USER_MESSAGE echo is swallowed so the
	// message appears exactly once.
	userMessageSeeded bool
	// firstSeededSeq is the seq of the run's first gateway-seeded event so a
	// run started via supersession still protects its seeded user_message
	// from retention eviction.
	firstSeededSeq int64
	// deferredSeeds holds seeded payloads of a command accepted while another
	// run was active: appended only when this run actually starts (or fails),
	// dropped when it parks in the desktop prompt queue — so a queue-bound
	// prompt never flashes a transcript bubble.
	deferredSeeds []map[string]any
	// queuedInGUI marks commands the desktop app parked in its prompt queue;
	// the startup watchdog must leave them alone.
	queuedInGUI bool
	// rebaseSeeded marks runs whose rebased event was already appended from
	// the agent's ref-bearing user_message, so a reconnect replay of the same
	// event cannot seed a second truncation.
	rebaseSeeded bool
	// presentedFiles mirrors durable PresentFile metadata collected while the
	// run is live. The SQLite store remains authoritative after a restart.
	presentedFiles []ChatCommandPresentedFile
}

// chatCommandDedupeRecord is the process-local idempotency key for WebUI chat
// submissions. It is created atomically with the canonical run and retained
// long enough to cover WebSocket reconnect/retry windows without keeping full
// transcript state alive.
type chatCommandDedupeRecord struct {
	clientRequestID     string
	runID               string
	conversationID      string
	acceptedSeq         int64
	createdAt           time.Time
	state               string
	dispatchPhase       string
	terminalStatus      string
	terminalErrorCode   string
	terminalMessage     string
	terminalPayloadJSON string
	presentedFiles      []ChatCommandPresentedFile
}

// ChatCommandPresentedFile is the bounded, validated-on-replay descriptor for
// one PresentFile tool result. PayloadJSON contains metadata only; file bytes
// are re-read from the Desktop with file-id/size/mtime fencing when replayed.
type ChatCommandPresentedFile struct {
	Seq         int64  `json:"seq"`
	Workdir     string `json:"workdir"`
	PayloadJSON string `json:"payload_json"`
}

// chatCommandUpdateRecord carries the latest pre-stream update for a run with
// its own timestamp: updates can be fired for runs that never had a dedupe
// record in this process (desktop replays after a gateway restart, parked
// runs older than the dedupe retention), so they are reaped independently
// instead of relying on a paired dedupe record.
type chatCommandUpdateRecord struct {
	update ChatCommandUpdate
	at     time.Time
}

type pendingChatCommandFinish struct {
	clientRequestID string
	runID           string
	status          string
	errorCode       string
	message         string
	payload         map[string]any
	createdAt       time.Time
}

type pendingChatCommandBind struct {
	clientRequestID string
	runID           string
	conversationID  string
	acceptedSeq     int64
	createdAt       time.Time
}

type pendingChatRun struct {
	runID           string
	clientRequestID string
	workdir         string
	seeded          []map[string]any
	createdAt       time.Time
}

type conversationStreamStore struct {
	mu sync.Mutex
	// recoveryMu serializes Desktop-ledger reconciliation with durable lease
	// expiry. Both paths release mu around SQLite, but only one may choose the
	// canonical terminal result for a recovering run.
	recoveryMu      sync.Mutex
	streams         map[string]*conversationStream
	pendingRuns     map[string]*pendingChatRun
	runs            map[string]*chatRunRecord
	commandDedup    map[string]*chatCommandDedupeRecord
	commandWatchers map[string][]chan ChatCommandUpdate
	commandUpdates  map[string]chatCommandUpdateRecord
	recoveringRuns  map[string]*chatCommandDedupeRecord
	finishingRuns   map[string]struct{}
	finishRetries   map[string]*pendingChatCommandFinish
	bindRetries     map[string]*pendingChatCommandBind
	nextSubID       int
	commandStore    chatCommandStore

	activityHub *chatActivityHub

	reaperOnce sync.Once
	isOnline   func() bool

	// tunable in tests
	eventRetention       time.Duration
	maxEvents            int
	maxEventBytes        int
	idleRetention        time.Duration
	staleRunTimeout      time.Duration
	offlineRunTimeout    time.Duration
	runReportLostTimeout time.Duration
	reaperInterval       time.Duration
}

func newConversationStreamStore(isOnline func() bool) *conversationStreamStore {
	return newConversationStreamStoreWithPersistence(isOnline, nil)
}

func newConversationStreamStoreWithPersistence(
	isOnline func() bool,
	commandStore chatCommandStore,
) *conversationStreamStore {
	s := &conversationStreamStore{
		streams:              make(map[string]*conversationStream),
		pendingRuns:          make(map[string]*pendingChatRun),
		runs:                 make(map[string]*chatRunRecord),
		commandDedup:         make(map[string]*chatCommandDedupeRecord),
		commandWatchers:      make(map[string][]chan ChatCommandUpdate),
		commandUpdates:       make(map[string]chatCommandUpdateRecord),
		recoveringRuns:       make(map[string]*chatCommandDedupeRecord),
		finishingRuns:        make(map[string]struct{}),
		finishRetries:        make(map[string]*pendingChatCommandFinish),
		bindRetries:          make(map[string]*pendingChatCommandBind),
		commandStore:         commandStore,
		activityHub:          newChatActivityHub(),
		isOnline:             isOnline,
		eventRetention:       conversationEventRetention,
		maxEvents:            conversationMaxEvents,
		maxEventBytes:        conversationMaxEventBytes,
		idleRetention:        conversationIdleRetention,
		staleRunTimeout:      conversationStaleRunTimeout,
		offlineRunTimeout:    conversationOfflineRunTimeout,
		runReportLostTimeout: conversationRunReportLostTimeout,
		reaperInterval:       conversationReaperInterval,
	}
	if commandStore != nil {
		records, err := commandStore.Recoverable(time.Now())
		if err != nil {
			logChatCommandStoreError("load_recoverable", "", err)
		} else {
			for _, record := range records {
				if record == nil || record.runID == "" || record.clientRequestID == "" {
					continue
				}
				s.commandDedup[record.clientRequestID] = record
				s.recoveringRuns[record.runID] = record
			}
			if len(s.recoveringRuns) > 0 {
				s.startReaper()
				s.scheduleRecoveryExpiry()
			}
		}
	}
	return s
}

func logChatCommandStoreError(operation string, runID string, err error) {
	if err == nil {
		return
	}
	slog.Error("chat_command_persistence_failed",
		"operation", strings.TrimSpace(operation),
		"run_id", strings.TrimSpace(runID),
		"error", err,
	)
}

func (s *conversationStreamStore) streamLocked(conversationID string, now time.Time) *conversationStream {
	stream := s.streams[conversationID]
	if stream == nil {
		stream = &conversationStream{
			conversationID: conversationID,
			streamEpoch:    uuid.NewString(),
			subscribers:    make(map[int]*streamSubscriber),
			updatedAt:      now,
		}
		s.streams[conversationID] = stream
		s.startReaper()
	}
	return stream
}

func (s *conversationStreamStore) evictStreamLocked(stream *conversationStream, now time.Time) {
	cutoff := now.Add(-s.eventRetention)
	activeStart := int64(0)
	if stream.activity != nil {
		activeStart = stream.activity.StartedSeq
	}
	drop := 0
	for drop < len(stream.events) {
		event := stream.events[drop]
		overCap := len(stream.events)-drop > s.maxEvents ||
			stream.eventsBytes > s.maxEventBytes
		expired := event.ReceivedAt.Before(cutoff)
		if !overCap && !expired {
			break
		}
		if !overCap && activeStart > 0 && event.Seq >= activeStart {
			// Retention never evicts events of the active run; only hard caps do.
			break
		}
		stream.eventsBytes -= event.approxBytes
		if event.Seq > stream.evictedThroughSeq {
			stream.evictedThroughSeq = event.Seq
		}
		drop++
	}
	if drop > 0 {
		remaining := len(stream.events) - drop
		copy(stream.events, stream.events[drop:])
		for i := remaining; i < len(stream.events); i++ {
			stream.events[i] = nil
		}
		stream.events = stream.events[:remaining]
	}
}

// ConversationSubscription is the result of subscribing to a conversation
// stream. The subscription persists across runs; EventCh closes only on
// Cleanup or when the subscriber overflows (check Overflowed, then
// re-subscribe with after_seq to resume without loss).
type ConversationSubscription struct {
	ConversationID string
	StreamEpoch    string
	LatestSeq      int64
	Reset          bool
	Activity       *RunActivity
	Snapshot       *RunSnapshot
	Events         []*ConversationEvent
	EventCh        <-chan *ConversationEvent
	Cleanup        func()
	Overflowed     func() bool
}

func (m *Manager) SubscribeConversationStream(
	conversationID string,
	afterSeq int64,
	clientEpoch string,
) *ConversationSubscription {
	s := m.convStreams
	conversationID = strings.TrimSpace(conversationID)
	clientEpoch = strings.TrimSpace(clientEpoch)
	if afterSeq < 0 {
		afterSeq = 0
	}
	now := time.Now()

	s.mu.Lock()
	defer s.mu.Unlock()
	stream := s.streamLocked(conversationID, now)
	s.evictStreamLocked(stream, now)

	reset := clientEpoch != "" && clientEpoch != stream.streamEpoch
	if afterSeq > stream.lastSeq {
		reset = true
	}
	if afterSeq > 0 && afterSeq < stream.evictedThroughSeq {
		reset = true
	}
	if reset {
		afterSeq = 0
	}

	replay := make([]*ConversationEvent, 0, len(stream.events))
	for _, event := range stream.events {
		if event.Seq > afterSeq {
			replay = append(replay, event)
		}
	}

	var snapshot *RunSnapshot
	if stream.activity != nil &&
		stream.latestSnapshot != nil &&
		stream.latestSnapshot.RunID == stream.activity.RunID &&
		afterSeq < stream.activity.StartedSeq &&
		(stream.evictedThroughSeq >= stream.activity.StartedSeq || stream.runNeedsSnapshot) {
		// The buffer cannot reproduce the active run from its start; hand the
		// client the runtime snapshot to rebuild the live tail.
		snapshotCopy := *stream.latestSnapshot
		snapshot = &snapshotCopy
	}

	var activity *RunActivity
	if stream.activity != nil {
		activityCopy := *stream.activity
		activity = &activityCopy
	}

	s.nextSubID++
	sub := &streamSubscriber{
		id: s.nextSubID,
		ch: make(chan *ConversationEvent, conversationSubscriberBuffer),
	}
	stream.subscribers[sub.id] = sub

	cleanup := func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		current := s.streams[conversationID]
		if current == nil {
			return
		}
		if existing, ok := current.subscribers[sub.id]; ok && existing == sub {
			delete(current.subscribers, sub.id)
			if !sub.closed {
				sub.closed = true
				close(sub.ch)
			}
		}
	}
	overflowed := func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return sub.overflowed
	}

	return &ConversationSubscription{
		ConversationID: conversationID,
		StreamEpoch:    stream.streamEpoch,
		LatestSeq:      stream.lastSeq,
		Reset:          reset,
		Activity:       activity,
		Snapshot:       snapshot,
		Events:         replay,
		EventCh:        sub.ch,
		Cleanup:        cleanup,
		Overflowed:     overflowed,
	}
}

// ActiveConversationActivities returns the current activity of every
// conversation with an active run (for history.list hydration).
func (m *Manager) ActiveConversationActivities() []RunActivity {
	s := m.convStreams
	s.mu.Lock()
	defer s.mu.Unlock()
	activities := make([]RunActivity, 0, len(s.streams))
	for _, stream := range s.streams {
		if stream.activity != nil {
			activities = append(activities, *stream.activity)
		}
	}
	return activities
}

// ConversationRunWorkdir returns the desktop-reported workspace for the
// currently active run. Channel commands intentionally arrive without a
// connector-selected workdir, so their authoritative cwd is learned from the
// runtime snapshot published by the desktop after the run starts.
func (m *Manager) ConversationRunWorkdir(conversationID string, runID string) (string, bool) {
	s := m.convStreams
	conversationID = strings.TrimSpace(conversationID)
	runID = strings.TrimSpace(runID)
	if conversationID == "" || runID == "" {
		return "", false
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	stream := s.streams[conversationID]
	workdir := conversationRunWorkdirLocked(stream, runID)
	if workdir == "" {
		return "", false
	}
	return workdir, true
}

func conversationRunWorkdirLocked(stream *conversationStream, runID string) string {
	if stream == nil || stream.activity == nil || stream.activity.RunID != runID {
		return ""
	}
	// A runtime snapshot belongs to this exact run and is authoritative. The
	// conversation and queued activity workdirs may still contain the previous
	// run's sticky workspace when a channel command starts with an empty cwd.
	if snapshot := stream.latestSnapshot; snapshot != nil && snapshot.RunID == runID {
		if workdir := strings.TrimSpace(snapshot.Workdir); workdir != "" {
			return workdir
		}
	}
	if workdir := strings.TrimSpace(stream.activity.Workdir); workdir != "" {
		return workdir
	}
	if workdir := strings.TrimSpace(stream.workdir); workdir != "" {
		return workdir
	}
	return ""
}

// appendEventLocked assigns the next seq, freezes the payload, stores the
// event, and fans it out to subscribers.
func (s *conversationStreamStore) appendEventLocked(
	stream *conversationStream,
	runID string,
	eventType string,
	payload map[string]any,
	now time.Time,
) *ConversationEvent {
	if payload == nil {
		payload = make(map[string]any, 4)
	}
	stream.lastSeq++
	payload["conversation_id"] = stream.conversationID
	payload["run_id"] = runID
	payload["seq"] = stream.lastSeq
	payload["type"] = eventType
	event := &ConversationEvent{
		ConversationID: stream.conversationID,
		RunID:          runID,
		Seq:            stream.lastSeq,
		Type:           eventType,
		Payload:        payload,
		ReceivedAt:     now,
		approxBytes:    approxPayloadBytes(payload),
	}
	stream.events = append(stream.events, event)
	stream.eventsBytes += event.approxBytes
	stream.lastEventAt = now
	stream.updatedAt = now
	s.evictStreamLocked(stream, now)
	s.publishLocked(stream, event)
	return event
}

// publishLocked delivers an event to every subscriber without blocking. A
// subscriber whose buffer is full is closed; the client resumes via
// re-subscribe with after_seq (the ring still holds the events).
func (s *conversationStreamStore) publishLocked(stream *conversationStream, event *ConversationEvent) {
	for id, sub := range stream.subscribers {
		if sub.closed {
			continue
		}
		select {
		case sub.ch <- event:
		default:
			sub.overflowed = true
			sub.closed = true
			close(sub.ch)
			delete(stream.subscribers, id)
		}
	}
}

func approxPayloadBytes(payload map[string]any) int {
	total := 64
	for key, value := range payload {
		total += len(key) + approxValueBytes(value, 2)
	}
	return total
}

func approxValueBytes(value any, depth int) int {
	switch v := value.(type) {
	case string:
		return len(v) + 8
	case map[string]any:
		if depth <= 0 {
			return 64
		}
		total := 16
		for key, nested := range v {
			total += len(key) + approxValueBytes(nested, depth-1)
		}
		return total
	case []any:
		if depth <= 0 {
			return 64
		}
		total := 16
		for _, nested := range v {
			total += approxValueBytes(nested, depth-1)
		}
		return total
	default:
		return 16
	}
}

func (stream *conversationStream) runFinishedRecently(runID string) bool {
	for _, finished := range stream.finishedRuns {
		if finished == runID {
			return true
		}
	}
	return false
}

// runStartedLocked registers runID as the conversation's current run,
// superseding a still-active previous run. Idempotent per run.
func (s *conversationStreamStore) runStartedLocked(
	stream *conversationStream,
	runID string,
	workdir string,
	now time.Time,
) {
	s.runStartedWithPersistenceLocked(stream, runID, workdir, now, true)
}

func (s *conversationStreamStore) runStartedWithPersistenceLocked(
	stream *conversationStream,
	runID string,
	workdir string,
	now time.Time,
	persist bool,
) {
	if runID == "" || stream.runFinishedRecently(runID) {
		return
	}
	if stream.activity != nil && stream.activity.RunID == runID {
		switch stream.activity.State {
		case RunActivityQueued:
			// The gateway-accepted command actually started: append the
			// run_started log event now. StartedSeq keeps covering the seeded
			// user_message so the whole run stays replayable.
			s.flushDeferredSeedsLocked(stream, runID, s.runRecordLocked(runID, stream.conversationID), now)
			payload := map[string]any{}
			if stream.activity.ClientRequestID != "" {
				payload["client_request_id"] = stream.activity.ClientRequestID
			}
			if stream.workdir != "" {
				payload["workdir"] = stream.workdir
			}
			s.appendEventLocked(stream, runID, StreamEventRunStarted, payload, now)
			stream.activity.State = RunActivityRunning
			stream.activity.UpdatedAt = now
			clientRequestID := stream.activity.ClientRequestID
			s.publishActivityLocked(stream, now)
			if persist && s.commandStore != nil && clientRequestID != "" {
				if err := s.markChatCommandLocked(
					clientRequestID, runID, "running", "started", now,
				); err != nil {
					logChatCommandStoreError("mark_started", runID, err)
				}
			}
		case RunActivityCancelling:
			// A cancel is in flight; keep the cancelling state.
		}
		return
	}
	if stream.activity != nil &&
		(stream.activity.State == RunActivityRunning || stream.activity.State == RunActivityCancelling) {
		// Supersession: the agent started a new run (e.g. a queued prompt
		// auto-send) before the previous run's terminal signal arrived.
		s.runFinishedLocked(stream, stream.activity.RunID, "completed", "", "", map[string]any{
			"reason": "superseded",
		}, now)
		// Finish releases mu for its durable write after clearing the old
		// activity. A newer start may win during that window; do not append a
		// duplicate or supersede that newer observation when we resume.
		if stream.runFinishedRecently(runID) || stream.activity != nil {
			return
		}
	}
	if workdir = strings.TrimSpace(workdir); workdir != "" {
		stream.workdir = workdir
	}
	record := s.runRecordLocked(runID, stream.conversationID)
	s.flushDeferredSeedsLocked(stream, runID, record, now)
	payload := map[string]any{}
	if record.clientRequestID != "" {
		payload["client_request_id"] = record.clientRequestID
	}
	if stream.workdir != "" {
		payload["workdir"] = stream.workdir
	}
	startEvent := s.appendEventLocked(stream, runID, StreamEventRunStarted, payload, now)
	startedSeq := startEvent.Seq
	if record.firstSeededSeq > 0 && record.firstSeededSeq < startedSeq {
		// The run's user_message was seeded before it started (e.g. it
		// started through supersession while another run was active); the
		// eviction guard must cover the seed too.
		startedSeq = record.firstSeededSeq
	}
	stream.activity = &RunActivity{
		ConversationID:  stream.conversationID,
		RunID:           runID,
		ClientRequestID: record.clientRequestID,
		State:           RunActivityRunning,
		StartedSeq:      startedSeq,
		Workdir:         stream.workdir,
		UpdatedAt:       now,
	}
	s.publishActivityLocked(stream, now)
	if persist && s.commandStore != nil && record.clientRequestID != "" {
		if err := s.markChatCommandLocked(record.clientRequestID, runID, "running", "started", now); err != nil {
			logChatCommandStoreError("mark_started", runID, err)
		}
	}
}

// runFinishedLocked appends run_finished exactly once per run and clears the
// activity when the finished run is the current one.
func (s *conversationStreamStore) runFinishedLocked(
	stream *conversationStream,
	runID string,
	status string,
	errorCode string,
	message string,
	extra map[string]any,
	now time.Time,
) {
	s.runFinishedWithPersistenceLocked(
		stream, runID, status, errorCode, message, extra, now, true,
	)
}

func (s *conversationStreamStore) runFinishedWithPersistenceLocked(
	stream *conversationStream,
	runID string,
	status string,
	errorCode string,
	message string,
	extra map[string]any,
	now time.Time,
	persist bool,
) {
	if runID == "" || stream.runFinishedRecently(runID) {
		return
	}
	if _, finishing := s.finishingRuns[runID]; finishing {
		return
	}
	s.finishingRuns[runID] = struct{}{}
	defer delete(s.finishingRuns, runID)
	runStarted := stream.activity != nil && stream.activity.RunID == runID &&
		stream.activity.State != RunActivityQueued
	if stream.activity == nil || stream.activity.RunID != runID {
		// Terminal signal for a run this stream never started (e.g. the
		// gateway restarted mid-run). Synthesize the start so clients see a
		// coherent pair, unless another run is currently active — then the
		// stray terminal is recorded without touching the active run.
		if stream.activity == nil {
			// This synthetic start is immediately followed by the terminal event;
			// persisting an intermediate running phase would only add an unlock
			// window in which the pair could be reordered.
			s.runStartedWithPersistenceLocked(stream, runID, "", now, false)
		}
	}
	payload := map[string]any{
		"status":      status,
		"run_started": runStarted,
	}
	if errorCode != "" {
		payload["error_code"] = errorCode
	}
	if message != "" {
		payload["message"] = message
	}
	for key, value := range extra {
		if key == "run_started" {
			payload[key] = value
		} else if _, exists := payload[key]; !exists {
			payload[key] = value
		}
	}
	if persistedRunStarted, ok := payload["run_started"].(bool); ok {
		runStarted = persistedRunStarted
	}
	clientRequestID := ""
	if record := s.runs[runID]; record != nil {
		clientRequestID = record.clientRequestID
		if clientRequestID != "" {
			payload["client_request_id"] = clientRequestID
		}
	}
	s.appendEventLocked(stream, runID, StreamEventRunFinished, payload, now)
	if clientRequestID != "" {
		phase := strings.ToLower(strings.TrimSpace(status))
		switch phase {
		case "completed", "failed", "cancelled", "unknown":
		default:
			phase = "unknown"
		}
		terminalMessage := message
		if phase == "completed" {
			if finalText, ok := payload["final_text"].(string); ok && strings.TrimSpace(finalText) != "" {
				terminalMessage = finalText
			}
		}
		s.cacheChatCommandTerminalLocked(
			clientRequestID, runID, stream.conversationID,
			status, errorCode, message, payload, now,
		)
		s.publishCommandUpdateLocked(ChatCommandUpdate{
			RunID:           runID,
			ClientRequestID: clientRequestID,
			ConversationID:  stream.conversationID,
			Phase:           phase,
			ErrorCode:       errorCode,
			Message:         terminalMessage,
			RunStarted:      runStarted,
		}, now)
	}
	stream.finishedRuns = append(stream.finishedRuns, runID)
	if len(stream.finishedRuns) > conversationFinishedRunMemory {
		evicted := stream.finishedRuns[0]
		stream.finishedRuns = stream.finishedRuns[1:]
		delete(s.runs, evicted)
	}
	if stream.latestSnapshot != nil && stream.latestSnapshot.RunID == runID {
		stream.latestSnapshot = nil
	}
	if stream.activity != nil && stream.activity.RunID == runID {
		stream.activity = nil
		stream.runNeedsSnapshot = false
		stream.snapshotDirty = false
		s.publishActivityLocked(stream, now)
	}
	// All in-memory state is terminal before SQLite is entered. Callers that
	// arrive while Finish blocks therefore observe a coherent stream, and a
	// late Mark cannot publish a pre-terminal command update afterward.
	if persist && clientRequestID != "" {
		s.persistChatCommandFinishLocked(
			clientRequestID, runID, status, errorCode, message, payload, now,
		)
	}
}

// markRunQueuedLocked records that a run's command is pending in the gateway
// (accepted but not yet started). No log event — activity only.
func (s *conversationStreamStore) markRunQueuedLocked(
	stream *conversationStream,
	runID string,
	clientRequestID string,
	now time.Time,
) {
	if runID == "" || stream.runFinishedRecently(runID) {
		return
	}
	if stream.activity != nil {
		return
	}
	stream.activity = &RunActivity{
		ConversationID:  stream.conversationID,
		RunID:           runID,
		ClientRequestID: clientRequestID,
		State:           RunActivityQueued,
		StartedSeq:      stream.lastSeq + 1,
		Workdir:         stream.workdir,
		UpdatedAt:       now,
	}
	s.publishActivityLocked(stream, now)
}

func (s *conversationStreamStore) runRecordLocked(runID string, conversationID string) *chatRunRecord {
	record := s.runs[runID]
	if record == nil {
		record = &chatRunRecord{conversationID: conversationID}
		s.runs[runID] = record
	} else if record.conversationID == "" {
		record.conversationID = conversationID
	}
	return record
}

func (s *conversationStreamStore) publishActivityLocked(stream *conversationStream, now time.Time) {
	event := ConversationActivityEvent{
		ConversationID: stream.conversationID,
		Workdir:        stream.workdir,
		UpdatedAt:      now,
	}
	if stream.activity != nil {
		event.RunID = stream.activity.RunID
		event.ClientRequestID = stream.activity.ClientRequestID
		event.Running = true
		event.State = stream.activity.State
		if stream.activity.Workdir != "" {
			event.Workdir = stream.activity.Workdir
		}
	}
	s.activityHub.publish(event)
}

// --- command lifecycle -----------------------------------------------------

// WatchChatCommand registers a watcher for pre-stream command outcomes
// (bound / queued_in_gui / failed). The latest update is replayed immediately
// so a reconnecting deduplicated submit cannot miss an earlier transition.
func (m *Manager) WatchChatCommand(runID string) (<-chan ChatCommandUpdate, func()) {
	s := m.convStreams
	runID = strings.TrimSpace(runID)
	ch := make(chan ChatCommandUpdate, 4)

	s.mu.Lock()
	s.commandWatchers[runID] = append(s.commandWatchers[runID], ch)
	if record, ok := s.commandUpdates[runID]; ok {
		ch <- record.update
	}
	s.mu.Unlock()

	cleanup := func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		watchers := s.commandWatchers[runID]
		for i, watcher := range watchers {
			if watcher == ch {
				s.commandWatchers[runID] = append(watchers[:i], watchers[i+1:]...)
				// All sends happen under s.mu after a registration check, so
				// closing here is safe and releases the forwarder goroutine.
				close(ch)
				break
			}
		}
		if len(s.commandWatchers[runID]) == 0 {
			delete(s.commandWatchers, runID)
		}
	}
	return ch, cleanup
}

func (s *conversationStreamStore) fireCommandUpdateLocked(update ChatCommandUpdate) {
	if strings.TrimSpace(update.RunID) == "" {
		return
	}
	now := time.Now()
	clientRequestID := strings.TrimSpace(update.ClientRequestID)
	if update.Phase == "failed" {
		payload := map[string]any{
			"status":      "failed",
			"run_started": update.RunStarted,
		}
		if update.ErrorCode != "" {
			payload["error_code"] = update.ErrorCode
		}
		if update.Message != "" {
			payload["message"] = update.Message
		}
		if clientRequestID != "" {
			payload["client_request_id"] = clientRequestID
			s.cacheChatCommandTerminalLocked(
				clientRequestID, update.RunID, update.ConversationID,
				"failed", update.ErrorCode, update.Message, payload, now,
			)
		}
		s.publishCommandUpdateLocked(update, now)
		if s.commandStore != nil && clientRequestID != "" {
			s.persistChatCommandFinishLocked(
				clientRequestID, update.RunID, "failed", update.ErrorCode, update.Message, payload, now,
			)
		}
		return
	}
	// Publish while the state observed by the caller is still current. If a
	// terminal transition races the SQLite Mark below, it will overwrite this
	// update; the late Mark result is never allowed to publish afterward.
	if !s.publishCommandUpdateLocked(update, now) {
		return
	}
	if s.commandStore != nil && clientRequestID != "" {
		state := "dispatching"
		if update.Phase == "queued_in_gui" {
			state = "queued"
		}
		if err := s.markChatCommandLocked(
			clientRequestID, update.RunID, state, update.Phase, now,
		); err != nil && !s.chatCommandTerminalLocked(clientRequestID, update.RunID) {
			logChatCommandStoreError("mark_"+update.Phase, update.RunID, err)
		}
	}
}

// markChatCommandLocked performs potentially blocking SQLite work without the
// conversation-store mutex. Callers enter and leave with s.mu held.
func (s *conversationStreamStore) markChatCommandLocked(
	clientRequestID, runID, state, phase string,
	now time.Time,
) error {
	store := s.commandStore
	if store == nil {
		return nil
	}
	s.mu.Unlock()
	err := store.Mark(clientRequestID, runID, state, phase, now)
	s.mu.Lock()
	return err
}

func (s *conversationStreamStore) persistChatCommandFinishLocked(
	clientRequestID string,
	runID string,
	status string,
	errorCode string,
	message string,
	payload map[string]any,
	now time.Time,
) {
	if s.commandStore == nil || strings.TrimSpace(runID) == "" {
		return
	}
	store := s.commandStore
	retryBefore := s.finishRetries[runID]
	s.mu.Unlock()
	err := store.Finish(
		clientRequestID, runID, status, errorCode, message, payload, now,
	)
	s.mu.Lock()
	if err != nil {
		logChatCommandStoreError("finish", runID, err)
		clonedPayload := make(map[string]any, len(payload))
		for key, value := range payload {
			clonedPayload[key] = value
		}
		if current := s.finishRetries[runID]; current != retryBefore && current != nil {
			return
		}
		s.finishRetries[runID] = &pendingChatCommandFinish{
			clientRequestID: clientRequestID,
			runID:           runID,
			status:          status,
			errorCode:       errorCode,
			message:         message,
			payload:         clonedPayload,
			createdAt:       now,
		}
		return
	}
	if s.finishRetries[runID] == retryBefore {
		delete(s.finishRetries, runID)
	}
}

// publishCommandUpdateLocked updates the in-memory replay/watch surface only.
// Once a terminal update is present, later dispatch updates are ignored.
func (s *conversationStreamStore) publishCommandUpdateLocked(
	update ChatCommandUpdate,
	now time.Time,
) bool {
	if strings.TrimSpace(update.RunID) == "" {
		return false
	}
	terminal := isTerminalChatCommandPhase(update.Phase)
	if existing, ok := s.commandUpdates[update.RunID]; ok &&
		isTerminalChatCommandPhase(existing.update.Phase) {
		return false
	}
	if !terminal && s.chatCommandTerminalLocked(update.ClientRequestID, update.RunID) {
		return false
	}
	s.commandUpdates[update.RunID] = chatCommandUpdateRecord{update: update, at: now}
	for _, watcher := range s.commandWatchers[update.RunID] {
		select {
		case watcher <- update:
		default:
		}
	}
	return true
}

func isTerminalChatCommandPhase(phase string) bool {
	switch strings.ToLower(strings.TrimSpace(phase)) {
	case "completed", "failed", "cancelled", "unknown":
		return true
	default:
		return false
	}
}

func (s *conversationStreamStore) chatCommandTerminalLocked(clientRequestID, runID string) bool {
	clientRequestID = strings.TrimSpace(clientRequestID)
	runID = strings.TrimSpace(runID)
	if clientRequestID != "" {
		if record := s.commandDedup[clientRequestID]; record != nil &&
			record.runID == runID && record.state == "terminal" {
			return true
		}
	}
	if update, ok := s.commandUpdates[runID]; ok {
		return isTerminalChatCommandPhase(update.update.Phase)
	}
	return false
}

func (s *conversationStreamStore) cacheChatCommandTerminalLocked(
	clientRequestID string,
	runID string,
	conversationID string,
	status string,
	errorCode string,
	message string,
	payload map[string]any,
	now time.Time,
) {
	clientRequestID = strings.TrimSpace(clientRequestID)
	runID = strings.TrimSpace(runID)
	if clientRequestID == "" || runID == "" {
		return
	}
	record := s.commandDedup[clientRequestID]
	if record != nil && record.runID != runID {
		return
	}
	if record == nil {
		record = &chatCommandDedupeRecord{
			clientRequestID: clientRequestID,
			runID:           runID,
			createdAt:       now,
			state:           "accepted",
			dispatchPhase:   "accepted",
		}
		s.commandDedup[clientRequestID] = record
	}
	if record.state == "terminal" {
		return
	}
	if conversationID = strings.TrimSpace(conversationID); conversationID != "" {
		record.conversationID = conversationID
	}
	record.state = "terminal"
	record.dispatchPhase = "finished"
	record.terminalStatus = strings.ToLower(strings.TrimSpace(status))
	record.terminalErrorCode = strings.TrimSpace(errorCode)
	record.terminalMessage = message
	if encoded, err := json.Marshal(payload); err == nil {
		record.terminalPayloadJSON = string(encoded)
	}
	if runRecord := s.runs[runID]; runRecord != nil {
		record.presentedFiles = append(
			[]ChatCommandPresentedFile(nil), runRecord.presentedFiles...,
		)
	}
}

// ChatCommandStart is the accepted-command result returned to the transport.
type ChatCommandStart struct {
	RunID            string
	ConversationID   string
	AcceptedSeq      int64
	Deduped          bool
	Terminal         *ChatCommandTerminal
	Recovering       bool
	PersistenceError string
}

// ChatCommandTerminal is the durable terminal result available when a
// connector retries after the Gateway has restarted and the event buffer is
// no longer present.
type ChatCommandTerminal struct {
	Status         string
	ErrorCode      string
	Message        string
	PayloadJSON    string
	PresentedFiles []ChatCommandPresentedFile
}

// LookupChatCommand returns the canonical run already assigned to a
// client_request_id. Callers may use this as a fast path; StartChatCommand's
// durable Claim remains the authoritative atomic check for concurrent submits.
func (m *Manager) LookupChatCommand(clientRequestID string) (ChatCommandStart, bool) {
	s := m.convStreams
	clientRequestID = strings.TrimSpace(clientRequestID)
	if clientRequestID == "" {
		return ChatCommandStart{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	start, ok, _ := s.lookupChatCommandLocked(clientRequestID)
	return start, ok
}

func (s *conversationStreamStore) lookupChatCommandLocked(
	clientRequestID string,
) (ChatCommandStart, bool, error) {
	var record *chatCommandDedupeRecord
	if s.commandStore != nil {
		store := s.commandStore
		cachedBefore := s.commandDedup[clientRequestID]
		s.mu.Unlock()
		persisted, err := store.Lookup(clientRequestID, time.Now())
		s.mu.Lock()
		if err != nil {
			return ChatCommandStart{}, false, err
		}
		if persisted == nil {
			// A Claim may have completed while Lookup was outside mu. Only
			// remove the cache entry we actually observed before the query.
			if s.commandDedup[clientRequestID] == cachedBefore {
				delete(s.commandDedup, clientRequestID)
			}
			record = s.commandDedup[clientRequestID]
		} else {
			record = s.mergeChatCommandRecordLocked(clientRequestID, persisted)
		}
	} else {
		record = s.commandDedup[clientRequestID]
	}
	if record == nil || strings.TrimSpace(record.runID) == "" {
		return ChatCommandStart{}, false, nil
	}
	return chatCommandStartFromRecord(record, true), true, nil
}

func chatCommandStartFromRecord(record *chatCommandDedupeRecord, deduped bool) ChatCommandStart {
	if record == nil {
		return ChatCommandStart{Deduped: deduped}
	}
	start := ChatCommandStart{
		RunID:          record.runID,
		ConversationID: record.conversationID,
		AcceptedSeq:    record.acceptedSeq,
		Deduped:        deduped,
		Recovering:     record.state == "recovering",
	}
	if record.state == "terminal" {
		start.Terminal = &ChatCommandTerminal{
			Status:         record.terminalStatus,
			ErrorCode:      record.terminalErrorCode,
			Message:        record.terminalMessage,
			PayloadJSON:    record.terminalPayloadJSON,
			PresentedFiles: append([]ChatCommandPresentedFile(nil), record.presentedFiles...),
		}
	}
	return start
}

func cloneChatCommandRecord(record *chatCommandDedupeRecord) *chatCommandDedupeRecord {
	if record == nil {
		return nil
	}
	cloned := *record
	cloned.presentedFiles = append([]ChatCommandPresentedFile(nil), record.presentedFiles...)
	return &cloned
}

func (s *conversationStreamStore) mergeChatCommandRecordLocked(
	clientRequestID string,
	persisted *chatCommandDedupeRecord,
) *chatCommandDedupeRecord {
	if persisted == nil {
		return s.commandDedup[clientRequestID]
	}
	merged := cloneChatCommandRecord(persisted)
	merged.clientRequestID = strings.TrimSpace(clientRequestID)
	current := s.commandDedup[clientRequestID]
	if current != nil && current.runID == merged.runID {
		if merged.conversationID == "" {
			merged.conversationID = current.conversationID
		}
		if merged.acceptedSeq < current.acceptedSeq {
			merged.acceptedSeq = current.acceptedSeq
		}
		if len(merged.presentedFiles) == 0 && len(current.presentedFiles) > 0 {
			merged.presentedFiles = append(
				[]ChatCommandPresentedFile(nil), current.presentedFiles...,
			)
		}
		// A Lookup that started before the local terminal transition may
		// return an older durable phase. Keep the monotonic in-memory result;
		// a durable terminal response remains authoritative when present.
		if current.state == "terminal" && merged.state != "terminal" {
			merged.state = current.state
			merged.dispatchPhase = current.dispatchPhase
			merged.terminalStatus = current.terminalStatus
			merged.terminalErrorCode = current.terminalErrorCode
			merged.terminalMessage = current.terminalMessage
			merged.terminalPayloadJSON = current.terminalPayloadJSON
		}
	}
	s.commandDedup[clientRequestID] = merged
	return merged
}

func (s *conversationStreamStore) updateChatCommandDedupeLocked(
	clientRequestID string,
	runID string,
	conversationID string,
	acceptedSeq int64,
	now time.Time,
) error {
	clientRequestID = strings.TrimSpace(clientRequestID)
	if clientRequestID == "" || strings.TrimSpace(runID) == "" {
		return nil
	}
	runID = strings.TrimSpace(runID)
	record := s.commandDedup[clientRequestID]
	if record != nil && record.runID != runID {
		return errors.New("chat command cache disagrees with the canonical run")
	}
	if record == nil {
		record = &chatCommandDedupeRecord{
			clientRequestID: clientRequestID,
			runID:           runID,
			createdAt:       now,
			state:           "accepted",
			dispatchPhase:   "accepted",
		}
		s.commandDedup[clientRequestID] = record
	}
	if conversationID = strings.TrimSpace(conversationID); conversationID != "" {
		record.conversationID = conversationID
	}
	if acceptedSeq > record.acceptedSeq {
		record.acceptedSeq = acceptedSeq
	}
	if s.commandStore == nil {
		return nil
	}
	return s.persistChatCommandBindLocked(
		clientRequestID, runID, record.conversationID, record.acceptedSeq, now,
	)
}

func (s *conversationStreamStore) persistChatCommandBindLocked(
	clientRequestID string,
	runID string,
	conversationID string,
	acceptedSeq int64,
	now time.Time,
) error {
	if s.commandStore == nil {
		return nil
	}
	store := s.commandStore
	retryBefore := s.bindRetries[runID]
	s.mu.Unlock()
	err := store.Bind(clientRequestID, runID, conversationID, acceptedSeq, now)
	s.mu.Lock()
	if err == nil {
		if s.bindRetries[runID] == retryBefore {
			delete(s.bindRetries, runID)
		}
		return nil
	}
	logChatCommandStoreError("bind", runID, err)
	if current := s.bindRetries[runID]; current != retryBefore && current != nil {
		return err
	}
	s.bindRetries[runID] = &pendingChatCommandBind{
		clientRequestID: clientRequestID,
		runID:           runID,
		conversationID:  conversationID,
		acceptedSeq:     acceptedSeq,
		createdAt:       now,
	}
	return err
}

// StartChatCommand registers a webui-issued chat command. For a known
// conversation the seeded payloads (rebased/user_message) are appended to the
// log immediately; for a draft conversation they are buffered until the first
// agent signal binds the run to a real conversation id.
func (m *Manager) StartChatCommand(
	runID string,
	conversationID string,
	workdir string,
	clientRequestID string,
	seededPayloads []map[string]any,
) ChatCommandStart {
	s := m.convStreams
	runID = strings.TrimSpace(runID)
	conversationID = strings.TrimSpace(conversationID)
	workdir = strings.TrimSpace(workdir)
	clientRequestID = strings.TrimSpace(clientRequestID)
	now := time.Now()

	s.mu.Lock()
	defer s.mu.Unlock()
	initialAcceptedSeq := s.initialChatCommandClaimSeqLocked(conversationID)
	if s.commandStore != nil && clientRequestID != "" {
		store := s.commandStore
		s.mu.Unlock()
		persisted, deduped, err := store.Claim(
			clientRequestID, runID, conversationID, initialAcceptedSeq, now,
		)
		s.mu.Lock()
		if err != nil {
			return ChatCommandStart{RunID: runID, Deduped: true, PersistenceError: err.Error()}
		}
		if persisted == nil || strings.TrimSpace(persisted.runID) == "" {
			return ChatCommandStart{
				RunID:            runID,
				Deduped:          true,
				PersistenceError: "durable chat command claim returned no canonical run",
			}
		}
		persisted = s.mergeChatCommandRecordLocked(clientRequestID, persisted)
		if deduped || persisted.runID != runID {
			return chatCommandStartFromRecord(persisted, true)
		}
	} else {
		if existing := s.commandDedup[clientRequestID]; clientRequestID != "" && existing != nil && existing.runID != "" {
			return chatCommandStartFromRecord(existing, true)
		}
		if err := s.updateChatCommandDedupeLocked(
			clientRequestID, runID, conversationID, initialAcceptedSeq, now,
		); err != nil {
			return ChatCommandStart{RunID: runID, Deduped: true, PersistenceError: err.Error()}
		}
	}
	s.startReaper()

	if conversationID == "" {
		s.pendingRuns[runID] = &pendingChatRun{
			runID:           runID,
			clientRequestID: clientRequestID,
			workdir:         workdir,
			seeded:          seededPayloads,
			createdAt:       now,
		}
		return ChatCommandStart{RunID: runID}
	}

	stream := s.streamLocked(conversationID, now)
	if workdir != "" {
		stream.workdir = workdir
	}
	record := s.runRecordLocked(runID, conversationID)
	record.clientRequestID = clientRequestID

	if stream.activity != nil {
		// A run is already active: this command is almost certainly headed
		// for the desktop prompt queue. Seeding the user_message into the log
		// now would flash a bubble on every viewer until the queued_in_gui
		// compensation removes it — defer the seeds until the run actually
		// starts (or fails); if it parks in the GUI queue they are dropped
		// and the agent's own echo becomes authoritative.
		record.deferredSeeds = seededPayloads
		start := ChatCommandStart{
			RunID:          runID,
			ConversationID: conversationID,
			AcceptedSeq:    stream.lastSeq,
		}
		if err := s.updateChatCommandDedupeLocked(
			clientRequestID, runID, conversationID, start.AcceptedSeq, now,
		); err != nil {
			// Claim already established the durable canonical run. A later Bind
			// failure only delays richer conversation/sequence metadata and is
			// retried by the reaper; blocking dispatch here would strand the
			// canonical row because the next request is necessarily deduplicated.
			logChatCommandStoreError("bind_after_claim", runID, err)
		}
		return start
	}

	// Mark queued before seeding so the activity's StartedSeq covers the
	// seeded user_message — the whole run replays from one cursor.
	s.markRunQueuedLocked(stream, runID, clientRequestID, now)
	acceptedSeq := s.appendSeededPayloadsLocked(stream, runID, clientRequestID, seededPayloads, now)
	record.userMessageSeeded = seededPayloadsIncludeUserMessage(seededPayloads)
	start := ChatCommandStart{
		RunID:          runID,
		ConversationID: conversationID,
		AcceptedSeq:    acceptedSeq,
	}
	if err := s.updateChatCommandDedupeLocked(
		clientRequestID, runID, conversationID, acceptedSeq, now,
	); err != nil {
		// The durable Claim succeeded before local seeding. Keep dispatching and
		// let bindRetries reconcile the newer accepted sequence asynchronously.
		logChatCommandStoreError("bind_after_claim", runID, err)
	}
	if stream.activity != nil && stream.activity.RunID == runID &&
		stream.activity.State == RunActivityQueued &&
		!stream.runFinishedRecently(runID) && s.commandStore != nil && clientRequestID != "" {
		if err := s.markChatCommandLocked(
			clientRequestID, runID, "queued", "accepted", now,
		); err != nil && !s.chatCommandTerminalLocked(clientRequestID, runID) {
			logChatCommandStoreError("mark_queued", runID, err)
		}
	}
	return start
}

// flushDeferredSeedsLocked appends seeds that were deferred because another
// run was active at accept time. Called right before the run's run_started
// event so the log keeps the normal [user_message, run_started, ...] shape.
func (s *conversationStreamStore) flushDeferredSeedsLocked(
	stream *conversationStream,
	runID string,
	record *chatRunRecord,
	now time.Time,
) {
	if len(record.deferredSeeds) == 0 {
		return
	}
	seeds := record.deferredSeeds
	record.deferredSeeds = nil
	s.appendSeededPayloadsLocked(stream, runID, record.clientRequestID, seeds, now)
	record.userMessageSeeded = seededPayloadsIncludeUserMessage(seeds)
}

func (s *conversationStreamStore) appendSeededPayloadsLocked(
	stream *conversationStream,
	runID string,
	clientRequestID string,
	seededPayloads []map[string]any,
	now time.Time,
) int64 {
	acceptedSeq := stream.lastSeq
	for _, payload := range seededPayloads {
		if len(payload) == 0 {
			continue
		}
		eventType, _ := payload["type"].(string)
		if eventType == "" {
			continue
		}
		cloned := make(map[string]any, len(payload)+5)
		for key, value := range payload {
			cloned[key] = value
		}
		if eventType == "user_message" && clientRequestID != "" {
			cloned["client_request_id"] = clientRequestID
		}
		event := s.appendEventLocked(stream, runID, eventType, cloned, now)
		acceptedSeq = event.Seq
		if record := s.runs[runID]; record != nil && record.firstSeededSeq == 0 {
			record.firstSeededSeq = event.Seq
		}
	}
	return acceptedSeq
}

func seededPayloadsIncludeUserMessage(seededPayloads []map[string]any) bool {
	for _, payload := range seededPayloads {
		if eventType, _ := payload["type"].(string); eventType == "user_message" {
			return true
		}
	}
	return false
}

func (s *conversationStreamStore) initialChatCommandClaimSeqLocked(conversationID string) int64 {
	if conversationID == "" {
		return 0
	}
	stream := s.streams[conversationID]
	if stream == nil {
		return 0
	}
	// Claim runs without mu. Seeded events are deliberately excluded because
	// another run can become active before Claim returns, causing those seeds
	// to be deferred. The actual accepted seq is bound after the in-memory
	// transition; a conservative value can never make a retry skip an event.
	return stream.lastSeq
}

// FailChatCommand fails a command that never produced a bound run (agent
// unreachable, startup watchdog) or force-finishes its run when bound.
func (m *Manager) FailChatCommand(runID string, errorCode string, message string) {
	s := m.convStreams
	runID = strings.TrimSpace(runID)
	now := time.Now()

	s.mu.Lock()
	defer s.mu.Unlock()

	if pending := s.pendingRuns[runID]; pending != nil {
		delete(s.pendingRuns, runID)
		s.fireCommandUpdateLocked(ChatCommandUpdate{
			RunID:           runID,
			ClientRequestID: pending.clientRequestID,
			Phase:           "failed",
			ErrorCode:       errorCode,
			Message:         message,
		})
		return
	}

	record := s.runs[runID]
	if record == nil || record.conversationID == "" {
		return
	}
	stream := s.streams[record.conversationID]
	if stream == nil {
		return
	}
	// Seeds deferred at accept time surface now so the failure has its user
	// message for context; runFinishedLocked follows with the error.
	s.flushDeferredSeedsLocked(stream, runID, record, now)
	s.runFinishedLocked(stream, runID, "failed", errorCode, message, nil, now)
}

// ChatCommandSettled reports whether a command reached a state the startup
// watchdog must not interfere with: its run started, finished, or was parked
// in the desktop prompt queue.
func (m *Manager) ChatCommandSettled(runID string) bool {
	s := m.convStreams
	runID = strings.TrimSpace(runID)
	s.mu.Lock()
	defer s.mu.Unlock()
	record := s.runs[runID]
	if record == nil {
		return false
	}
	if record.queuedInGUI {
		return true
	}
	if record.conversationID == "" {
		return false
	}
	stream := s.streams[record.conversationID]
	if stream == nil {
		return false
	}
	if stream.runFinishedRecently(runID) {
		return true
	}
	return stream.activity != nil &&
		stream.activity.RunID == runID &&
		stream.activity.State != RunActivityQueued
}

// MarkConversationCancelling flips the active run into the cancelling state
// and returns its run id for the caller's watchdog. The agent's real terminal
// signal wins; ForceFinishRun is the fallback.
func (m *Manager) MarkConversationCancelling(conversationID string, runID string) (string, bool) {
	s := m.convStreams
	conversationID = strings.TrimSpace(conversationID)
	runID = strings.TrimSpace(runID)
	now := time.Now()

	s.mu.Lock()
	defer s.mu.Unlock()
	stream := s.streams[conversationID]
	if stream == nil || stream.activity == nil {
		return "", false
	}
	if runID != "" && stream.activity.RunID != runID {
		return "", false
	}
	stream.activity.State = RunActivityCancelling
	stream.activity.UpdatedAt = now
	s.publishActivityLocked(stream, now)
	return stream.activity.RunID, true
}

// ForceFinishRun finishes a run from a gateway-side watchdog. No-op when the
// run already finished (exactly-once guard).
func (m *Manager) ForceFinishRun(runID string, status string, errorCode string, message string) {
	s := m.convStreams
	runID = strings.TrimSpace(runID)
	now := time.Now()

	s.mu.Lock()
	defer s.mu.Unlock()
	record := s.runs[runID]
	if record == nil || record.conversationID == "" {
		return
	}
	stream := s.streams[record.conversationID]
	if stream == nil {
		return
	}
	s.runFinishedLocked(stream, runID, status, errorCode, message, nil, now)
}

// --- maintenance -----------------------------------------------------------

// onRuntimeStatus reconciles the desktop's run ledger with tracked
// activities: active reports vouch per run, finished reports adopt terminal
// signals the gateway missed, and a run absent from both is finalized once
// nothing has vouched for it within the grace window. Every vouch bumps
// activity.UpdatedAt, so its staleness measures continuous absence.
func (s *conversationStreamStore) onRuntimeStatus(event *gatewayv1.RuntimeStatusEvent, now time.Time) {
	s.recoveryMu.Lock()
	defer s.recoveryMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()

	activeSet := make(map[string]*gatewayv1.ChatRunReport, len(event.GetActiveRuns()))
	for _, report := range event.GetActiveRuns() {
		activeSet[report.GetRunId()] = report
	}
	finished := make(map[string]*gatewayv1.ChatRunReport, len(event.GetFinishedRuns()))
	for _, report := range event.GetFinishedRuns() {
		finished[report.GetRunId()] = report
	}
	s.reconcileRecoveringRunsLocked(activeSet, finished, now)

	// Reconcile only tracked activities; finished reports never resurrect a
	// stream for a run this store is not tracking.
	for _, stream := range s.streams {
		if stream.activity == nil {
			continue
		}
		runID := stream.activity.RunID
		if stream.activity.State == RunActivityQueued {
			// The accepted-command startup watchdog owns the queued phase;
			// the desktop may not know the run yet.
			continue
		}
		if activeSet[runID] != nil {
			stream.activity.UpdatedAt = now
			continue
		}
		if report, ok := finished[runID]; ok {
			state := report.GetState()
			errorCode := report.GetErrorCode()
			switch state {
			case "completed", "failed", "cancelled":
			default:
				state = "failed"
				errorCode = "desktop_run_lost"
			}
			extra := map[string]any{"reason": "desktop_reported"}
			message := report.GetMessage()
			if state == "completed" && strings.TrimSpace(message) != "" {
				extra["final_text"] = message
				message = ""
			}
			s.runFinishedLocked(stream, runID, state, errorCode, message, extra, now)
			continue
		}
		// Stream events vouch too: never finalize a run whose events are still
		// flowing through the relay (mirrors the reaper's lastAlive logic).
		eventsQuiet := stream.lastEventAt.IsZero() ||
			now.Sub(stream.lastEventAt) >= s.runReportLostTimeout
		if eventsQuiet && now.Sub(stream.activity.UpdatedAt) >= s.runReportLostTimeout {
			s.runFinishedLocked(stream, runID, "failed", "desktop_run_lost",
				"The desktop runtime stopped reporting this run.", nil, now)
		}
	}
}

func (s *conversationStreamStore) reconcileRecoveringRunsLocked(
	active map[string]*gatewayv1.ChatRunReport,
	finished map[string]*gatewayv1.ChatRunReport,
	now time.Time,
) {
	for runID, recovered := range s.recoveringRuns {
		if recovered == nil {
			delete(s.recoveringRuns, runID)
			continue
		}
		if report := finished[runID]; report != nil {
			status := strings.ToLower(strings.TrimSpace(report.GetState()))
			errorCode := strings.TrimSpace(report.GetErrorCode())
			switch status {
			case "completed", "failed", "cancelled":
			default:
				status = "failed"
				errorCode = "desktop_run_lost"
			}
			conversationID := strings.TrimSpace(report.GetConversationId())
			if conversationID == "" {
				conversationID = recovered.conversationID
			}
			payload := map[string]any{
				"status":      status,
				"reason":      "desktop_reconciled_after_restart",
				"run_started": true,
			}
			if errorCode != "" {
				payload["error_code"] = errorCode
			}
			reportMessage := strings.TrimSpace(report.GetMessage())
			terminalMessage := reportMessage
			if reportMessage != "" {
				if status == "completed" {
					payload["final_text"] = reportMessage
					terminalMessage = ""
				} else {
					payload["message"] = reportMessage
				}
			}
			if recovered.clientRequestID != "" {
				payload["client_request_id"] = recovered.clientRequestID
			}
			if conversationID == "" {
				s.cacheChatCommandTerminalLocked(
					recovered.clientRequestID, runID, "", status, errorCode,
					terminalMessage, payload, now,
				)
				s.publishCommandUpdateLocked(ChatCommandUpdate{
					RunID:           runID,
					ClientRequestID: recovered.clientRequestID,
					Phase:           status,
					ErrorCode:       errorCode,
					Message:         reportMessage,
					RunStarted:      true,
				}, now)
				delete(s.recoveringRuns, runID)
				s.persistChatCommandFinishLocked(
					recovered.clientRequestID, runID, status, errorCode,
					terminalMessage, payload, now,
				)
				continue
			}
			s.bindRecoveredRunLocked(recovered, conversationID, now)
			stream := s.streamLocked(conversationID, now)
			s.runFinishedLocked(
				stream, runID, status, errorCode, terminalMessage,
				payload, now,
			)
			delete(s.recoveringRuns, runID)
			continue
		}

		report := active[runID]
		if report == nil {
			continue
		}
		conversationID := strings.TrimSpace(report.GetConversationId())
		if conversationID == "" {
			conversationID = recovered.conversationID
		}
		if conversationID == "" {
			continue
		}
		s.bindRecoveredRunLocked(recovered, conversationID, now)
		stream := s.streamLocked(conversationID, now)
		s.runStartedLocked(stream, runID, "", now)
		delete(s.recoveringRuns, runID)
	}
}

func (s *conversationStreamStore) bindRecoveredRunLocked(
	recovered *chatCommandDedupeRecord,
	conversationID string,
	now time.Time,
) {
	conversationID = strings.TrimSpace(conversationID)
	if recovered == nil || conversationID == "" {
		return
	}
	recovered.conversationID = conversationID
	record := s.runRecordLocked(recovered.runID, conversationID)
	record.clientRequestID = recovered.clientRequestID
	s.commandDedup[recovered.clientRequestID] = recovered
	if s.commandStore != nil {
		_ = s.persistChatCommandBindLocked(
			recovered.clientRequestID, recovered.runID, conversationID, recovered.acceptedSeq, now,
		)
	}
}

func (s *conversationStreamStore) startReaper() {
	s.reaperOnce.Do(func() {
		interval := s.reaperInterval
		if interval <= 0 {
			interval = conversationReaperInterval
		}
		go func() {
			ticker := time.NewTicker(interval)
			defer ticker.Stop()
			for range ticker.C {
				s.reap(time.Now())
			}
		}()
	})
}

func (s *conversationStreamStore) scheduleRecoveryExpiry() {
	// The regular maintenance sweep is intentionally coarse. A one-shot sweep
	// at the durable recovery deadline ensures a deduplicated browser/channel
	// retry observes the terminal "unknown" result before its watcher expires.
	time.AfterFunc(chatCommandRecoveryGrace, func() {
		s.reap(time.Now())
	})
}

func (s *conversationStreamStore) reap(now time.Time) {
	s.recoveryMu.Lock()
	defer s.recoveryMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()

	online := s.isOnline != nil && s.isOnline()

	for conversationID, stream := range s.streams {
		s.evictStreamLocked(stream, now)

		if stream.activity != nil {
			// A run is stale only when NOTHING vouches for it: no stream
			// events and no activity transition/report-vouch within the
			// timeout (onRuntimeStatus bumps UpdatedAt for reported runs).
			lastAlive := stream.lastEventAt
			if stream.activity.UpdatedAt.After(lastAlive) {
				lastAlive = stream.activity.UpdatedAt
			}
			if online {
				if !lastAlive.IsZero() && now.Sub(lastAlive) > s.staleRunTimeout {
					s.runFinishedLocked(stream, stream.activity.RunID, "failed", "stale_run",
						"The desktop runtime stopped reporting this run.", nil, now)
				}
			} else if !lastAlive.IsZero() && now.Sub(lastAlive) > s.offlineRunTimeout {
				s.runFinishedLocked(stream, stream.activity.RunID, "failed", "agent_offline",
					"The desktop agent went offline during this run.", nil, now)
			}
		}

		if stream.activity == nil &&
			len(stream.subscribers) == 0 &&
			now.Sub(stream.updatedAt) > s.idleRetention {
			for _, finished := range stream.finishedRuns {
				delete(s.runs, finished)
			}
			delete(s.streams, conversationID)
		}
	}

	for runID, pending := range s.pendingRuns {
		if now.Sub(pending.createdAt) > pendingChatRunRetention {
			delete(s.pendingRuns, runID)
		}
	}

	for clientRequestID, record := range s.commandDedup {
		if record == nil || now.Sub(record.createdAt) > chatCommandDedupeRetention {
			delete(s.commandDedup, clientRequestID)
		}
	}
	if s.commandStore != nil {
		store := s.commandStore
		s.mu.Unlock()
		expired, err := store.ExpireRecovering(now)
		s.mu.Lock()
		if err != nil {
			logChatCommandStoreError("expire_recovering", "", err)
		} else {
			for _, record := range expired {
				s.publishExpiredRecoveringRunLocked(record, now)
			}
		}
		finishRetries := make([]*pendingChatCommandFinish, 0, len(s.finishRetries))
		for runID, pending := range s.finishRetries {
			if pending == nil || now.Sub(pending.createdAt) > chatCommandDedupeRetention {
				delete(s.finishRetries, runID)
				continue
			}
			finishRetries = append(finishRetries, pending)
		}
		for _, pending := range finishRetries {
			if s.finishRetries[pending.runID] != pending {
				continue
			}
			s.mu.Unlock()
			err := store.Finish(
				pending.clientRequestID, pending.runID, pending.status, pending.errorCode,
				pending.message, pending.payload, now,
			)
			s.mu.Lock()
			if s.finishRetries[pending.runID] != pending {
				continue
			}
			if err != nil {
				logChatCommandStoreError("retry_finish", pending.runID, err)
				continue
			}
			delete(s.finishRetries, pending.runID)
		}
		bindRetries := make([]*pendingChatCommandBind, 0, len(s.bindRetries))
		for runID, pending := range s.bindRetries {
			if pending == nil || now.Sub(pending.createdAt) > chatCommandDedupeRetention {
				delete(s.bindRetries, runID)
				continue
			}
			bindRetries = append(bindRetries, pending)
		}
		for _, pending := range bindRetries {
			if s.bindRetries[pending.runID] != pending {
				continue
			}
			s.mu.Unlock()
			err := store.Bind(
				pending.clientRequestID, pending.runID, pending.conversationID, pending.acceptedSeq, now,
			)
			s.mu.Lock()
			if s.bindRetries[pending.runID] != pending {
				continue
			}
			if err != nil {
				logChatCommandStoreError("retry_bind", pending.runID, err)
				continue
			}
			delete(s.bindRetries, pending.runID)
		}
		s.mu.Unlock()
		err = store.Reap(now)
		s.mu.Lock()
		if err != nil {
			logChatCommandStoreError("reap", "", err)
		}
	}

	// Swept by their own timestamp: update entries exist for runs without a
	// dedupe record in this process (post-restart replays, parked runs), so
	// pairing deletion to dedupe records would leak them.
	for runID, record := range s.commandUpdates {
		if now.Sub(record.at) > chatCommandDedupeRetention {
			delete(s.commandUpdates, runID)
		}
	}
}

func (s *conversationStreamStore) publishExpiredRecoveringRunLocked(
	record *chatCommandDedupeRecord,
	now time.Time,
) {
	if record == nil || strings.TrimSpace(record.runID) == "" {
		return
	}
	s.commandDedup[record.clientRequestID] = record
	delete(s.recoveringRuns, record.runID)
	if record.conversationID == "" {
		s.publishCommandUpdateLocked(ChatCommandUpdate{
			RunID:           record.runID,
			ClientRequestID: record.clientRequestID,
			Phase:           "unknown",
			ErrorCode:       record.terminalErrorCode,
			Message:         record.terminalMessage,
			RunStarted:      true,
		}, now)
		return
	}
	runRecord := s.runRecordLocked(record.runID, record.conversationID)
	runRecord.clientRequestID = record.clientRequestID
	stream := s.streamLocked(record.conversationID, now)
	s.runFinishedWithPersistenceLocked(
		stream,
		record.runID,
		"unknown",
		record.terminalErrorCode,
		record.terminalMessage,
		map[string]any{"reason": "restart_reconciliation_timeout", "run_started": true},
		now,
		false,
	)
}
