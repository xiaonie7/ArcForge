package session

import (
	"testing"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func runReport(runID string, conversationID string, state string) *gatewayv1.ChatRunReport {
	return &gatewayv1.ChatRunReport{
		RunId:          runID,
		ConversationId: conversationID,
		State:          state,
	}
}

func runsReport(
	active []*gatewayv1.ChatRunReport,
	finished []*gatewayv1.ChatRunReport,
) *gatewayv1.RuntimeStatusEvent {
	return &gatewayv1.RuntimeStatusEvent{
		ActiveRunCount: uint32(len(active)),
		ActiveRuns:     active,
		FinishedRuns:   finished,
	}
}

func lastEvent(t *testing.T, m *Manager, conversationID string) *ConversationEvent {
	t.Helper()
	sub := m.SubscribeConversationStream(conversationID, 0, "")
	sub.Cleanup()
	if len(sub.Events) == 0 {
		t.Fatalf("no events for %s", conversationID)
	}
	return sub.Events[len(sub.Events)-1]
}

// A terminal the gateway never received (lost desktop signal) is adopted from
// the desktop's finished_runs report with its real final state.
func TestRunReportAdoptsMissedTerminal(t *testing.T) {
	m := NewManager()
	m.ingestChatControl("run-1", startedControl("run-1", "conv-1"))

	m.convStreams.onRuntimeStatus(runsReport(nil, []*gatewayv1.ChatRunReport{
		{
			RunId:          "run-1",
			ConversationId: "conv-1",
			State:          "completed",
			Message:        "recovered final answer",
		},
	}), time.Now())

	last := lastEvent(t, m, "conv-1")
	if last.Type != StreamEventRunFinished || last.Payload["status"] != "completed" {
		t.Fatalf("adopted terminal = %s %#v, want run_finished/completed", last.Type, last.Payload)
	}
	if last.Payload["reason"] != "desktop_reported" {
		t.Fatalf("adopted terminal reason = %#v, want desktop_reported", last.Payload["reason"])
	}
	if last.Payload["final_text"] != "recovered final answer" {
		t.Fatalf("adopted terminal final_text = %#v", last.Payload["final_text"])
	}
	if activities := m.ActiveConversationActivities(); len(activities) != 0 {
		t.Fatalf("activity not cleared after adopted terminal, activities=%d", len(activities))
	}

	// A finished report with an unknown state is not trusted verbatim: the
	// run fails with desktop_run_lost instead.
	m2 := NewManager()
	m2.ingestChatControl("run-2", startedControl("run-2", "conv-2"))
	m2.convStreams.onRuntimeStatus(runsReport(nil, []*gatewayv1.ChatRunReport{
		runReport("run-2", "conv-2", "exploded"),
	}), time.Now())
	last2 := lastEvent(t, m2, "conv-2")
	if last2.Type != StreamEventRunFinished ||
		last2.Payload["status"] != "failed" ||
		last2.Payload["error_code"] != "desktop_run_lost" {
		t.Fatalf("invalid-state terminal = %s %#v, want failed/desktop_run_lost", last2.Type, last2.Payload)
	}
}

// A run absent from the desktop's reports survives the grace window (measured
// from the last vouch/transition), then is finalized as lost; a vouch before
// expiry restarts the window.
func TestRunReportFinalizesLostRunAfterGrace(t *testing.T) {
	m := NewManager()
	m.ingestChatControl("run-1", startedControl("run-1", "conv-1"))
	t0 := time.Now()
	empty := runsReport(nil, nil)

	m.convStreams.onRuntimeStatus(empty, t0.Add(8*time.Second))
	if activities := m.ActiveConversationActivities(); len(activities) != 1 {
		t.Fatalf("run finalized below grace, activities=%d", len(activities))
	}

	m.convStreams.onRuntimeStatus(empty, t0.Add(16*time.Second))
	if activities := m.ActiveConversationActivities(); len(activities) != 0 {
		t.Fatalf("lost run not finalized after grace, activities=%d", len(activities))
	}
	last := lastEvent(t, m, "conv-1")
	if last.Type != StreamEventRunFinished ||
		last.Payload["status"] != "failed" ||
		last.Payload["error_code"] != "desktop_run_lost" {
		t.Fatalf("lost finish tail = %s %#v, want failed/desktop_run_lost", last.Type, last.Payload)
	}

	// Reported active again before grace expiry: the run survives and the
	// absence window restarts from the vouch.
	m2 := NewManager()
	m2.ingestChatControl("run-2", startedControl("run-2", "conv-2"))
	t1 := time.Now()
	m2.convStreams.onRuntimeStatus(runsReport([]*gatewayv1.ChatRunReport{
		runReport("run-2", "conv-2", "running"),
	}, nil), t1.Add(8*time.Second))
	m2.convStreams.onRuntimeStatus(runsReport(nil, nil), t1.Add(20*time.Second))
	if activities := m2.ActiveConversationActivities(); len(activities) != 1 {
		t.Fatalf("grace window must restart after a vouch, activities=%d", len(activities))
	}
}

// Queued runs belong to the accepted-command startup watchdog; the desktop may
// not know them yet, so reconcile never finalizes them.
func TestRunReportSkipsQueuedRuns(t *testing.T) {
	m := NewManager()
	m.StartChatCommand("run-1", "conv-1", "/workspace", "client-1", []map[string]any{
		{"type": "user_message", "message": "hello"},
	})

	t0 := time.Now()
	m.convStreams.onRuntimeStatus(runsReport(nil, nil), t0)
	m.convStreams.onRuntimeStatus(runsReport(nil, nil), t0.Add(time.Hour))

	activities := m.ActiveConversationActivities()
	if len(activities) != 1 || activities[0].State != RunActivityQueued {
		t.Fatalf("queued run must survive reconcile, activities=%#v", activities)
	}
}

// Liveness is per run: a vouched run keeps streaming while an absent run in
// another conversation is finalized at grace.
func TestRunReportPerConversationLiveness(t *testing.T) {
	m := NewManager()
	m.ingestChatControl("run-a", startedControl("run-a", "conv-a"))
	m.ingestChatControl("run-b", startedControl("run-b", "conv-b"))
	t0 := time.Now()
	vouchA := runsReport([]*gatewayv1.ChatRunReport{
		runReport("run-a", "conv-a", "running"),
	}, nil)

	m.convStreams.onRuntimeStatus(vouchA, t0)
	m.convStreams.onRuntimeStatus(vouchA, t0.Add(16*time.Second))

	activities := m.ActiveConversationActivities()
	if len(activities) != 1 || activities[0].RunID != "run-a" {
		t.Fatalf("vouched run must outlive the lost one, activities=%#v", activities)
	}
	last := lastEvent(t, m, "conv-b")
	if last.Type != StreamEventRunFinished || last.Payload["error_code"] != "desktop_run_lost" {
		t.Fatalf("conv-b tail = %s %#v, want failed/desktop_run_lost", last.Type, last.Payload)
	}
}

// The reaper is per run too: a report vouching only for another conversation
// must not shield a run the desktop stopped vouching for.
func TestReaperSparesOnlyVouchedRuns(t *testing.T) {
	m := NewManager()
	m.convStreams.staleRunTimeout = 10 * time.Millisecond
	m.SetSession(&AgentSession{
		toAgent: make(chan *OutboundEnvelope, 1),
		done:    make(chan struct{}),
		streams: make(map[string]*agentStream),
	})

	m.ingestChatControl("run-1", startedControl("run-1", "conv-1"))
	time.Sleep(20 * time.Millisecond)

	m.ingestChatControl("run-other", startedControl("run-other", "conv-other"))
	m.convStreams.onRuntimeStatus(runsReport([]*gatewayv1.ChatRunReport{
		runReport("run-other", "conv-other", "running"),
	}, nil), time.Now())

	m.convStreams.reap(time.Now())
	activities := m.ActiveConversationActivities()
	if len(activities) != 1 || activities[0].RunID != "run-other" {
		t.Fatalf("unvouched run must be reaped, activities=%#v", activities)
	}
}

// Offline runs are not immortal: past offlineRunTimeout they finalize as
// agent_offline; below it they are kept.
func TestReaperFinalizesRunsAfterOfflineTimeout(t *testing.T) {
	m := NewManager() // no session: isOnline() == false
	m.ingestChatControl("run-1", startedControl("run-1", "conv-1"))
	t0 := time.Now()

	m.convStreams.reap(t0.Add(29 * time.Minute))
	if activities := m.ActiveConversationActivities(); len(activities) != 1 {
		t.Fatalf("run below offline timeout must be kept, activities=%d", len(activities))
	}

	m.convStreams.reap(t0.Add(31 * time.Minute))
	if activities := m.ActiveConversationActivities(); len(activities) != 0 {
		t.Fatalf("run beyond offline timeout must be finalized, activities=%d", len(activities))
	}
	last := lastEvent(t, m, "conv-1")
	if last.Type != StreamEventRunFinished ||
		last.Payload["status"] != "failed" ||
		last.Payload["error_code"] != "agent_offline" {
		t.Fatalf("offline finish tail = %s %#v, want failed/agent_offline", last.Type, last.Payload)
	}
}
