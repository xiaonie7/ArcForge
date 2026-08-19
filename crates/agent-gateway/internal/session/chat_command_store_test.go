package session

import (
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

type failingChatCommandStore struct{}

func (failingChatCommandStore) Lookup(string, time.Time) (*chatCommandDedupeRecord, error) {
	return nil, errors.New("state unavailable")
}
func (failingChatCommandStore) Claim(string, string, string, int64, time.Time) (*chatCommandDedupeRecord, bool, error) {
	return nil, false, errors.New("state unavailable")
}
func (failingChatCommandStore) Bind(string, string, string, int64, time.Time) error {
	return errors.New("state unavailable")
}
func (failingChatCommandStore) Mark(string, string, string, string, time.Time) error {
	return errors.New("state unavailable")
}
func (failingChatCommandStore) Finish(string, string, string, string, string, map[string]any, time.Time) error {
	return errors.New("state unavailable")
}
func (failingChatCommandStore) Recoverable(time.Time) ([]*chatCommandDedupeRecord, error) {
	return nil, errors.New("state unavailable")
}
func (failingChatCommandStore) ExpireRecovering(time.Time) ([]*chatCommandDedupeRecord, error) {
	return nil, errors.New("state unavailable")
}
func (failingChatCommandStore) Reap(time.Time) error { return errors.New("state unavailable") }

type bindFailChatCommandStore struct {
	record    *chatCommandDedupeRecord
	bindCalls int
}

func (s *bindFailChatCommandStore) Lookup(string, time.Time) (*chatCommandDedupeRecord, error) {
	if s.record == nil {
		return nil, nil
	}
	copy := *s.record
	return &copy, nil
}
func (s *bindFailChatCommandStore) Claim(
	clientRequestID, runID, conversationID string,
	acceptedSeq int64,
	now time.Time,
) (*chatCommandDedupeRecord, bool, error) {
	if s.record != nil {
		copy := *s.record
		return &copy, true, nil
	}
	s.record = &chatCommandDedupeRecord{
		clientRequestID: clientRequestID, runID: runID, conversationID: conversationID,
		acceptedSeq: acceptedSeq, createdAt: now, state: "accepted",
	}
	copy := *s.record
	return &copy, false, nil
}
func (s *bindFailChatCommandStore) Bind(string, string, string, int64, time.Time) error {
	s.bindCalls++
	return errors.New("bind unavailable")
}
func (*bindFailChatCommandStore) Mark(string, string, string, string, time.Time) error {
	return nil
}
func (*bindFailChatCommandStore) Finish(string, string, string, string, string, map[string]any, time.Time) error {
	return nil
}
func (*bindFailChatCommandStore) Recoverable(time.Time) ([]*chatCommandDedupeRecord, error) {
	return nil, nil
}
func (*bindFailChatCommandStore) ExpireRecovering(time.Time) ([]*chatCommandDedupeRecord, error) {
	return nil, nil
}
func (*bindFailChatCommandStore) Reap(time.Time) error { return nil }

type blockingChatCommandStore struct {
	inner chatCommandStore

	claimEntered chan int64
	claimRelease <-chan struct{}

	markPhase   string
	markEntered chan struct{}
	markRelease <-chan struct{}

	finishEntered chan struct{}
	finishRelease <-chan struct{}

	expireEntered chan struct{}
	expireRelease <-chan struct{}
}

func (s *blockingChatCommandStore) Lookup(
	clientRequestID string,
	now time.Time,
) (*chatCommandDedupeRecord, error) {
	return s.inner.Lookup(clientRequestID, now)
}

func (s *blockingChatCommandStore) Claim(
	clientRequestID, runID, conversationID string,
	acceptedSeq int64,
	now time.Time,
) (*chatCommandDedupeRecord, bool, error) {
	if s.claimEntered != nil {
		s.claimEntered <- acceptedSeq
	}
	if s.claimRelease != nil {
		<-s.claimRelease
	}
	return s.inner.Claim(clientRequestID, runID, conversationID, acceptedSeq, now)
}

func (s *blockingChatCommandStore) Bind(
	clientRequestID, runID, conversationID string,
	acceptedSeq int64,
	now time.Time,
) error {
	return s.inner.Bind(clientRequestID, runID, conversationID, acceptedSeq, now)
}

func (s *blockingChatCommandStore) Mark(
	clientRequestID, runID, state, phase string,
	now time.Time,
) error {
	if s.markPhase != "" && phase == s.markPhase {
		if s.markEntered != nil {
			s.markEntered <- struct{}{}
		}
		if s.markRelease != nil {
			<-s.markRelease
		}
	}
	return s.inner.Mark(clientRequestID, runID, state, phase, now)
}

func (s *blockingChatCommandStore) Finish(
	clientRequestID, runID, status, errorCode, message string,
	payload map[string]any,
	now time.Time,
) error {
	if s.finishEntered != nil {
		s.finishEntered <- struct{}{}
	}
	if s.finishRelease != nil {
		<-s.finishRelease
	}
	return s.inner.Finish(clientRequestID, runID, status, errorCode, message, payload, now)
}

func (s *blockingChatCommandStore) Recoverable(now time.Time) ([]*chatCommandDedupeRecord, error) {
	return s.inner.Recoverable(now)
}

func (s *blockingChatCommandStore) ExpireRecovering(now time.Time) ([]*chatCommandDedupeRecord, error) {
	if s.expireEntered != nil {
		s.expireEntered <- struct{}{}
	}
	if s.expireRelease != nil {
		<-s.expireRelease
	}
	return s.inner.ExpireRecovering(now)
}

func (s *blockingChatCommandStore) Reap(now time.Time) error {
	return s.inner.Reap(now)
}

func openTestChatCommandStore(t *testing.T, path string) *SQLiteChatCommandStore {
	t.Helper()
	store, err := OpenSQLiteChatCommandStore(path)
	if err != nil {
		t.Fatalf("OpenSQLiteChatCommandStore: %v", err)
	}
	return store
}

func TestSQLiteChatCommandStoreDeduplicatesAcrossManagers(t *testing.T) {
	store := openTestChatCommandStore(t, filepath.Join(t.TempDir(), "gateway-state.sqlite3"))
	defer store.Close()
	firstManager := NewManagerWithChatCommandPersistence(store)
	secondManager := NewManagerWithChatCommandPersistence(store)

	starts := make(chan ChatCommandStart, 2)
	var wg sync.WaitGroup
	for _, candidate := range []struct {
		manager *Manager
		runID   string
	}{{firstManager, "run-1"}, {secondManager, "run-2"}} {
		wg.Add(1)
		go func(manager *Manager, runID string) {
			defer wg.Done()
			starts <- manager.StartChatCommand(runID, "conv-1", "", "client-shared", nil)
		}(candidate.manager, candidate.runID)
	}
	wg.Wait()
	close(starts)

	results := make([]ChatCommandStart, 0, 2)
	for start := range starts {
		results = append(results, start)
	}
	if len(results) != 2 || results[0].PersistenceError != "" || results[1].PersistenceError != "" {
		t.Fatalf("starts = %#v", results)
	}
	if results[0].RunID != results[1].RunID {
		t.Fatalf("canonical run mismatch: %#v", results)
	}
	if results[0].Deduped == results[1].Deduped {
		t.Fatalf("dedupe flags = %v and %v, want one creator", results[0].Deduped, results[1].Deduped)
	}
}

func TestChatCommandPersistenceFailureFailsClosed(t *testing.T) {
	manager := newManager(failingChatCommandStore{})
	start := manager.StartChatCommand("run-1", "conv-1", "", "client-1", nil)
	if start.PersistenceError == "" || !start.Deduped {
		t.Fatalf("start = %#v, want fail-closed persistence error", start)
	}
	if _, exists := manager.convStreams.runs["run-1"]; exists {
		t.Fatal("failed durable claim registered an in-memory run")
	}
}

func TestChatCommandBindFailureDoesNotStrandCanonicalRun(t *testing.T) {
	store := &bindFailChatCommandStore{}
	manager := newManager(store)
	start := manager.StartChatCommand("run-1", "conv-1", "", "client-1", []map[string]any{
		{"type": "user_message", "message": "hello"},
	})
	if start.PersistenceError != "" || start.Deduped || start.AcceptedSeq != 1 {
		t.Fatalf("start = %#v, want dispatchable command with deferred actual-seq Bind", start)
	}
	if store.bindCalls != 1 {
		t.Fatalf("initial command issued %d Bind calls, want 1", store.bindCalls)
	}
	retry := manager.StartChatCommand("run-retry", "conv-other", "", "client-1", nil)
	if !retry.Deduped || retry.RunID != "run-1" || retry.AcceptedSeq != 1 {
		t.Fatalf("retry = %#v, want original canonical run", retry)
	}
}

func TestSQLiteChatCommandReapIsBounded(t *testing.T) {
	store := openTestChatCommandStore(t, filepath.Join(t.TempDir(), "gateway-state.sqlite3"))
	defer store.Close()
	now := time.Now()
	_, err := store.db.Exec(`WITH RECURSIVE seq(n) AS (
		SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < ?
	) INSERT INTO chat_command_dedupe(
		client_request_id, run_id, conversation_id, accepted_seq, state,
		dispatch_phase, created_at_ms, updated_at_ms, expires_at_ms
	) SELECT printf('expired-client-%d', n), printf('expired-run-%d', n), '', 0,
		'terminal', 'completed', ?, ?, ? FROM seq`,
		chatCommandReapBatchSize, now.UnixMilli(), now.UnixMilli(), now.Add(-time.Second).UnixMilli())
	if err != nil {
		t.Fatalf("seed expired chat commands: %v", err)
	}
	if err := store.Reap(now); err != nil {
		t.Fatalf("first Reap: %v", err)
	}
	var remaining int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM chat_command_dedupe`).Scan(&remaining); err != nil {
		t.Fatalf("count after first Reap: %v", err)
	}
	if remaining != 1 {
		t.Fatalf("remaining after first Reap = %d, want 1", remaining)
	}
	if err := store.Reap(now); err != nil {
		t.Fatalf("second Reap: %v", err)
	}
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM chat_command_dedupe`).Scan(&remaining); err != nil {
		t.Fatalf("count after second Reap: %v", err)
	}
	if remaining != 0 {
		t.Fatalf("remaining after second Reap = %d, want 0", remaining)
	}
}

