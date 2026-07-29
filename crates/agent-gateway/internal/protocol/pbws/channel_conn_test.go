package pbws

import (
	"strings"
	"testing"

	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/handler"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/transport/wscore"
	"google.golang.org/protobuf/proto"
)

func TestValidateChannelInboundAllowsSingleWithoutChatID(t *testing.T) {
	inbound := &gatewayv2.ChannelInboundMessage{
		ExternalMessageId: "message-1",
		ExternalUserId:    "user-1",
		ChatType:          "single",
		Text:              "hello",
		ChannelSessionId:  "session-1",
	}
	if err := validateChannelInbound(inbound); err != nil {
		t.Fatalf("single message rejected: %v", err)
	}
}

func TestValidateChannelInboundRequiresGroupChatID(t *testing.T) {
	inbound := &gatewayv2.ChannelInboundMessage{
		ExternalMessageId: "message-1",
		ExternalUserId:    "user-1",
		ChatType:          "group",
		Text:              "hello",
		ChannelSessionId:  "session-1",
	}
	if err := validateChannelInbound(inbound); err == nil || !strings.Contains(err.Error(), "chat_id") {
		t.Fatalf("expected missing chat_id error, got %v", err)
	}
}

func TestValidateChannelInboundRejectsInvalidAndOversizedValues(t *testing.T) {
	invalid := &gatewayv2.ChannelInboundMessage{
		ExternalMessageId: "message-1",
		ExternalUserId:    "user\n1",
		ChatType:          "single",
		Text:              "hello",
		ChannelSessionId:  "session-1",
	}
	if err := validateChannelInbound(invalid); err == nil || !strings.Contains(err.Error(), "invalid characters") {
		t.Fatalf("expected invalid character error, got %v", err)
	}

	oversized := &gatewayv2.ChannelInboundMessage{
		ExternalMessageId: "message-1",
		ExternalUserId:    "user-1",
		ChatType:          "single",
		Text:              strings.Repeat("x", channelMaxTextSize+1),
		ChannelSessionId:  "session-1",
	}
	if err := validateChannelInbound(oversized); err == nil || !strings.Contains(err.Error(), "text is too long") {
		t.Fatalf("expected oversized text error, got %v", err)
	}
}

func TestChannelConversationIDIsolatedByPrincipalAndChat(t *testing.T) {
	binding := channelBinding{tenantID: "tenant-1", botID: "bot-1", connectorID: "connector-1"}
	singleAlice := &gatewayv2.ChannelInboundMessage{ExternalUserId: "alice", ChatType: "single", ChatId: "ignored", ChannelSessionId: "session-1"}
	singleAliceAgain := &gatewayv2.ChannelInboundMessage{ExternalUserId: "alice", ChatType: "single", ChatId: "another", ChannelSessionId: "session-1"}
	singleAliceNewSession := &gatewayv2.ChannelInboundMessage{ExternalUserId: "alice", ChatType: "single", ChannelSessionId: "session-2"}
	singleBob := &gatewayv2.ChannelInboundMessage{ExternalUserId: "bob", ChatType: "single", ChannelSessionId: "session-1"}
	groupAlice := &gatewayv2.ChannelInboundMessage{ExternalUserId: "alice", ChatType: "group", ChatId: "room-1", ChannelSessionId: "session-1"}
	groupAliceOtherRoom := &gatewayv2.ChannelInboundMessage{ExternalUserId: "alice", ChatType: "group", ChatId: "room-2", ChannelSessionId: "session-1"}
	groupAliceDirectRoom := &gatewayv2.ChannelInboundMessage{ExternalUserId: "alice", ChatType: "group", ChatId: "direct", ChannelSessionId: "session-1"}

	if got, want := channelConversationID(binding, singleAlice), channelConversationID(binding, singleAliceAgain); got != want {
		t.Fatalf("single chat id changed conversation: %q != %q", got, want)
	}
	if channelConversationID(binding, singleAlice) == channelConversationID(binding, singleBob) {
		t.Fatal("different single-chat users share a conversation")
	}
	if channelConversationID(binding, singleAlice) == channelConversationID(binding, singleAliceNewSession) {
		t.Fatal("new channel sessions reuse the previous conversation")
	}
	if channelConversationID(binding, groupAlice) == channelConversationID(binding, groupAliceOtherRoom) {
		t.Fatal("different group chats share a conversation")
	}
	if channelConversationID(binding, singleAlice) == channelConversationID(binding, groupAlice) {
		t.Fatal("single and group chats share a conversation")
	}
	if channelConversationID(binding, singleAlice) == channelConversationID(binding, groupAliceDirectRoom) {
		t.Fatal("group chat named direct collided with a direct conversation")
	}
	const expected = "wecom:420b00f43535847a98305a90fe1222fde82f2a3a9a397f26bf7ed4a2cb974b9f"
	if got := channelConversationID(binding, singleAlice); got != expected {
		t.Fatalf("conversation id contract changed: got %q want %q", got, expected)
	}
	contractUser := &gatewayv2.ChannelInboundMessage{ExternalUserId: "user-1", ChatType: "single", ChannelSessionId: "session-1"}
	const crossRuntimeExpected = "wecom:7625effa3c6fbdc88635b366952b2c80410b5a62dcc5a7aecb37e4c7cb6d0ec2"
	if got := channelConversationID(binding, contractUser); got != crossRuntimeExpected {
		t.Fatalf("cross-runtime conversation id changed: got %q want %q", got, crossRuntimeExpected)
	}
}

