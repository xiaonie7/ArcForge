package chatcmd

import (
	"context"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/handler"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/session"
)

func newCommandTestManager(t *testing.T) (*session.Manager, *session.AgentSession) {
	t.Helper()
	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "test", "session-test")
	sess := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(sess)
	t.Cleanup(func() { sm.ClearSession(sess) })
	return sm, sess
}

func TestChatTimeoutDefaultsAreShortAndDedicated(t *testing.T) {
	t.Parallel()

	if got := PrepareTimeout(nil); got != 2*time.Second {
		t.Fatalf("PrepareTimeout(nil) = %s, want 2s", got)
	}
	if got := DeliveryTimeout(nil); got != 5*time.Second {
		t.Fatalf("DeliveryTimeout(nil) = %s, want 5s", got)
	}
	if got := StartTimeout(nil); got != 5*time.Second {
		t.Fatalf("StartTimeout(nil) = %s, want 5s", got)
	}
	if got := RenderStartTimeout(nil); got != 10*time.Second {
		t.Fatalf("RenderStartTimeout(nil) = %s, want 10s", got)
	}
}

func TestDispatchAcceptedCommandUsesDeliveryTimeout(t *testing.T) {
	t.Parallel()

	sm, _ := newCommandTestManager(t)
	start := sm.StartChatCommand("run-delivery-timeout", "conv-1", "", "client-1", nil)
	cfg := &config.Config{ChatDeliveryTimeout: 30 * time.Millisecond}
	body := handler.ChatRequestBody{
		ConversationID:  "conv-1",
		ClientRequestID: "client-1",
		Message:         "hello",
	}

	startedAt := time.Now()
	DispatchAcceptedCommand(
		context.Background(), cfg, sm, nil, start, body, nil, "trace-delivery-timeout",
	)
	elapsed := time.Since(startedAt)
	if elapsed < 20*time.Millisecond || elapsed > 500*time.Millisecond {
		t.Fatalf("delivery timeout elapsed = %s, want about 30ms", elapsed)
	}

	sub := sm.SubscribeConversationStream("conv-1", 0, "")
	defer sub.Cleanup()
	if len(sub.Events) == 0 {
		t.Fatal("delivery timeout did not terminalize the accepted run")
	}
	last := sub.Events[len(sub.Events)-1]
	if last.Type != session.StreamEventRunFinished ||
		last.Payload["error_code"] != "desktop_runtime_unavailable" {
		t.Fatalf("delivery timeout terminal = %s %#v", last.Type, last.Payload)
	}
}

func TestChatStartupWatchdogUsesShortCombinedWindow(t *testing.T) {
	t.Parallel()

	sm, _ := newCommandTestManager(t)
	sm.StartChatCommand("run-start-timeout", "conv-1", "", "client-1", nil)
	cfg := &config.Config{
		ChatStartTimeout:       15 * time.Millisecond,
		ChatRenderStartTimeout: 20 * time.Millisecond,
	}

	startedAt := time.Now()
	WatchAcceptedCommandStartup(context.Background(), cfg, sm, "run-start-timeout")
	elapsed := time.Since(startedAt)
	if elapsed < 25*time.Millisecond || elapsed > 500*time.Millisecond {
		t.Fatalf("startup watchdog elapsed = %s, want about 35ms", elapsed)
	}

	sub := sm.SubscribeConversationStream("conv-1", 0, "")
	defer sub.Cleanup()
	last := sub.Events[len(sub.Events)-1]
	if last.Type != session.StreamEventRunFinished || last.Payload["error_code"] != "startup_timeout" {
		t.Fatalf("startup watchdog terminal = %s %#v", last.Type, last.Payload)
	}
}

func TestChatStartupWatchdogKeepsForeignCompletionOnCanonicalConversation(t *testing.T) {
	t.Parallel()

	sm, agent := newCommandTestManager(t)
	sm.StartChatCommand("run-conversation-contract", "conv-gateway", "", "client-contract", nil)
	sm.DispatchFromAgentForSession(agent, &gatewayv1.AgentEnvelope{
		RequestId: "run-conversation-contract",
		Payload: &gatewayv1.AgentEnvelope_ChatControl{
			ChatControl: &gatewayv1.ChatControlEvent{
				RequestId:      "run-conversation-contract",
				ConversationId: "conv-desktop",
				Type:           "completed",
				State:          "completed",
				Message:        "已开启新会话。",
			},
		},
	})

	WatchAcceptedCommandStartup(context.Background(), &config.Config{
		ChatStartTimeout:       5 * time.Millisecond,
		ChatRenderStartTimeout: 5 * time.Millisecond,
	}, sm, "run-conversation-contract")

	canonical := sm.SubscribeConversationStream("conv-gateway", 0, "")
	defer canonical.Cleanup()
	terminalCount := 0
	for _, event := range canonical.Events {
		if event.RunID != "run-conversation-contract" || event.Type != session.StreamEventRunFinished {
			continue
		}
		terminalCount++
		if event.ConversationID != "conv-gateway" || event.Payload["status"] != "completed" {
			t.Fatalf("canonical terminal = %#v", event)
		}
		if event.Payload["error_code"] == "startup_timeout" {
			t.Fatalf("watchdog overwrote completed terminal: %#v", event.Payload)
		}
	}
	if terminalCount != 1 {
		t.Fatalf("canonical terminal count = %d, want 1; events = %#v", terminalCount, canonical.Events)
	}

	foreign := sm.SubscribeConversationStream("conv-desktop", 0, "")
	defer foreign.Cleanup()
	if len(foreign.Events) != 0 {
		t.Fatalf("foreign conversation received events: %#v", foreign.Events)
	}
	if !sm.ChatCommandSettled("run-conversation-contract") {
		t.Fatal("completed command must be settled")
	}
	lookup, ok := sm.LookupChatCommand("client-contract")
	if !ok || lookup.ConversationID != "conv-gateway" || lookup.Terminal == nil || lookup.Terminal.Status != "completed" {
		t.Fatalf("canonical command lookup = %#v, ok = %v", lookup, ok)
	}
}

func TestTrustedOriginRequestBindingMatchesCommandEnvelope(t *testing.T) {
	origin := &gatewayv1.TrustedOrigin{GatewayRequestId: "channel-run-1"}
	envelope := buildCommandEnvelope(
		"channel-run-1",
		"chat.submit",
		handler.ChatRequestBody{
			ConversationID:  "conversation-1",
			ClientRequestID: "client-1",
			Message:         "hello",
		},
		nil,
		origin,
	)
	if envelope.GetRequestId() != origin.GetGatewayRequestId() {
		t.Fatalf("envelope request id = %q, origin request id = %q", envelope.GetRequestId(), origin.GetGatewayRequestId())
	}
}