func TestChatCommandDelayedBindFailureKeepsCanonicalRunRetryable(t *testing.T) {
	store := &bindFailChatCommandStore{}
	manager := newManager(store)
	start := manager.StartChatCommand("run-1", "", "", "client-1", []map[string]any{
		{"type": "user_message", "message": "hello"},
	})
	if start.PersistenceError != "" || start.Deduped {
		t.Fatalf("start = %#v", start)
	}
	manager.ingestChatControl("run-1", startedControl("run-1", "conv-1"))
	if store.bindCalls != 1 {
		t.Fatalf("delayed Bind calls = %d, want 1", store.bindCalls)
	}
	retry := manager.StartChatCommand("run-retry", "conv-other", "", "client-1", nil)
	if !retry.Deduped || retry.RunID != "run-1" || retry.PersistenceError != "" {
		t.Fatalf("retry = %#v, want original canonical run", retry)
	}
}

func TestChatCommandClaimReleasesGlobalLockAndBindsActualSeq(t *testing.T) {
	sqliteStore := openTestChatCommandStore(t, filepath.Join(t.TempDir(), "gateway-state.sqlite3"))
	defer sqliteStore.Close()
	claimRelease := make(chan struct{})
	store := &blockingChatCommandStore{
		inner:        sqliteStore,
		claimEntered: make(chan int64, 2),
		claimRelease: claimRelease,
	}
	manager := newManager(store)
	manager.ingestChatControl("run-history", startedControl("run-history", "conv-1"))
	manager.ingestChatEvent("run-history", tokenEvent("conv-1", "history"))
	manager.ingestChatEvent("run-history", doneEvent("conv-1"))
	before := manager.SubscribeConversationStream("conv-1", 0, "")
	beforeSeq := before.LatestSeq
	before.Cleanup()

	starts := make(chan ChatCommandStart, 2)
	for _, candidate := range []string{"run-a", "run-b"} {
		go func(runID string) {
			starts <- manager.StartChatCommand(runID, "conv-1", "", "client-shared", []map[string]any{
				{"type": "user_message", "message": runID},
				{"type": StreamEventRebased, "reason": "test"},
			})
		}(candidate)
	}
	for range 2 {
		select {
		case claimedSeq := <-store.claimEntered:
			if claimedSeq != beforeSeq {
				close(claimRelease)
				t.Fatalf("Claim accepted_seq = %d, want conservative %d", claimedSeq, beforeSeq)
			}
		case <-time.After(time.Second):
			close(claimRelease)
			t.Fatal("timed out waiting for blocked Claim")
		}
	}

	activityRead := make(chan struct{})
	go func() {
		_ = manager.ActiveConversationActivities()
		close(activityRead)
	}()
	select {
	case <-activityRead:
	case <-time.After(time.Second):
		close(claimRelease)
		t.Fatal("Claim held the conversation-store mutex")
	}

	otherStarted := make(chan struct{})
	go func() {
		manager.ingestChatControl("run-other", startedControl("run-other", "conv-1"))
		close(otherStarted)
	}()
	select {
	case <-otherStarted:
	case <-time.After(time.Second):
		close(claimRelease)
		t.Fatal("conversation ingress blocked behind Claim")
	}
	close(claimRelease)

	first := <-starts
	second := <-starts
	if first.RunID != second.RunID || first.Deduped == second.Deduped {
		t.Fatalf("concurrent starts = %#v and %#v", first, second)
	}
	winner := first
	loserRunID := "run-a"
	if first.Deduped {
		winner = second
	}
	if winner.RunID == loserRunID {
		loserRunID = "run-b"
	}
	after := manager.SubscribeConversationStream("conv-1", 0, "")
	actualSeq := after.LatestSeq
	after.Cleanup()
	if winner.AcceptedSeq != actualSeq || actualSeq <= beforeSeq {
		t.Fatalf("winner accepted_seq = %d, stream seq = %d, before = %d", winner.AcceptedSeq, actualSeq, beforeSeq)
	}
	persisted, err := sqliteStore.Lookup("client-shared", time.Now())
	if err != nil || persisted == nil || persisted.acceptedSeq != actualSeq {
		t.Fatalf("durable canonical record = %#v, err=%v, want seq %d", persisted, err, actualSeq)
	}
	manager.convStreams.mu.Lock()
	_, loserRegistered := manager.convStreams.runs[loserRunID]
	manager.convStreams.mu.Unlock()
	if loserRegistered {
		t.Fatalf("deduplicated losing run %q registered in memory", loserRunID)
	}
}

