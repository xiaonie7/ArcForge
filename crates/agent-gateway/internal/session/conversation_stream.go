package session

import (
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
// pre-stream outcomes.
type ChatCommandUpdate struct {
	RunID           string
	ClientRequestID string
	ConversationID  string
	Phase           string // "bound" | "queued_in_gui" | "failed"
	ErrorCode       string
	Message         string
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
}

// chatCommandDedupeRecord is the process-local idempotency key for WebUI chat
// submissions. It is created atomically with the canonical run and retained
// long enough to cover WebSocket reconnect/retry windows without keeping full
// transcript state alive.
type chatCommandDedupeRecord struct {
	runID          string
	conversationID string
	acceptedSeq    int64
	createdAt      time.Time
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

type pendingChatRun struct {
	runID           string
	clientRequestID string
	workdir         string
	seeded          []map[string]any
	createdAt       time.Time
}

type conversationStreamStore struct {
	mu              sync.Mutex
	streams         map[string]*conversationStream
	pendingRuns     map[string]*pendingChatRun
	runs            map[string]*chatRunRecord
	commandDedup    map[string]*chatCommandDedupeRecord
	commandWatchers map[string][]chan ChatCommandUpdate
	commandUpdates  map[string]chatCommandUpdateRecord
	nextSubID       int

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
	return &conversationStreamStore{
		streams:              make(map[string]*conversationStream),
		pendingRuns:          make(map[string]*pendingChatRun),
		runs:                 make(map[string]*chatRunRecord),
		commandDedup:         make(map[string]*chatCommandDedupeRecord),
		commandWatchers:      make(map[string][]chan ChatCommandUpdate),
		commandUpdates:       make(map[string]chatCommandUpdateRecord),
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
	if stream == nil || stream.activity == nil || stream.activity.RunID != runID {
		return "", false
	}
	// A runtime snapshot belongs to this exact run and is authoritative. The
	// conversation and queued activity workdirs may still contain the previous
	// run's sticky workspace when a channel command starts with an empty cwd.
	if snapshot := stream.latestSnapshot; snapshot != nil && snapshot.RunID == runID {
		if workdir := strings.TrimSpace(snapshot.Workdir); workdir != "" {
			return workdir, true
		}
	}
	if workdir := strings.TrimSpace(stream.activity.Workdir); workdir != "" {
		return workdir, true
	}
	if workdir := strings.TrimSpace(stream.workdir); workdir != "" {
		return workdir, true
	}
	return "", false
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
			s.publishActivityLocked(stream, now)
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
	if runID == "" || stream.runFinishedRecently(runID) {
		return
	}
	if stream.activity == nil || stream.activity.RunID != runID {
		// Terminal signal for a run this stream never started (e.g. the
		// gateway restarted mid-run). Synthesize the start so clients see a
		// coherent pair, unless another run is currently active — then the
		// stray terminal is recorded without touching the active run.
		if stream.activity == nil {
			s.runStartedLocked(stream, runID, "", now)
		}
	}
	payload := map[string]any{
		"status": status,
	}
	if errorCode != "" {
		payload["error_code"] = errorCode
	}
	if message != "" {
		payload["message"] = message
	}
	for key, value := range extra {
		if _, exists := payload[key]; !exists {
			payload[key] = value
		}
	}
	if record := s.runs[runID]; record != nil && record.clientRequestID != "" {
		payload["client_request_id"] = record.clientRequestID
	}
	s.appendEventLocked(stream, runID, StreamEventRunFinished, payload, now)
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
	s.commandUpdates[update.RunID] = chatCommandUpdateRecord{update: update, at: time.Now()}
	for _, watcher := range s.commandWatchers[update.RunID] {
		select {
		case watcher <- update:
		default:
		}
	}
}

// ChatCommandStart is the accepted-command result returned to the transport.
type ChatCommandStart struct {
	RunID          string
	ConversationID string
	AcceptedSeq    int64
	Deduped        bool
}

// LookupChatCommand returns the canonical run already assigned to a
// client_request_id. The lookup and StartChatCommand share the same store mutex;
// callers may use this as a fast path, while StartChatCommand remains the
// authoritative atomic check for concurrent submissions.
func (m *Manager) LookupChatCommand(clientRequestID string) (ChatCommandStart, bool) {
	s := m.convStreams
	clientRequestID = strings.TrimSpace(clientRequestID)
	if clientRequestID == "" {
		return ChatCommandStart{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lookupChatCommandLocked(clientRequestID)
}

func (s *conversationStreamStore) lookupChatCommandLocked(
	clientRequestID string,
) (ChatCommandStart, bool) {
	record := s.commandDedup[clientRequestID]
	if record == nil || strings.TrimSpace(record.runID) == "" {
		return ChatCommandStart{}, false
	}
	return ChatCommandStart{
		RunID:          record.runID,
		ConversationID: record.conversationID,
		AcceptedSeq:    record.acceptedSeq,
		Deduped:        true,
	}, true
}

func (s *conversationStreamStore) updateChatCommandDedupeLocked(
	clientRequestID string,
	runID string,
	conversationID string,
	acceptedSeq int64,
	now time.Time,
) {
	clientRequestID = strings.TrimSpace(clientRequestID)
	if clientRequestID == "" || strings.TrimSpace(runID) == "" {
		return
	}
	record := s.commandDedup[clientRequestID]
	if record == nil {
		record = &chatCommandDedupeRecord{
			runID:     strings.TrimSpace(runID),
			createdAt: now,
		}
		s.commandDedup[clientRequestID] = record
	}
	if record.runID != strings.TrimSpace(runID) {
		return
	}
	if conversationID = strings.TrimSpace(conversationID); conversationID != "" {
		record.conversationID = conversationID
	}
	if acceptedSeq > record.acceptedSeq {
		record.acceptedSeq = acceptedSeq
	}
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
	if existing, ok := s.lookupChatCommandLocked(clientRequestID); ok {
		return existing
	}
	s.updateChatCommandDedupeLocked(clientRequestID, runID, conversationID, 0, now)
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
		s.updateChatCommandDedupeLocked(
			clientRequestID, start.RunID, start.ConversationID, start.AcceptedSeq, now,
		)
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
	s.updateChatCommandDedupeLocked(
		clientRequestID, start.RunID, start.ConversationID, start.AcceptedSeq, now,
	)
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
	s.mu.Lock()
	defer s.mu.Unlock()

	activeSet := make(map[string]bool, len(event.GetActiveRuns()))
	for _, report := range event.GetActiveRuns() {
		activeSet[report.GetRunId()] = true
	}
	finished := make(map[string]*gatewayv1.ChatRunReport, len(event.GetFinishedRuns()))
	for _, report := range event.GetFinishedRuns() {
		finished[report.GetRunId()] = report
	}

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
		if activeSet[runID] {
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
			s.runFinishedLocked(stream, runID, state, errorCode, report.GetMessage(),
				map[string]any{"reason": "desktop_reported"}, now)
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

func (s *conversationStreamStore) reap(now time.Time) {
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

	// Swept by their own timestamp: update entries exist for runs without a
	// dedupe record in this process (post-restart replays, parked runs), so
	// pairing deletion to dedupe records would leak them.
	for runID, record := range s.commandUpdates {
		if now.Sub(record.at) > chatCommandDedupeRetention {
			delete(s.commandUpdates, runID)
		}
	}
}