func TestValidateChannelInboundCommandsUseRestrictedControlFields(t *testing.T) {
	valid := &gatewayv2.ChannelInboundMessage{
		ExternalMessageId: "message-1",
		ExternalUserId:    "user-1",
		ChatType:          "single",
		Command:           "compact",
		ChannelSessionId:  "session-1",
	}
	if err := validateChannelInbound(valid); err != nil {
		t.Fatalf("valid compact command rejected: %v", err)
	}

	withText := proto.Clone(valid).(*gatewayv2.ChannelInboundMessage)
	withText.Text = "/compact"
	if err := validateChannelInbound(withText); err == nil || !strings.Contains(err.Error(), "must not include") {
		t.Fatalf("command text was accepted: %v", err)
	}

	unsupported := proto.Clone(valid).(*gatewayv2.ChannelInboundMessage)
	unsupported.Command = "shell"
	if err := validateChannelInbound(unsupported); err == nil || !strings.Contains(err.Error(), "unsupported") {
		t.Fatalf("unsupported command was accepted: %v", err)
	}

	connectorLocal := proto.Clone(valid).(*gatewayv2.ChannelInboundMessage)
	connectorLocal.Command = "help"
	if err := validateChannelInbound(connectorLocal); err == nil || !strings.Contains(err.Error(), "unsupported") {
		t.Fatalf("connector-local help command reached the gateway: %v", err)
	}

	missingSession := proto.Clone(valid).(*gatewayv2.ChannelInboundMessage)
	missingSession.ChannelSessionId = ""
	if err := validateChannelInbound(missingSession); err == nil || !strings.Contains(err.Error(), "channel_session_id") {
		t.Fatalf("missing channel session was accepted: %v", err)
	}

	invalidSession := proto.Clone(valid).(*gatewayv2.ChannelInboundMessage)
	invalidSession.ChannelSessionId = "session/escape"
	if err := validateChannelInbound(invalidSession); err == nil || !strings.Contains(err.Error(), "invalid characters") {
		t.Fatalf("invalid channel session was accepted: %v", err)
	}
}

func TestChannelControlCommandsDoNotSeedUserMessages(t *testing.T) {
	body := handler.ChatRequestBody{Message: "/compact"}
	if seeded := channelSeededPayloads("compact", body); len(seeded) != 0 {
		t.Fatalf("control command seeded transcript payloads: %#v", seeded)
	}
	if seeded := channelSeededPayloads("", body); len(seeded) != 1 || seeded[0]["type"] != "user_message" {
		t.Fatalf("ordinary message was not seeded exactly once: %#v", seeded)
	}
}

func TestChannelChatRequestBodyDefaultsToAutoQueue(t *testing.T) {
	inbound := &gatewayv2.ChannelInboundMessage{Text: "  hello from WeCom  "}
	body := channelChatRequestBody("conversation-1", "client-request-1", inbound)

	if body.ConversationID != "conversation-1" || body.ClientRequestID != "client-request-1" {
		t.Fatalf("channel chat request identity = %#v", body)
	}
	if body.Message != "hello from WeCom" {
		t.Fatalf("channel chat request message = %q", body.Message)
	}
	if body.QueuePolicy != "auto" {
		t.Fatalf("channel chat request queue policy = %q, want auto", body.QueuePolicy)
	}
}

func TestChannelVisibleTokenTextFiltersInternalCompactionCheckpoints(t *testing.T) {
	if text, ok := channelVisibleTokenText(map[string]any{"text": "answer"}); !ok || text != "answer" {
		t.Fatalf("visible assistant token was filtered: %q %v", text, ok)
	}
	for _, payload := range []map[string]any{
		{"text": "internal summary", "checkpoint": map[string]any{"summaryId": "summary-1"}},
		{"text": "internal summary", "api": "arcforge-compaction"},
		{"text": "  "},
	} {
		if text, ok := channelVisibleTokenText(payload); ok || text != "" {
			t.Fatalf("internal token was exposed: %#v => %q %v", payload, text, ok)
		}
	}
}