func TestChatCommandFinishReleasesGlobalLockAfterTerminalTransition(t *testing.T) {
	sqliteStore := openTestChatCommandStore(t, filepath.Join(t.TempDir(), "gateway-state.sqlite3"))
	defer sqliteStore.Close()
	store := &blockingChatCommandStore{inner: sqliteStore}
	manager := newManager(store)
	manager.StartChatCommand("run-1", "conv-1", "", "client-1", nil)

	finishRelease := make(chan struct{})
	store.finishEntered = make(chan struct{}, 1)
	store.finishRelease = finishRelease
	finished := make(chan struct{})
	go func() {
		manager.ingestChatEvent("run-1", doneEventWithFinalText("conv-1", "final answer"))
		close(finished)
	}()
	select {
	case <-store.finishEntered:
	case <-time.After(time.Second):
		close(finishRelease)
		t.Fatal("timed out waiting for blocked Finish")
	}

	observed := make(chan ChatCommandUpdate, 1)
	go func() {
		updates, cleanup := manager.WatchChatCommand("run-1")
		defer cleanup()
		observed <- <-updates
	}()
	select {
	case update := <-observed:
		if update.Phase != "completed" || update.Message != "final answer" {
			close(finishRelease)
			t.Fatalf("terminal update while Finish blocked = %#v", update)
		}
	case <-time.After(time.Second):
		close(finishRelease)
		t.Fatal("Finish held the conversation-store mutex")
	}
	close(finishRelease)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("terminal ingress did not finish after releasing store")
	}
}

