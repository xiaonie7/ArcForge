package pbws

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/handler"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
	"github.com/liveagent/agent-gateway/internal/transport/wscore"
	"google.golang.org/protobuf/proto"
)

func validChannelInputToolEvent(deadline time.Time) *session.ConversationEvent {
	return &session.ConversationEvent{
		ConversationID: "conversation-1",
		RunID:          "run-1",
		Seq:            7,
		Type:           "tool_call",
		Payload: map[string]any{
			"id":   "tool-call-1",
			"name": "AskUserQuestion",
			"arguments": map[string]any{
				"__askUserQuestionDeadlineAt": float64(deadline.UnixMilli()),
				"questions": []any{
					map[string]any{
						"id":     "business-segment",
						"header": "口径",
						"prompt": "请选择事业群口径",
						"options": []any{
							map[string]any{"label": "业务板块事业群", "description": "按业务板块统计", "recommended": true},
							map[string]any{"label": "组织事业群", "description": "按组织架构统计"},
						},
					},
				},
			},
		},
	}
}

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

func TestValidateChannelInboundAllowsFileOnlyAndEnforcesFileLimits(t *testing.T) {
	base := &gatewayv2.ChannelInboundMessage{
		ExternalMessageId: "message-1",
		ExternalUserId:    "user-1",
		ChatType:          "single",
		ChannelSessionId:  "session-1",
		Files: []*gatewayv2.ChannelInboundFile{{
			FileName: "report.csv",
			MimeType: "text/csv",
			Content:  []byte("a,b\n1,2\n"),
		}},
	}
	if err := validateChannelInbound(base); err != nil {
		t.Fatalf("file-only message rejected: %v", err)
	}

	command := proto.Clone(base).(*gatewayv2.ChannelInboundMessage)
	command.Command = "compact"
	if err := validateChannelInbound(command); err == nil || !strings.Contains(err.Error(), "must not include") {
		t.Fatalf("command files were accepted: %v", err)
	}

	tooMany := proto.Clone(base).(*gatewayv2.ChannelInboundMessage)
	tooMany.Files = make([]*gatewayv2.ChannelInboundFile, channelMaxFiles+1)
	for i := range tooMany.Files {
		tooMany.Files[i] = &gatewayv2.ChannelInboundFile{FileName: "file.txt"}
	}
	if err := validateChannelInbound(tooMany); err == nil || !strings.Contains(err.Error(), "too many") {
		t.Fatalf("too many files were accepted: %v", err)
	}

	oversized := proto.Clone(base).(*gatewayv2.ChannelInboundMessage)
	oversized.Files[0].Content = make([]byte, channelMaxFileBytes+1)
	if err := validateChannelInbound(oversized); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("oversized file was accepted: %v", err)
	}

	halfPlusOne := make([]byte, channelMaxFilesBytes/2+1)
	overTotal := proto.Clone(base).(*gatewayv2.ChannelInboundMessage)
	overTotal.Files = []*gatewayv2.ChannelInboundFile{
		{FileName: "first.bin", Content: halfPlusOne},
		{FileName: "second.bin", Content: halfPlusOne},
	}
	if err := validateChannelInbound(overTotal); err == nil || !strings.Contains(err.Error(), "files are too large") {
		t.Fatalf("oversized file total was accepted: %v", err)
	}
}

