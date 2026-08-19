package pbws

import (
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
	"github.com/liveagent/agent-gateway/internal/transport/wscore"
	"google.golang.org/protobuf/proto"
)

func TestRecoveringCommandWatchOutlivesDurableRecoveryWindow(t *testing.T) {
	cfg := &config.Config{
		ChatStartTimeout:       5 * time.Second,
		ChatRenderStartTimeout: 10 * time.Second,
	}
	if got := chatCommandWatchTimeout(cfg, false); got != 15*time.Second {
		t.Fatalf("normal watch timeout = %s", got)
	}
	if got := chatCommandWatchTimeout(cfg, true); got != 45*time.Second {
		t.Fatalf("recovering watch timeout = %s", got)
	}
}

func TestBrowserDedupedTerminalReplayIncludesCanonicalOutcome(t *testing.T) {
	tests := []struct {
		name          string
		terminal      session.ChatCommandTerminal
		wantPhase     string
		wantErrorCode string
		wantMessage   string
	}{
		{
			name: "completed final text",
			terminal: session.ChatCommandTerminal{
				Status:      "completed",
				Message:     "ignored completion marker",
				PayloadJSON: `{"final_text":"durable answer"}`,
			},
			wantPhase:   "completed",
			wantMessage: "durable answer",
		},
		{
			name: "restart unknown",
			terminal: session.ChatCommandTerminal{
				Status:      "unknown",
				ErrorCode:   "gateway_restart",
				Message:     "Gateway restarted before completion.",
				PayloadJSON: `{}`,
			},
			wantPhase:     "unknown",
			wantErrorCode: "gateway_restart",
			wantMessage:   "Gateway restarted before completion.",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			core := wscore.NewConn(nil, wscore.Config{QueueSize: 4, CtrlQueueSize: 4})
			c := &browserConn{core: core}
			c.respondChatCommandDeduped("request-1", "client-1", session.ChatCommandStart{
				RunID:          "run-1",
				ConversationID: "conversation-1",
				AcceptedSeq:    9,
				Deduped:        true,
				Terminal:       &tt.terminal,
			})

			acceptedFrame := <-core.CtrlOutbox
			if acceptedFrame.Kind != "chat_accepted" {
				t.Fatalf("first frame kind = %q, want chat_accepted", acceptedFrame.Kind)
			}
			var accepted gatewayv2.WebServerFrame
			if err := proto.Unmarshal(acceptedFrame.Data, &accepted); err != nil {
				t.Fatalf("decode accepted frame: %v", err)
			}
			if got := accepted.GetChatAccepted(); got == nil || !got.GetDeduped() || got.GetRunId() != "run-1" {
				t.Fatalf("accepted payload = %#v", got)
			}

			terminalFrame := <-core.CtrlOutbox
			if terminalFrame.Kind != "chat_command_update" {
				t.Fatalf("second frame kind = %q, want chat_command_update", terminalFrame.Kind)
			}
			var replay gatewayv2.WebServerFrame
			if err := proto.Unmarshal(terminalFrame.Data, &replay); err != nil {
				t.Fatalf("decode terminal replay: %v", err)
			}
			update := replay.GetChatCommandUpdate()
			if update == nil {
				t.Fatal("terminal replay payload is missing")
			}
			if update.GetRunId() != "run-1" || update.GetClientRequestId() != "client-1" || update.GetConversationId() != "conversation-1" {
				t.Fatalf("terminal replay identity = %#v", update)
			}
			if update.GetPhase() != tt.wantPhase || update.GetErrorCode() != tt.wantErrorCode || update.GetMessage() != tt.wantMessage {
				t.Fatalf("terminal replay = %#v", update)
			}
		})
	}
}