func TestLateMarkCannotOverwriteTerminalCommandUpdate(t *testing.T) {
	sqliteStore := openTestChatCommandStore(t, filepath.Join(t.TempDir(), "gateway-state.sqlite3"))
	defer sqliteStore.Close()
	store := &blockingChatCommandStore{inner: sqliteStore}
	manager := newManager(store)
	manager.StartChatCommand("run-1", "conv-1", "", "client-1", []map[string]any{
		{"type": "user_message", "message": "hello"},
	})

	markRelease := make(chan struct{})
	store.markPhase = "queued_in_gui"
	store.markEntered = make(chan struct{}, 1)
	store.markRelease = markRelease
	queuedDone := make(chan struct{})
	go func() {
		manager.ingestChatControl("run-1", &gatewayv1.ChatControlEvent{
			RequestId: "run-1", ConversationId: "conv-1", Type: "queued_in_gui",
		})
		close(queuedDone)
	}()
	select {
	case <-store.markEntered:
	case <-time.After(time.Second):
		close(markRelease)
		t.Fatal("timed out waiting for blocked Mark")
	}

	terminalDone := make(chan struct{})
	go func() {
		manager.ingestChatEvent("run-1", doneEventWithFinalText("conv-1", "final answer"))
		close(terminalDone)
	}()
	select {
	case <-terminalDone:
	case <-time.After(time.Second):
		close(markRelease)
		t.Fatal("late Mark held the conversation-store mutex")
	}
	updates, cleanup := manager.WatchChatCommand("run-1")
	update := <-updates
	cleanup()
	if update.Phase != "completed" || update.Message != "final answer" {
		close(markRelease)
		t.Fatalf("terminal replay before Mark returns = %#v", update)
	}
	close(markRelease)
	select {
	case <-queuedDone:
	case <-time.After(time.Second):
		t.Fatal("queued control did not finish after releasing Mark")
	}
	updates, cleanup = manager.WatchChatCommand("run-1")
	update = <-updates
	cleanup()
	if update.Phase != "completed" {
		t.Fatalf("late Mark overwrote terminal replay: %#v", update)
	}
}