func TestChannelRunDeltaAndFinalShareOrderedResponseQueue(t *testing.T) {
	core := wscore.NewConn(nil, wscore.Config{QueueSize: 2, CtrlQueueSize: 2})
	c := &channelConn{core: core}

	if err := c.sendRunDelta("request-1", "run-1", "conversation-1", 7, "answer"); err != nil {
		t.Fatalf("sendRunDelta() = %v", err)
	}
	if err := c.sendRunFinal("request-1", "run-1", "conversation-1", "completed", "", ""); err != nil {
		t.Fatalf("sendRunFinal() = %v", err)
	}
	if got := len(core.CtrlOutbox); got != 0 {
		t.Fatalf("control queue depth = %d, want 0", got)
	}

	first := <-core.Outbox
	second := <-core.Outbox
	if first.Class != wscore.FrameResponse || first.Kind != "channel_delta" {
		t.Fatalf("first frame = %#v, want response delta", first)
	}
	if second.Class != wscore.FrameResponse || second.Kind != "channel_final" {
		t.Fatalf("second frame = %#v, want response final", second)
	}

	var delta gatewayv2.ChannelServerFrame
	if err := proto.Unmarshal(first.Data, &delta); err != nil {
		t.Fatalf("decode delta: %v", err)
	}
	var final gatewayv2.ChannelServerFrame
	if err := proto.Unmarshal(second.Data, &final); err != nil {
		t.Fatalf("decode final: %v", err)
	}
	if delta.GetDelta().GetText() != "answer" || final.GetFinal().GetStatus() != "completed" {
		t.Fatalf("ordered frames = %#v then %#v", delta.GetDelta(), final.GetFinal())
	}
}

func TestChannelRequestIDIncludesBinding(t *testing.T) {
	inbound := &gatewayv2.ChannelInboundMessage{
		ExternalMessageId: "message-1",
		ExternalUserId:    "alice",
		ChatType:          "single",
	}
	first := channelRequestID(channelBinding{tenantID: "tenant-1", botID: "bot-1", connectorID: "connector-1"}, inbound)
	second := channelRequestID(channelBinding{tenantID: "tenant-2", botID: "bot-1", connectorID: "connector-1"}, inbound)
	if first == second {
		t.Fatal("same external message id crossed tenant bindings")
	}

	otherUser := proto.Clone(inbound).(*gatewayv2.ChannelInboundMessage)
	otherUser.ExternalUserId = "bob"
	if first == channelRequestID(channelBinding{tenantID: "tenant-1", botID: "bot-1", connectorID: "connector-1"}, otherUser) {
		t.Fatal("same external message id crossed user identities")
	}

	group := proto.Clone(inbound).(*gatewayv2.ChannelInboundMessage)
	group.ChatType = "group"
	group.ChatId = "room-1"
	otherGroup := proto.Clone(group).(*gatewayv2.ChannelInboundMessage)
	otherGroup.ChatId = "room-2"
	if channelRequestID(channelBinding{tenantID: "tenant-1", botID: "bot-1", connectorID: "connector-1"}, group) ==
		channelRequestID(channelBinding{tenantID: "tenant-1", botID: "bot-1", connectorID: "connector-1"}, otherGroup) {
		t.Fatal("same external message id crossed group chats")
	}
}

func TestChannelTrustedOriginUsesDesktopRunIDForRequestBinding(t *testing.T) {
	inbound := &gatewayv2.ChannelInboundMessage{
		ExternalMessageId: "message-1",
		ExternalUserId:    "alice",
		ChatType:          "single",
		ChannelSessionId:  "session-1",
	}
	origin := channelTrustedOrigin(
		channelBinding{tenantID: "tenant-1", botID: "bot-1", connectorID: "connector-1"},
		inbound,
		"channel-run-1",
		"",
	)
	if origin.GetGatewayRequestId() != "channel-run-1" {
		t.Fatalf("origin request binding = %q, want desktop run id", origin.GetGatewayRequestId())
	}
}

func TestVetChannelHelloBindsConnector(t *testing.T) {
	c := &channelConn{cfg: &config.Config{
		ChannelToken:       "channel-token",
		ChannelTenantID:    "tenant-1",
		ChannelBotID:       "bot-1",
		ChannelConnectorID: "connector-1",
	}}
	valid := &gatewayv2.ClientHello{
		ProtocolVersion: 2,
		Role:            gatewayv2.ClientRole_CLIENT_ROLE_CHANNEL,
		Token:           "channel-token",
		ChannelTenantId: "tenant-1",
		ChannelBotId:    "bot-1",
		ConnectorId:     "connector-1",
	}
	verdict, binding := c.vetChannelHello(valid)
	if !verdict.ok || binding.tenantID != "tenant-1" || binding.botID != "bot-1" {
		t.Fatalf("valid hello rejected: %+v %+v", verdict, binding)
	}

	wrong := proto.Clone(valid).(*gatewayv2.ClientHello)
	wrong.ChannelBotId = "other-bot"
	verdict, _ = c.vetChannelHello(wrong)
	if verdict.ok || !strings.Contains(verdict.message, "unexpected channel bot") {
		t.Fatalf("wrong bot accepted: %+v", verdict)
	}

	wrong = proto.Clone(valid).(*gatewayv2.ClientHello)
	wrong.Token = "wrong-token"
	verdict, _ = c.vetChannelHello(wrong)
	if verdict.ok || !strings.Contains(verdict.message, "unauthorized") {
		t.Fatalf("wrong token accepted: %+v", verdict)
	}

	wrong = proto.Clone(valid).(*gatewayv2.ClientHello)
	wrong.ChannelTenantId = ""
	verdict, _ = c.vetChannelHello(wrong)
	if verdict.ok || !strings.Contains(verdict.message, "tenant_id") {
		t.Fatalf("empty tenant accepted: %+v", verdict)
	}
}
