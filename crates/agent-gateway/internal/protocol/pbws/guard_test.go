package pbws

import (
	"strings"
	"testing"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func TestVetHistoryArchiveAllowsOnlyKnownCommandsWithObjectArguments(t *testing.T) {
	for _, command := range []string{
		"query", "facets", "snapshot", "delete", "archive", "unarchive",
		"policy_get", "policy_set", "metadata", "editing",
	} {
		t.Run(command, func(t *testing.T) {
			req := &gatewayv1.HistoryArchiveRequest{Command: command, ArgsJson: `{"id":"conversation-1"}`}
			if err := vetHistoryArchive(req); err != nil {
				t.Fatalf("vetHistoryArchive(%q): %v", command, err)
			}
		})
	}

	empty := &gatewayv1.HistoryArchiveRequest{Command: "query"}
	if err := vetHistoryArchive(empty); err != nil {
		t.Fatalf("empty arguments should normalize to an object: %v", err)
	}
	if empty.GetArgsJson() != "{}" {
		t.Fatalf("normalized args = %q, want {}", empty.GetArgsJson())
	}
}

func TestVetHistoryArchiveRejectsUnknownMalformedAndOversizedRequests(t *testing.T) {
	tests := []struct {
		name string
		req  *gatewayv1.HistoryArchiveRequest
	}{
		{name: "nil request", req: nil},
		{name: "unknown command", req: &gatewayv1.HistoryArchiveRequest{Command: "execute", ArgsJson: "{}"}},
		{name: "padded command", req: &gatewayv1.HistoryArchiveRequest{Command: " query ", ArgsJson: "{}"}},
		{name: "array arguments", req: &gatewayv1.HistoryArchiveRequest{Command: "query", ArgsJson: "[]"}},
		{name: "invalid json", req: &gatewayv1.HistoryArchiveRequest{Command: "query", ArgsJson: "{"}},
		{
			name: "oversized arguments",
			req: &gatewayv1.HistoryArchiveRequest{
				Command:  "query",
				ArgsJson: `{"value":"` + strings.Repeat("x", maxHistoryArchiveArgsBytes) + `"}`,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := vetHistoryArchive(tt.req); err == nil {
				t.Fatal("expected request to be rejected")
			}
		})
	}
}