func TestReaperStoreIOReleasesGlobalLockAndKeepsNewerRetry(t *testing.T) {
	sqliteStore := openTestChatCommandStore(t, filepath.Join(t.TempDir(), "gateway-state.sqlite3"))
	defer sqliteStore.Close()
	store := &blockingChatCommandStore{inner: sqliteStore}
	manager := newManager(store)
	manager.StartChatCommand("run-1", "conv-1", "", "client-1", nil)

	now := time.Now()
	firstRetry := &pendingChatCommandFinish{
		clientRequestID: "client-1", runID: "run-1", status: "failed",
		errorCode: "first", message: "first", payload: map[string]any{"status": "failed"}, createdAt: now,
	}
	manager.convStreams.mu.Lock()
	manager.convStreams.finishRetries["run-1"] = firstRetry
	manager.convStreams.mu.Unlock()

	expireRelease := make(chan struct{})
	finishRelease := make(chan struct{})
	store.expireEntered = make(chan struct{}, 1)
	store.expireRelease = expireRelease
	store.finishEntered = make(chan struct{}, 1)
	store.finishRelease = finishRelease
	reaped := make(chan struct{})
	go func() {
		manager.convStreams.reap(now)
		close(reaped)
	}()
	select {
	case <-store.expireEntered:
	case <-time.After(time.Second):
		close(expireRelease)
		close(finishRelease)
		t.Fatal("timed out waiting for blocked recovery expiry")
	}
	activityRead := make(chan struct{})
	go func() {
		_ = manager.ActiveConversationActivities()
		close(activityRead)
	}()
	select {
	case <-activityRead:
	case <-time.After(time.Second):
		close(expireRelease)
		close(finishRelease)
		t.Fatal("recovery expiry held the conversation-store mutex")
	}
	close(expireRelease)
	select {
	case <-store.finishEntered:
	case <-time.After(time.Second):
		close(finishRelease)
		t.Fatal("timed out waiting for blocked retry Finish")
	}
	newerRetry := &pendingChatCommandFinish{
		clientRequestID: "client-1", runID: "run-1", status: "failed",
		errorCode: "newer", message: "newer", payload: map[string]any{"status": "failed"}, createdAt: now,
	}
	manager.convStreams.mu.Lock()
	manager.convStreams.finishRetries["run-1"] = newerRetry
	manager.convStreams.mu.Unlock()
	close(finishRelease)
	select {
	case <-reaped:
	case <-time.After(time.Second):
		t.Fatal("reaper did not finish after releasing store")
	}
	manager.convStreams.mu.Lock()
	kept := manager.convStreams.finishRetries["run-1"]
	manager.convStreams.mu.Unlock()
	if kept != newerRetry {
		t.Fatalf("reaper removed or replaced newer retry: got %#v", kept)
	}
}