func TestChannelConversationIDIsolatedByPrincipalAndChat(t *testing.T) {
	binding := channelBinding{tenantID: "tenant-1", botID: "bot-1", connectorID: "connector-1"}
	otherConnector := channelBinding{tenantID: "tenant-1", botID: "bot-1", connectorID: "connector-2"}
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
	if channelConversationID(binding, singleAlice) == channelConversationID(otherConnector, singleAlice) {
		t.Fatal("different connector installations share a conversation")
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
	const expected = "wecom:c481380b4172c3023333dce0a3a91f84df4c265aeab76d7fb7e45c66a808fd52"
	if got := channelConversationID(binding, singleAlice); got != expected {
		t.Fatalf("conversation id contract changed: got %q want %q", got, expected)
	}
	contractUser := &gatewayv2.ChannelInboundMessage{ExternalUserId: "user-1", ChatType: "single", ChannelSessionId: "session-1"}
	const crossRuntimeExpected = "wecom:566289c1463d9ec881a957649aeed9a84153fd78d0d5b72f37497ba988b64409"
	if got := channelConversationID(binding, contractUser); got != crossRuntimeExpected {
		t.Fatalf("cross-runtime conversation id changed: got %q want %q", got, crossRuntimeExpected)
	}
}

func TestChannelInstallationIDMatchesCrossRuntimeJSONContract(t *testing.T) {
	binding := channelBinding{
		tenantID:    `租户\one`,
		botID:       `机器人<&`,
		connectorID: `connector"one`,
	}
	const expected = `{"bot_id":"机器人<&","channel":"wecom","connector_id":"connector\"one","tenant_id":"租户\\one"}`
	if got := channelInstallationID(binding); got != expected {
		t.Fatalf("installation id contract changed: got %q want %q", got, expected)
	}

	separators := channelBinding{
		tenantID:    "租户\u2028分隔\u2029尾",
		botID:       `机器人\u2028<&`,
		connectorID: "connector-1",
	}
	separatorExpected := "{\"bot_id\":\"机器人\\\\u2028<&\",\"channel\":\"wecom\",\"connector_id\":\"connector-1\",\"tenant_id\":\"租户\u2028分隔\u2029尾\"}"
	if got := channelInstallationID(separators); got != separatorExpected {
		t.Fatalf("installation separator contract changed: got %q want %q", got, separatorExpected)
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
	uploadedFiles := []handler.ChatUploadedFileBody{{
		RelativePath: "uploads/report.csv",
		AbsolutePath: "C:/staging/report.csv",
		FileName:     "report.csv",
		Kind:         "text",
		SizeBytes:    12,
	}}
	body := channelChatRequestBody("conversation-1", "client-request-1", inbound, uploadedFiles)

	if body.ConversationID != "conversation-1" || body.ClientRequestID != "client-request-1" {
		t.Fatalf("channel chat request identity = %#v", body)
	}
	if body.Message != "hello from WeCom" {
		t.Fatalf("channel chat request message = %q", body.Message)
	}
	if body.QueuePolicy != "auto" {
		t.Fatalf("channel chat request queue policy = %q, want auto", body.QueuePolicy)
	}
	if len(body.UploadedFiles) != 1 || body.UploadedFiles[0].FileName != "report.csv" {
		t.Fatalf("channel chat request uploads = %#v", body.UploadedFiles)
	}
}

func TestImportInboundFilesStagesThroughDesktopWithEmptyWorkdir(t *testing.T) {
	manager := session.NewManager()
	agent := session.NewAgentSession(session.AuthSnapshot{SessionID: "session-1"})
	manager.SetSession(agent)
	t.Cleanup(func() { manager.ClearSession(agent) })
	c := &channelConn{sm: manager}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	type result struct {
		files []handler.ChatUploadedFileBody
		err   error
	}
	resultCh := make(chan result, 1)
	go func() {
		files, err := c.importInboundFiles(ctx, []*gatewayv2.ChannelInboundFile{{
			FileName: "report.csv",
			MimeType: "text/csv",
			Content:  []byte("a,b\n1,2\n"),
		}})
		resultCh <- result{files: files, err: err}
	}()

	var outbound *session.OutboundEnvelope
	select {
	case outbound = <-agent.Outbound():
	case <-ctx.Done():
		t.Fatal("timed out waiting for upload request")
	}
	upload := outbound.GetUploadReadableFiles()
	if upload == nil || upload.GetWorkdir() != "" || len(upload.GetFiles()) != 1 {
		t.Fatalf("upload request = %#v", upload)
	}
	if got := upload.GetFiles()[0]; got.GetFileName() != "report.csv" || got.GetMimeType() != "text/csv" || string(got.GetContent()) != "a,b\n1,2\n" {
		t.Fatalf("uploaded file = %#v", got)
	}
	outbound.Ack(nil)
	manager.DispatchFromAgentForSession(agent, &gatewayv1.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Payload: &gatewayv1.AgentEnvelope_UploadReadableFilesResp{
			UploadReadableFilesResp: &gatewayv1.UploadReadableFilesResponse{Files: []*gatewayv1.ChatUploadedFile{{
				RelativePath: "uploads/report.csv",
				AbsolutePath: "C:/staging/report.csv",
				FileName:     "report.csv",
				Kind:         "text",
				SizeBytes:    8,
			}}},
		},
	})

	select {
	case got := <-resultCh:
		if got.err != nil {
			t.Fatalf("importInboundFiles() = %v", got.err)
		}
		if len(got.files) != 1 || got.files[0].RelativePath != "uploads/report.csv" {
			t.Fatalf("imported files = %#v", got.files)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for imported files")
	}
}

func TestChannelInputRequestAllowsOnlyCompleteAskUserQuestionAndAliasesIDs(t *testing.T) {
	now := time.Now()
	event := validChannelInputToolEvent(now.Add(3 * time.Minute))
	request, interaction, ok := channelInputRequestFromToolCall("request-1", event, now)
	if !ok || request == nil || interaction == nil {
		t.Fatal("valid AskUserQuestion was rejected")
	}
	if request.GetInteractionId() == "" || request.GetRunId() != "run-1" ||
		request.GetConversationId() != "conversation-1" || request.GetSeq() != 7 {
		t.Fatalf("input request identity = %#v", request)
	}
	if len(request.GetQuestions()) != 1 || request.GetQuestions()[0].GetId() != "q1" {
		t.Fatalf("aliased questions = %#v", request.GetQuestions())
	}
	options := request.GetQuestions()[0].GetOptions()
	if len(options) != 2 || options[0].GetId() != "o1" || options[1].GetId() != "o2" {
		t.Fatalf("aliased options = %#v", options)
	}
	if interaction.questions[0].questionID != "business-segment" ||
		interaction.questions[0].options["o2"].selectedLabel != "组织事业群" {
		t.Fatalf("private answer mapping = %#v", interaction.questions)
	}

	wrongTool := validChannelInputToolEvent(now.Add(3 * time.Minute))
	wrongTool.Payload["name"] = "Bash"
	if request, interaction, ok := channelInputRequestFromToolCall("request-1", wrongTool, now); ok || request != nil || interaction != nil {
		t.Fatalf("non-allowlisted tool exposed: %#v %#v", request, interaction)
	}

	partial := validChannelInputToolEvent(now.Add(3 * time.Minute))
	arguments := partial.Payload["arguments"].(map[string]any)
	questions := arguments["questions"].([]any)
	questions[0].(map[string]any)["options"] = []any{map[string]any{"label": "only"}}
	if request, interaction, ok := channelInputRequestFromToolCall("request-1", partial, now); ok || request != nil || interaction != nil {
		t.Fatalf("incomplete question exposed: %#v %#v", request, interaction)
	}

	expired := validChannelInputToolEvent(now.Add(-time.Second))
	if request, interaction, ok := channelInputRequestFromToolCall("request-1", expired, now); ok || request != nil || interaction != nil {
		t.Fatalf("expired question exposed: %#v %#v", request, interaction)
	}
}

func TestChannelInputAnswerRoundTripsThroughDesktopAndResolvesOnce(t *testing.T) {
	manager := session.NewManager()
	agent := session.NewAgentSession(session.AuthSnapshot{SessionID: "session-1"})
	manager.SetSession(agent)
	t.Cleanup(func() { manager.ClearSession(agent) })
	core := wscore.NewConn(nil, wscore.Config{QueueSize: 8, CtrlQueueSize: 2})
	c := &channelConn{sm: manager, core: core}
	event := validChannelInputToolEvent(time.Now().Add(3 * time.Minute))
	c.forwardInputRequest("run-request", event)

	requestFrame := <-core.Outbox
	var decodedRequest gatewayv2.ChannelServerFrame
	if err := proto.Unmarshal(requestFrame.Data, &decodedRequest); err != nil {
		t.Fatalf("decode input request: %v", err)
	}
	inputRequest := decodedRequest.GetInputRequest()
	if inputRequest == nil || inputRequest.GetInteractionId() == "" {
		t.Fatalf("input request frame = %#v", decodedRequest.GetPayload())
	}

	answer := &gatewayv2.ChannelInputAnswer{
		InteractionId: inputRequest.GetInteractionId(),
		Selections: []*gatewayv2.ChannelInputAnswerSelection{{
			QuestionId: "q1",
			OptionId:   "o2",
		}},
	}
	done := make(chan struct{})
	go func() {
		c.handleInputAnswer("answer-request", answer)
		close(done)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var outbound *session.OutboundEnvelope
	select {
	case outbound = <-agent.Outbound():
	case <-ctx.Done():
		t.Fatal("timed out waiting for desktop tool_answer")
	}
	queueRequest := outbound.GetChatQueue()
	if queueRequest == nil || queueRequest.GetAction() != "tool_answer" ||
		queueRequest.GetConversationId() != "conversation-1" || queueRequest.GetItemId() != "tool-call-1" {
		t.Fatalf("desktop queue request = %#v", queueRequest)
	}
	var translated []channelDesktopInputAnswer
	if err := json.Unmarshal([]byte(queueRequest.GetRequestJson()), &translated); err != nil {
		t.Fatalf("decode translated answer: %v", err)
	}
	if len(translated) != 1 || translated[0].QuestionID != "business-segment" || translated[0].SelectedLabel != "组织事业群" {
		t.Fatalf("translated answer = %#v", translated)
	}
	outbound.Ack(nil)
	manager.DispatchFromAgentForSession(agent, &gatewayv1.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Payload: &gatewayv1.AgentEnvelope_ChatQueueResp{
			ChatQueueResp: &gatewayv1.ChatQueueResponse{Accepted: true},
		},
	})
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("timed out waiting for input answer result")
	}

	answerFrame := <-core.Outbox
	var decodedAnswer gatewayv2.ChannelServerFrame
	if err := proto.Unmarshal(answerFrame.Data, &decodedAnswer); err != nil {
		t.Fatalf("decode answer result: %v", err)
	}
	if got := decodedAnswer.GetInputAnswerResult(); got == nil || !got.GetAccepted() || got.GetStatus() != "accepted" {
		t.Fatalf("input answer result = %#v", got)
	}

	resultEvent := &session.ConversationEvent{
		ConversationID: event.ConversationID,
		RunID:          event.RunID,
		Seq:            8,
		Type:           "tool_result",
		Payload: map[string]any{
			"id":      "tool-call-1",
			"name":    "AskUserQuestion",
			"isError": false,
			"details": map[string]any{
				"kind": "ask_user_question",
				"answers": []any{map[string]any{
					"questionId":    "business-segment",
					"selectedLabel": "组织事业群",
				}},
			},
		},
	}
	c.resolveInputToolEvent(resultEvent)
	resolvedFrame := <-core.Outbox
	var decodedResolved gatewayv2.ChannelServerFrame
	if err := proto.Unmarshal(resolvedFrame.Data, &decodedResolved); err != nil {
		t.Fatalf("decode resolved: %v", err)
	}
	resolved := decodedResolved.GetInputResolved()
	if resolved == nil || resolved.GetStatus() != "answered" || len(resolved.GetSelections()) != 1 ||
		resolved.GetSelections()[0].GetQuestionId() != "q1" || resolved.GetSelections()[0].GetOptionId() != "o2" {
		t.Fatalf("input resolved = %#v", resolved)
	}

	c.handleInputAnswer("duplicate-request", answer)
	duplicateFrame := <-core.Outbox
	var decodedDuplicate gatewayv2.ChannelServerFrame
	if err := proto.Unmarshal(duplicateFrame.Data, &decodedDuplicate); err != nil {
		t.Fatalf("decode duplicate result: %v", err)
	}
	if got := decodedDuplicate.GetInputAnswerResult(); got == nil || got.GetAccepted() || got.GetStatus() != "already_resolved" {
		t.Fatalf("duplicate answer result = %#v", got)
	}
}

func TestChannelInputAnswerRejectsInvalidSelectionAndRunFinishClearsInteraction(t *testing.T) {
	core := wscore.NewConn(nil, wscore.Config{QueueSize: 4, CtrlQueueSize: 2})
	c := &channelConn{core: core}
	event := validChannelInputToolEvent(time.Now().Add(3 * time.Minute))
	c.forwardInputRequest("run-request", event)
	requestFrame := <-core.Outbox
	var decoded gatewayv2.ChannelServerFrame
	if err := proto.Unmarshal(requestFrame.Data, &decoded); err != nil {
		t.Fatalf("decode input request: %v", err)
	}
	interactionID := decoded.GetInputRequest().GetInteractionId()
	c.handleInputAnswer("bad-answer", &gatewayv2.ChannelInputAnswer{
		InteractionId: interactionID,
		Selections: []*gatewayv2.ChannelInputAnswerSelection{{
			QuestionId: "q1",
			OptionId:   "unknown",
		}},
	})
	badFrame := <-core.Outbox
	var bad gatewayv2.ChannelServerFrame
	if err := proto.Unmarshal(badFrame.Data, &bad); err != nil {
		t.Fatalf("decode invalid selection: %v", err)
	}
	if got := bad.GetInputAnswerResult(); got == nil || got.GetAccepted() || got.GetStatus() != "invalid_selection" {
		t.Fatalf("invalid selection result = %#v", got)
	}

	c.resolveInputsForRun("run-1", "turn ended")
	resolvedFrame := <-core.Outbox
	var resolved gatewayv2.ChannelServerFrame
	if err := proto.Unmarshal(resolvedFrame.Data, &resolved); err != nil {
		t.Fatalf("decode run resolution: %v", err)
	}
	if got := resolved.GetInputResolved(); got == nil || got.GetStatus() != "run_finished" || got.GetMessage() != "turn ended" {
		t.Fatalf("run resolution = %#v", got)
	}
}

func TestChannelReplaySuppressesResolvedAskUserQuestionRequest(t *testing.T) {
	call := validChannelInputToolEvent(time.Now().Add(3 * time.Minute))
	result := &session.ConversationEvent{
		ConversationID: call.ConversationID,
		RunID:          call.RunID,
		Seq:            call.Seq + 1,
		Type:           "tool_result",
		Payload: map[string]any{
			"id":      "tool-call-1",
			"name":    "AskUserQuestion",
			"isError": false,
		},
	}
	resolved := channelResolvedReplayTools([]*session.ConversationEvent{call, result})
	if _, ok := resolved[channelInputToolKey(call.RunID, "tool-call-1")]; !ok {
		t.Fatalf("resolved replay tools = %#v", resolved)
	}
	forwarded := false
	forward := func(*session.ConversationEvent) bool {
		forwarded = true
		return false
	}
	if forwardReplayEvent(forward, call, resolved) {
		t.Fatal("resolved AskUserQuestion replay unexpectedly terminated the stream")
	}
	if forwarded {
		t.Fatal("resolved AskUserQuestion replay forwarded a stale input request")
	}
	other := *call
	other.Payload = cloneChannelPayload(call.Payload)
	otherEvent := &other
	otherEvent.Payload["id"] = "tool-call-live"
	if forwardReplayEvent(forward, otherEvent, resolved) {
		t.Fatal("unresolved AskUserQuestion replay unexpectedly terminated the stream")
	}
	if !forwarded {
		t.Fatal("unresolved AskUserQuestion replay was suppressed")
	}
}

func TestChannelPresentedFilesAcceptsOnlySuccessfulBoundedPresentFileResults(t *testing.T) {
	payload := map[string]any{
		"name":    "PresentFile",
		"isError": false,
		"details": map[string]any{
			"kind": "display_file",
			"files": []any{map[string]any{
				"relativePath": "reports/result.pdf",
				"fileName":     "result.pdf",
				"mimeType":     "application/pdf",
				"fileId":       "artifact-1",
				"sizeBytes":    float64(4),
				"mtimeMs":      float64(1234),
			}},
		},
	}
	files, ok := channelPresentedFiles(payload)
	if !ok || len(files) != 1 {
		t.Fatalf("valid PresentFile rejected: %#v %v", files, ok)
	}
	if got := files[0]; got.path != "reports/result.pdf" || got.fileID != "artifact-1" || got.sizeBytes != 4 || got.mtimeMS != 1234 {
		t.Fatalf("parsed PresentFile = %#v", got)
	}

	failed := cloneChannelPayload(payload)
	failed["isError"] = true
	if files, ok := channelPresentedFiles(failed); ok || files != nil {
		t.Fatalf("failed PresentFile was forwarded: %#v", files)
	}
	unknownStatus := cloneChannelPayload(payload)
	delete(unknownStatus, "isError")
	if files, ok := channelPresentedFiles(unknownStatus); ok || files != nil {
		t.Fatalf("PresentFile without an explicit success status was forwarded: %#v", files)
	}

	wrongTool := cloneChannelPayload(payload)
	wrongTool["name"] = "Read"
	if files, ok := channelPresentedFiles(wrongTool); ok || files != nil {
		t.Fatalf("non-PresentFile result was forwarded: %#v", files)
	}

	missingID := cloneChannelPayload(payload)
	missingID["details"].(map[string]any)["files"].([]any)[0].(map[string]any)["fileId"] = ""
	if files, ok := channelPresentedFiles(missingID); ok || files != nil {
		t.Fatalf("PresentFile without file id was forwarded: %#v", files)
	}

	overTotal := cloneChannelPayload(payload)
	baseFile := overTotal["details"].(map[string]any)["files"].([]any)[0].(map[string]any)
	baseFile["sizeBytes"] = float64(channelMaxFilesBytes/2 + 1)
	second := make(map[string]any, len(baseFile))
	for key, value := range baseFile {
		second[key] = value
	}
	second["relativePath"] = "reports/result-2.pdf"
	second["fileName"] = "result-2.pdf"
	second["fileId"] = "artifact-2"
	overTotal["details"].(map[string]any)["files"] = []any{baseFile, second}
	if files, ok := channelPresentedFiles(overTotal); ok || files != nil {
		t.Fatalf("oversized PresentFile result was forwarded: %#v", files)
	}
}

func cloneChannelPayload(payload map[string]any) map[string]any {
	clone := make(map[string]any, len(payload))
	for key, value := range payload {
		clone[key] = value
	}
	details, _ := payload["details"].(map[string]any)
	clonedDetails := make(map[string]any, len(details))
	for key, value := range details {
		clonedDetails[key] = value
	}
	rawFiles, _ := details["files"].([]any)
	clonedFiles := make([]any, 0, len(rawFiles))
	for _, raw := range rawFiles {
		file, _ := raw.(map[string]any)
		clonedFile := make(map[string]any, len(file))
		for key, value := range file {
			clonedFile[key] = value
		}
		clonedFiles = append(clonedFiles, clonedFile)
	}
	clonedDetails["files"] = clonedFiles
	clone["details"] = clonedDetails
	return clone
}

func TestReadPresentedArtifactEchoesDescriptorAndRejectsChangedMetadata(t *testing.T) {
	manager := session.NewManager()
	agent := session.NewAgentSession(session.AuthSnapshot{SessionID: "session-1"})
	manager.SetSession(agent)
	t.Cleanup(func() { manager.ClearSession(agent) })
	c := &channelConn{sm: manager}
	file := channelPresentedFile{
		path:      "reports/result.pdf",
		fileName:  "result.pdf",
		mimeType:  "application/pdf",
		fileID:    "artifact-1",
		sizeBytes: 4,
		mtimeMS:   1234,
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	type result struct {
		response *gatewayv1.FsReadWorkspaceArtifactResponse
		err      error
	}
	resultCh := make(chan result, 1)
	go func() {
		response, err := c.readPresentedArtifact(ctx, "C:/workspace", file)
		resultCh <- result{response: response, err: err}
	}()

	var outbound *session.OutboundEnvelope
	select {
	case outbound = <-agent.Outbound():
	case <-ctx.Done():
		t.Fatal("timed out waiting for artifact request")
	}
	request := outbound.GetFsReadWorkspaceArtifact()
	if request == nil || request.GetWorkdir() != "C:/workspace" || request.GetPath() != file.path ||
		request.GetExpectedFileId() != file.fileID || request.GetExpectedSizeBytes() != file.sizeBytes ||
		request.GetExpectedMtimeMs() != file.mtimeMS {
		t.Fatalf("artifact request = %#v", request)
	}
	outbound.Ack(nil)
	manager.DispatchFromAgentForSession(agent, &gatewayv1.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Payload: &gatewayv1.AgentEnvelope_FsReadWorkspaceArtifactResp{
			FsReadWorkspaceArtifactResp: &gatewayv1.FsReadWorkspaceArtifactResponse{
				Path:      file.path,
				FileName:  file.fileName,
				MimeType:  file.mimeType,
				SizeBytes: file.sizeBytes,
				Content:   []byte("pdf!"),
			},
		},
	})

	select {
	case got := <-resultCh:
		if got.err != nil || string(got.response.GetContent()) != "pdf!" {
			t.Fatalf("readPresentedArtifact() = %#v, %v", got.response, got.err)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for artifact response")
	}

	go func() {
		response, err := c.readPresentedArtifact(ctx, "C:/workspace", file)
		resultCh <- result{response: response, err: err}
	}()
	select {
	case outbound = <-agent.Outbound():
	case <-ctx.Done():
		t.Fatal("timed out waiting for changed artifact request")
	}
	outbound.Ack(nil)
	manager.DispatchFromAgentForSession(agent, &gatewayv1.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Payload: &gatewayv1.AgentEnvelope_FsReadWorkspaceArtifactResp{
			FsReadWorkspaceArtifactResp: &gatewayv1.FsReadWorkspaceArtifactResponse{
				Path:      file.path,
				FileName:  "replacement.pdf",
				MimeType:  file.mimeType,
				SizeBytes: file.sizeBytes,
				Content:   []byte("pdf!"),
			},
		},
	})
	select {
	case got := <-resultCh:
		if got.err == nil || got.response != nil || !strings.Contains(got.err.Error(), "metadata changed") {
			t.Fatalf("changed artifact response = %#v, %v", got.response, got.err)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for changed artifact rejection")
	}
}

func TestChannelFinalResponseTextExposesOnlyCompletedCanonicalAnswer(t *testing.T) {
	if text, ok := channelFinalResponseText("completed", map[string]any{
		"final_text": "最终答案",
		"text":       "中间过程",
	}); !ok || text != "最终答案" {
		t.Fatalf("canonical final answer was not exposed: %q %v", text, ok)
	}

	for _, test := range []struct {
		status  string
		payload map[string]any
	}{
		{status: "completed", payload: map[string]any{"text": "中间过程"}},
		{status: "completed", payload: map[string]any{"final_text": "  "}},
		{status: "failed", payload: map[string]any{"final_text": "失败前的半成品"}},
		{status: "completed", payload: nil},
	} {
		if text, ok := channelFinalResponseText(test.status, test.payload); ok || text != "" {
			t.Fatalf("non-final channel text was exposed: %q %v for %#v", text, ok, test)
		}
	}
}

func TestChannelRunDeltaAndFinalShareOrderedResponseQueue(t *testing.T) {
	core := wscore.NewConn(nil, wscore.Config{QueueSize: 3, CtrlQueueSize: 2})
	c := &channelConn{core: core}

	if err := c.sendRunDelta("request-1", "run-1", "conversation-1", 7, "answer"); err != nil {
		t.Fatalf("sendRunDelta() = %v", err)
	}
	if err := c.sendRunFile("request-1", &gatewayv2.ChannelFile{
		RunId: "run-1", ConversationId: "conversation-1", Seq: 8,
		FileName: "report.csv", MimeType: "text/csv", SizeBytes: 3, Content: []byte("a,b"),
	}); err != nil {
		t.Fatalf("sendRunFile() = %v", err)
	}
	if err := c.sendRunFinal("request-1", "run-1", "conversation-1", "completed", "", ""); err != nil {
		t.Fatalf("sendRunFinal() = %v", err)
	}
	if got := len(core.CtrlOutbox); got != 0 {
		t.Fatalf("control queue depth = %d, want 0", got)
	}

	first := <-core.Outbox
	second := <-core.Outbox
	third := <-core.Outbox
	if first.Class != wscore.FrameResponse || first.Kind != "channel_delta" {
		t.Fatalf("first frame = %#v, want response delta", first)
	}
	if second.Class != wscore.FrameResponse || second.Kind != "channel_file" {
		t.Fatalf("second frame = %#v, want response file", second)
	}
	if third.Class != wscore.FrameResponse || third.Kind != "channel_final" {
		t.Fatalf("third frame = %#v, want response final", third)
	}

	var delta gatewayv2.ChannelServerFrame
	if err := proto.Unmarshal(first.Data, &delta); err != nil {
		t.Fatalf("decode delta: %v", err)
	}
	var file gatewayv2.ChannelServerFrame
	if err := proto.Unmarshal(second.Data, &file); err != nil {
		t.Fatalf("decode file: %v", err)
	}
	var final gatewayv2.ChannelServerFrame
	if err := proto.Unmarshal(third.Data, &final); err != nil {
		t.Fatalf("decode final: %v", err)
	}
	if delta.GetDelta().GetText() != "answer" || string(file.GetFile().GetContent()) != "a,b" || final.GetFinal().GetStatus() != "completed" {
		t.Fatalf("ordered frames = %#v then %#v then %#v", delta.GetDelta(), file.GetFile(), final.GetFinal())
	}
}

func TestSendRunFileErrorUsesStablePublicError(t *testing.T) {
	core := wscore.NewConn(nil, wscore.Config{QueueSize: 1, CtrlQueueSize: 1})
	c := &channelConn{core: core}
	if err := c.sendRunFileError("request-1", "run-1", "conversation-1", 9, channelPresentedFile{
		fileName: "report.csv", mimeType: "text/csv", sizeBytes: 12,
	}); err != nil {
		t.Fatalf("sendRunFileError() = %v", err)
	}
	frame := <-core.Outbox
	var decoded gatewayv2.ChannelServerFrame
	if err := proto.Unmarshal(frame.Data, &decoded); err != nil {
		t.Fatalf("decode file error: %v", err)
	}
	file := decoded.GetFile()
	if file.GetErrorCode() != "file_unavailable" || file.GetMessage() != "The presented file is no longer available." || len(file.GetContent()) != 0 {
		t.Fatalf("public file error = %#v", file)
	}
}

func TestChannelTerminalReplayIncludesDurablePresentedFile(t *testing.T) {
	core := wscore.NewConn(nil, wscore.Config{QueueSize: 4, CtrlQueueSize: 1})
	c := &channelConn{core: core}
	payload := `{"name":"PresentFile","isError":false,"details":{"kind":"display_file","files":[{` +
		`"relativePath":"reports/result.pdf","fileName":"result.pdf","mimeType":"application/pdf",` +
		`"fileId":"artifact-1","sizeBytes":4,"mtimeMs":1234}]}}`
	c.subscribeRun("request-1", "message-1", session.ChatCommandStart{
		RunID:          "run-1",
		ConversationID: "conversation-1",
		Deduped:        true,
		Terminal: &session.ChatCommandTerminal{
			Status:      "completed",
			PayloadJSON: `{"final_text":"done"}`,
			PresentedFiles: []session.ChatCommandPresentedFile{{
				Seq:         7,
				Workdir:     "",
				PayloadJSON: payload,
			}},
		},
	})

	fileFrame := <-core.Outbox
	deltaFrame := <-core.Outbox
	finalFrame := <-core.Outbox
	if fileFrame.Kind != "channel_file" || deltaFrame.Kind != "channel_delta" || finalFrame.Kind != "channel_final" {
		t.Fatalf("terminal replay frames = %q, %q, %q", fileFrame.Kind, deltaFrame.Kind, finalFrame.Kind)
	}
	var decoded gatewayv2.ChannelServerFrame
	if err := proto.Unmarshal(fileFrame.Data, &decoded); err != nil {
		t.Fatalf("decode replayed file: %v", err)
	}
	file := decoded.GetFile()
	if file.GetRunId() != "run-1" || file.GetSeq() != 7 || file.GetFileName() != "result.pdf" ||
		file.GetErrorCode() != "file_unavailable" {
		t.Fatalf("replayed durable file = %#v", file)
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

func TestRememberedInboundBindingReplaysWhenAgentConnectsLater(t *testing.T) {
	srv := &Server{}
	connector := &channelConn{
		srv: srv,
		binding: channelBinding{
			tenantID: "tenant-1", botID: "bot-1", connectorID: "connector-1", lifecycleVersion: 1,
		},
	}
	inbound := &gatewayv2.ChannelInboundMessage{
		ChannelScopeKey: "scope-1", ChannelSessionId: "session-1", ChannelSessionGeneration: 3,
	}
	srv.rememberInboundBinding(connector, inbound, "wecom:conversation-1")

	agent := session.NewAgentSession(session.AuthSnapshot{SessionID: "agent-session-1"})
	t.Cleanup(agent.Close)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() {
		srv.replayBindingSnapshots(ctx, agent)
		close(done)
	}()

	select {
	case outbound := <-agent.Outbound():
		snapshot := outbound.GetChannelBindingsSnapshot()
		if snapshot == nil || len(snapshot.GetBindings()) != 1 {
			t.Fatalf("replayed binding snapshot = %#v", snapshot)
		}
		binding := snapshot.GetBindings()[0]
		if binding.GetConversationId() != "wecom:conversation-1" ||
			binding.GetScopeKey() != "scope-1" || binding.GetSessionId() != "session-1" ||
			binding.GetGeneration() != 3 || binding.GetLifecycleVersion() != 1 {
			t.Fatalf("replayed binding = %#v", binding)
		}
		outbound.Ack(nil)
	case <-ctx.Done():
		t.Fatal("binding snapshot was not replayed")
	}
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("binding replay did not settle after delivery acknowledgement")
	}
}

func TestBindingSnapshotPagesMergeAndNewerScopeGenerationReplacesOlder(t *testing.T) {
	srv := &Server{}
	registration := func(scope, session string, generation uint64) *gatewayv1.ChannelBindingRegistration {
		return &gatewayv1.ChannelBindingRegistration{
			ConversationId: "conversation-" + session, InstallationId: "installation-1",
			ScopeKey: scope, SessionId: session, Generation: generation, LifecycleVersion: 1,
		}
	}
	srv.rememberBindingSnapshot("installation-1", []*gatewayv1.ChannelBindingRegistration{
		registration("scope-1", "session-1", 1),
	})
	srv.rememberBindingSnapshot("installation-1", []*gatewayv1.ChannelBindingRegistration{
		registration("scope-2", "session-2", 1),
	})
	srv.rememberBindingSnapshot("installation-1", []*gatewayv1.ChannelBindingRegistration{
		registration("scope-1", "session-3", 2),
	})
	// Out-of-order delivery from an older page or replaced connection must not
	// regress the route cached for later agent reconnects.
	srv.rememberBindingSnapshot("installation-1", []*gatewayv1.ChannelBindingRegistration{
		registration("scope-1", "session-stale", 1),
		registration("scope-1", "session-conflict", 2),
	})

	srv.channelsMu.Lock()
	stored := srv.bindingSnapshots["installation-1"]
	srv.channelsMu.Unlock()
	if len(stored) != 2 {
		t.Fatalf("merged snapshot size = %d, want 2", len(stored))
	}
	if got := stored["scope-1"]; got == nil || got.GetSessionId() != "session-3" || got.GetGeneration() != 2 {
		t.Fatalf("newer scope registration = %#v", got)
	}
	if got := stored["scope-2"]; got == nil || got.GetSessionId() != "session-2" {
		t.Fatalf("second snapshot page was lost: %#v", got)
	}
}

func TestChannelBindingSnapshotValidationAcceptsOpaqueProviderScope(t *testing.T) {
	entry := &gatewayv2.ChannelInboundMessage{
		ExternalUserId: "user-1", ChatType: "single", ChannelSessionId: "session-1",
		ChannelScopeKey: "dingtalk:v7:opaque/scope?tenant=一", ChannelSessionGeneration: 4,
	}
	if err := validateChannelBindingSnapshotEntry(entry); err != nil {
		t.Fatalf("generic binding snapshot rejected: %v", err)
	}
	entry.ChannelSessionGeneration = 0
	if err := validateChannelBindingSnapshotEntry(entry); err == nil {
		t.Fatal("zero generation binding snapshot was accepted")
	}
}

func TestBindingSnapshotReplayKeepsPagesBounded(t *testing.T) {
	srv := &Server{}
	registrations := make([]*gatewayv1.ChannelBindingRegistration, 0, 101)
	for index := 0; index < 101; index++ {
		registrations = append(registrations, &gatewayv1.ChannelBindingRegistration{
			ConversationId: fmt.Sprintf("conversation-%d", index), InstallationId: "installation-1",
			ScopeKey: fmt.Sprintf("scope-%d", index), SessionId: fmt.Sprintf("session-%d", index),
			Generation: 1, LifecycleVersion: 1,
		})
	}
	srv.rememberBindingSnapshot("installation-1", registrations)
	agent := session.NewAgentSession(session.AuthSnapshot{SessionID: "agent-session-1"})
	t.Cleanup(agent.Close)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() {
		srv.replayBindingSnapshots(ctx, agent)
		close(done)
	}()
	pageSizes := make([]int, 0, 2)
	for len(pageSizes) < 2 {
		select {
		case outbound := <-agent.Outbound():
			pageSizes = append(pageSizes, len(outbound.GetChannelBindingsSnapshot().GetBindings()))
			outbound.Ack(nil)
		case <-ctx.Done():
			t.Fatalf("timed out after replay pages %v", pageSizes)
		}
	}
	if pageSizes[0] != 100 || pageSizes[1] != 1 {
		t.Fatalf("replay page sizes = %v, want [100 1]", pageSizes)
	}
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("paged binding replay did not settle")
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

	progress := proto.Clone(valid).(*gatewayv2.ClientHello)
	progress.ChannelProgressVersion = 1
	verdict, binding = c.vetChannelHello(progress)
	if !verdict.ok || binding.progressVersion != 1 {
		t.Fatalf("progress opt-in rejected: %+v %+v", verdict, binding)
	}
	if _, legacy := c.vetChannelHello(valid); legacy.progressVersion != 0 {
		t.Fatalf("legacy hello must not opt into progress: %+v", legacy)
	}
	progress.ChannelProgressVersion = 2
	verdict, _ = c.vetChannelHello(progress)
	if verdict.ok || !strings.Contains(verdict.message, "progress version") {
		t.Fatalf("unknown progress version accepted: %+v", verdict)
	}
}

func TestChannelProgressFromEventMapsOnlyDocumentedKinds(t *testing.T) {
	event := func(kind string, payload map[string]any) *session.ConversationEvent {
		return &session.ConversationEvent{
			ConversationID: "conversation-1", RunID: "run-1", Seq: 9, Type: kind, Payload: payload,
		}
	}
	for _, test := range []struct {
		name     string
		event    *session.ConversationEvent
		wantKind string
		wantText string
	}{
		{"thinking", event("thinking", map[string]any{"text": "先看一下文件", "round": float64(2)}), "thinking", "先看一下文件"},
		{"token", event("token", map[string]any{"text": "好的，"}), "text", "好的，"},
		{"tool start", event("tool_call", map[string]any{"type": "tool_call", "id": "call-1", "name": "Read", "arguments": map[string]any{"path": "secret.env"}}), "tool_call", "Read"},
		{"legacy tool start", event("tool_call", map[string]any{"name": "Bash", "arguments": "rm -rf"}), "tool_call", "Bash"},
		{"status", event("tool_status", map[string]any{"status": "running"}), "status", "running"},
		{"compaction", event("tool_status", map[string]any{"status": "running", "isCompaction": true}), "status", "compacting"},
	} {
		progress, ok := channelProgressFromEvent(test.event)
		if !ok {
			t.Fatalf("%s: progress was not produced", test.name)
		}
		if progress.GetKind() != test.wantKind || progress.GetText() != test.wantText {
			t.Fatalf("%s: progress = %#v", test.name, progress)
		}
		if progress.GetRunId() != "run-1" || progress.GetConversationId() != "conversation-1" || progress.GetSeq() != 9 {
			t.Fatalf("%s: routing fields = %#v", test.name, progress)
		}
		if strings.Contains(progress.String(), "secret") || strings.Contains(progress.String(), "rm -rf") {
			t.Fatalf("%s: tool arguments leaked: %s", test.name, progress.String())
		}
	}
	if progress, _ := channelProgressFromEvent(event("thinking", map[string]any{"text": "x", "round": float64(2)})); progress.GetRound() != 2 {
		t.Fatalf("round was not carried: %#v", progress)
	}

	for _, test := range []struct {
		name  string
		event *session.ConversationEvent
	}{
		{"nil", nil},
		{"argument delta", event("tool_call", map[string]any{"type": "tool_call_delta", "name": "Write", "arguments": map[string]any{}})},
		{"ask user question", event("tool_call", map[string]any{"type": "tool_call", "name": "AskUserQuestion"})},
		{"tool result", event("tool_result", map[string]any{"name": "Read", "content": "file body"})},
		{"empty thinking", event("thinking", map[string]any{"text": ""})},
		{"run finished", event(session.StreamEventRunFinished, map[string]any{"final_text": "answer"})},
		{"control characters in status", event("tool_status", map[string]any{"status": "run\x00ning"})},
	} {
		if progress, ok := channelProgressFromEvent(test.event); ok || progress != nil {
			t.Fatalf("%s: unexpected progress %#v", test.name, progress)
		}
	}

	long := strings.Repeat("思", channelProgressMaxTextBytes)
	progress, ok := channelProgressFromEvent(event("thinking", map[string]any{"text": long}))
	if !ok || len(progress.GetText()) > channelProgressMaxTextBytes || !utf8.ValidString(progress.GetText()) || progress.GetText() == "" {
		t.Fatalf("long thinking was not bounded on a rune boundary: %d bytes", len(progress.GetText()))
	}
	if progress, ok := channelProgressFromEvent(event("token", map[string]any{"text": "ok\xff"})); !ok || progress.GetText() != "ok" {
		t.Fatalf("invalid UTF-8 was not stripped: %#v", progress)
	}
}

func TestForwardProgressRequiresConnectorOptIn(t *testing.T) {
	event := &session.ConversationEvent{
		ConversationID: "conversation-1", RunID: "run-1", Seq: 3, Type: "thinking",
		Payload: map[string]any{"text": "thinking"},
	}
	legacy := &channelConn{core: wscore.NewConn(nil, wscore.Config{QueueSize: 2, CtrlQueueSize: 1})}
	legacy.forwardProgress("request-1", event)
	if got := len(legacy.core.Outbox); got != 0 {
		t.Fatalf("legacy connector received %d progress frames", got)
	}

	opted := &channelConn{
		core:    wscore.NewConn(nil, wscore.Config{QueueSize: 2, CtrlQueueSize: 1}),
		binding: channelBinding{progressVersion: 1},
	}
	opted.forwardProgress("request-1", event)
	frame := <-opted.core.Outbox
	if frame.Class != wscore.FrameData || frame.Kind != "channel_progress" {
		t.Fatalf("progress frame = %#v, want sheddable data frame", frame)
	}
	var decoded gatewayv2.ChannelServerFrame
	if err := proto.Unmarshal(frame.Data, &decoded); err != nil {
		t.Fatalf("decode progress: %v", err)
	}
	if decoded.GetRequestId() != "request-1" || decoded.GetProgress().GetKind() != "thinking" || decoded.GetProgress().GetText() != "thinking" {
		t.Fatalf("decoded progress = %#v", decoded.GetProgress())
	}
}