func TestSQLiteChatCommandStoreReplaysTerminalAfterRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "gateway-state.sqlite3")
	store := openTestChatCommandStore(t, path)
	manager := NewManagerWithChatCommandPersistence(store)
	start := manager.StartChatCommand("run-1", "conv-1", "", "client-1", nil)
	if start.Deduped || start.PersistenceError != "" {
		t.Fatalf("initial start = %#v", start)
	}
	manager.FailChatCommand("run-1", "delivery_failed", "desktop unavailable")
	if err := store.Close(); err != nil {
		t.Fatalf("close first store: %v", err)
	}

	reopened := openTestChatCommandStore(t, path)
	defer reopened.Close()
	retry := NewManagerWithChatCommandPersistence(reopened).StartChatCommand(
		"run-retry", "conv-other", "", "client-1", nil,
	)
	if !retry.Deduped || retry.RunID != "run-1" || retry.Terminal == nil {
		t.Fatalf("retry = %#v", retry)
	}
	if retry.Terminal.Status != "failed" || retry.Terminal.ErrorCode != "delivery_failed" {
		t.Fatalf("terminal = %#v", retry.Terminal)
	}
}

func TestSQLiteChatCommandStoreRefreshesTerminalOverMemoryCache(t *testing.T) {
	store := openTestChatCommandStore(t, filepath.Join(t.TempDir(), "gateway-state.sqlite3"))
	defer store.Close()
	manager := NewManagerWithChatCommandPersistence(store)
	start := manager.StartChatCommand("run-1", "", "", "client-1", nil)
	if start.Deduped || start.PersistenceError != "" {
		t.Fatalf("initial start = %#v", start)
	}
	manager.FailChatCommand("run-1", "delivery_failed", "desktop unavailable")

	retry := manager.StartChatCommand("run-retry", "", "", "client-1", nil)
	if !retry.Deduped || retry.RunID != "run-1" || retry.Terminal == nil {
		t.Fatalf("retry = %#v", retry)
	}
	if retry.Terminal.Status != "failed" || retry.Terminal.ErrorCode != "delivery_failed" {
		t.Fatalf("terminal = %#v", retry.Terminal)
	}
}

func TestSQLiteChatCommandStoreRequiresCanonicalRowsAndKeepsFirstTerminal(t *testing.T) {
	store := openTestChatCommandStore(t, filepath.Join(t.TempDir(), "gateway-state.sqlite3"))
	defer store.Close()
	now := time.Now()
	if err := store.Mark("missing", "missing", "running", "started", now); err == nil {
		t.Fatal("Mark missing row succeeded")
	}
	if err := store.Finish("missing", "missing", "failed", "first", "first", nil, now); err == nil {
		t.Fatal("Finish missing row succeeded")
	}
	if _, _, err := store.Claim("client-1", "run-1", "", 0, now); err != nil {
		t.Fatalf("Claim: %v", err)
	}
	if err := store.Finish("client-1", "run-1", "failed", "first", "first", nil, now); err != nil {
		t.Fatalf("first Finish: %v", err)
	}
	if err := store.Finish("client-1", "run-1", "failed", "first", "first", nil, now); err != nil {
		t.Fatalf("idempotent Finish: %v", err)
	}
	if err := store.Finish("client-1", "run-1", "completed", "", "second", nil, now); err == nil {
		t.Fatal("second terminal Finish succeeded")
	}
	record, err := store.Lookup("client-1", now)
	if err != nil || record == nil {
		t.Fatalf("Lookup: record=%#v err=%v", record, err)
	}
	if record.terminalStatus != "failed" || record.terminalErrorCode != "first" {
		t.Fatalf("terminal was overwritten: %#v", record)
	}
}

func TestSQLiteChatCommandStoreReconcilesActiveRunAfterRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "gateway-state.sqlite3")
	store := openTestChatCommandStore(t, path)
	manager := NewManagerWithChatCommandPersistence(store)
	manager.StartChatCommand("run-1", "conv-1", "", "client-1", nil)
	if err := store.Close(); err != nil {
		t.Fatalf("close first store: %v", err)
	}

	reopened := openTestChatCommandStore(t, path)
	defer reopened.Close()
	recoveredManager := NewManagerWithChatCommandPersistence(reopened)
	retry := recoveredManager.StartChatCommand(
		"run-retry", "conv-other", "", "client-1", nil,
	)
	if !retry.Deduped || retry.RunID != "run-1" || retry.Terminal != nil || !retry.Recovering {
		t.Fatalf("retry during reconciliation = %#v", retry)
	}

	recoveredManager.convStreams.onRuntimeStatus(runsReport(
		[]*gatewayv1.ChatRunReport{runReport("run-1", "conv-1", "running")}, nil,
	), time.Now())
	active, ok := recoveredManager.LookupChatCommand("client-1")
	if !ok || active.Terminal != nil || active.RunID != "run-1" {
		t.Fatalf("active recovery = %#v, ok=%v", active, ok)
	}
	activities := recoveredManager.ActiveConversationActivities()
	if len(activities) != 1 || activities[0].RunID != "run-1" {
		t.Fatalf("recovered activities = %#v", activities)
	}

	finished := runReport("run-1", "conv-1", "completed")
	finished.Message = "answer recovered from desktop ledger"
	recoveredManager.convStreams.onRuntimeStatus(runsReport(nil,
		[]*gatewayv1.ChatRunReport{finished},
	), time.Now())
	terminal, ok := recoveredManager.LookupChatCommand("client-1")
	if !ok || terminal.Terminal == nil || terminal.Terminal.Status != "completed" {
		t.Fatalf("reconciled terminal = %#v, ok=%v", terminal, ok)
	}
	if !strings.Contains(terminal.Terminal.PayloadJSON, `"final_text":"answer recovered from desktop ledger"`) {
		t.Fatalf("reconciled terminal payload = %s", terminal.Terminal.PayloadJSON)
	}
}

func TestSQLiteChatCommandStoreReconcilesFinishedReportWithoutMemoryStream(t *testing.T) {
	path := filepath.Join(t.TempDir(), "gateway-state.sqlite3")
	store := openTestChatCommandStore(t, path)
	NewManagerWithChatCommandPersistence(store).StartChatCommand(
		"run-1", "conv-1", "", "client-1", nil,
	)
	if err := store.Close(); err != nil {
		t.Fatalf("close first store: %v", err)
	}

	reopened := openTestChatCommandStore(t, path)
	defer reopened.Close()
	recoveredManager := NewManagerWithChatCommandPersistence(reopened)
	recoveredManager.convStreams.onRuntimeStatus(runsReport(nil,
		[]*gatewayv1.ChatRunReport{runReport("run-1", "conv-1", "failed")},
	), time.Now())
	retry := recoveredManager.StartChatCommand("run-retry", "", "", "client-1", nil)
	if !retry.Deduped || retry.RunID != "run-1" || retry.Terminal == nil {
		t.Fatalf("retry = %#v", retry)
	}
	if retry.Terminal.Status != "failed" {
		t.Fatalf("terminal = %#v", retry.Terminal)
	}
}

func TestSQLiteChatCommandStorePersistsPresentedFilesForTerminalReplay(t *testing.T) {
	path := filepath.Join(t.TempDir(), "gateway-state.sqlite3")
	store := openTestChatCommandStore(t, path)
	manager := NewManagerWithChatCommandPersistence(store)
	start := manager.StartChatCommand("run-1", "conv-1", "/workspace", "client-1", nil)
	if start.Deduped || start.PersistenceError != "" {
		t.Fatalf("start = %#v", start)
	}
	manager.ingestChatEvent("run-1", &gatewayv1.ChatEvent{
		Type:           gatewayv1.ChatEvent_TOOL_RESULT,
		ConversationId: "conv-1",
		Data: `{"name":"PresentFile","isError":false,"details":{"kind":"display_file","files":[{` +
			`"relativePath":"reports/result.pdf","fileName":"result.pdf","mimeType":"application/pdf",` +
			`"fileId":"artifact-1","sizeBytes":4,"mtimeMs":1234}]}}`,
	})
	manager.ingestChatEvent("run-1", &gatewayv1.ChatEvent{
		Type:           gatewayv1.ChatEvent_DONE,
		ConversationId: "conv-1",
		Data:           `{"final_text":"done"}`,
	})
	terminal, ok := manager.LookupChatCommand("client-1")
	if !ok || terminal.Terminal == nil || len(terminal.Terminal.PresentedFiles) != 1 {
		t.Fatalf("live terminal = %#v, ok=%v", terminal, ok)
	}
	file := terminal.Terminal.PresentedFiles[0]
	if file.Seq <= 0 || file.Workdir != "/workspace" || !strings.Contains(file.PayloadJSON, "artifact-1") {
		t.Fatalf("live presented file = %#v", file)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close first store: %v", err)
	}

	reopened := openTestChatCommandStore(t, path)
	defer reopened.Close()
	retry := NewManagerWithChatCommandPersistence(reopened).StartChatCommand(
		"run-retry", "conv-other", "", "client-1", nil,
	)
	if !retry.Deduped || retry.RunID != "run-1" || retry.Terminal == nil ||
		len(retry.Terminal.PresentedFiles) != 1 {
		t.Fatalf("restarted terminal = %#v", retry)
	}
	replayed := retry.Terminal.PresentedFiles[0]
	if replayed != file {
		t.Fatalf("restarted presented file = %#v, want %#v", replayed, file)
	}
}

func TestSQLiteChatCommandStoreExpiresUnreconciledRunAsUnknown(t *testing.T) {
	path := filepath.Join(t.TempDir(), "gateway-state.sqlite3")
	store := openTestChatCommandStore(t, path)
	NewManagerWithChatCommandPersistence(store).StartChatCommand(
		"run-1", "conv-1", "", "client-1", nil,
	)
	if err := store.Close(); err != nil {
		t.Fatalf("close first store: %v", err)
	}

	reopened := openTestChatCommandStore(t, path)
	defer reopened.Close()
	recoveredManager := NewManagerWithChatCommandPersistence(reopened)
	recoveredManager.convStreams.reap(time.Now().Add(chatCommandRecoveryGrace + time.Second))
	retry := recoveredManager.StartChatCommand("run-retry", "", "", "client-1", nil)
	if !retry.Deduped || retry.RunID != "run-1" || retry.Terminal == nil {
		t.Fatalf("retry = %#v", retry)
	}
	if retry.Terminal.Status != "unknown" || retry.Terminal.ErrorCode != "gateway_restart" {
		t.Fatalf("terminal = %#v", retry.Terminal)
	}
}

func TestSQLiteChatCommandStoreKeepsRestartUnknownTerminalAcrossLaterRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "gateway-state.sqlite3")
	store := openTestChatCommandStore(t, path)
	NewManagerWithChatCommandPersistence(store).StartChatCommand(
		"run-1", "conv-1", "", "client-1", nil,
	)
	if err := store.Close(); err != nil {
		t.Fatalf("close first store: %v", err)
	}

	recoveringStore := openTestChatCommandStore(t, path)
	recoveringManager := NewManagerWithChatCommandPersistence(recoveringStore)
	recoveringManager.convStreams.reap(time.Now().Add(chatCommandRecoveryGrace + time.Second))
	if err := recoveringStore.Close(); err != nil {
		t.Fatalf("close recovering store: %v", err)
	}

	reopened := openTestChatCommandStore(t, path)
	defer reopened.Close()
	retry := NewManagerWithChatCommandPersistence(reopened).StartChatCommand(
		"run-retry", "conv-other", "", "client-1", nil,
	)
	if !retry.Deduped || retry.RunID != "run-1" || retry.Terminal == nil || retry.Recovering {
		t.Fatalf("retry after second restart = %#v", retry)
	}
	if retry.Terminal.Status != "unknown" || retry.Terminal.ErrorCode != "gateway_restart" {
		t.Fatalf("terminal after second restart = %#v", retry.Terminal)
	}
}
