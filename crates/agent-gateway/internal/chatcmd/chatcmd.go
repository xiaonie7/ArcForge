// Package chatcmd 承载网关侧 chat 命令编排（请求体归一化、运行时探活、命令投递与启动看门狗、
// proto 信封构造）；v1/v2 协议层共用（自 internal/server/chat_commands.go 平移，行为不变），
// 协议层只做载荷编解码，编排逻辑一律收敛于此。
package chatcmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/handler"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/session"
)

// MessageRef 是 chat.edit_resend 引用的既有消息定位（JSON 线格式与 v1 一致）。
type MessageRef struct {
	SegmentIndex int    `json:"segment_index"`
	MessageIndex int    `json:"message_index"`
	SegmentID    string `json:"segment_id"`
	MessageID    string `json:"message_id"`
	Role         string `json:"role"`
	ContentHash  string `json:"content_hash"`
}

const (
	// runtimeWakeRequestPrefix 是探活请求 id 的约定前缀；桌面端识别到它会先唤醒 Chat WebView 运行时。
	runtimeWakeRequestPrefix = "chat-runtime-wake-"
	runtimeProbeReuseWindow  = 2 * time.Second
)

// NewTraceID 生成 chat 命令链路的追踪 id。
func NewTraceID() string {
	return strings.ReplaceAll(uuid.NewString(), "-", "")
}

// LogCommandSpan 记录 chat 命令生命周期中的一个阶段（结构化日志）。
func LogCommandSpan(
	traceID string,
	span string,
	runID string,
	conversationID string,
	clientRequestID string,
	commandType string,
) {
	slog.Info("chat_command_span",
		"span", strings.TrimSpace(span),
		"trace_id", strings.TrimSpace(traceID),
		"run_id", strings.TrimSpace(runID),
		"conversation_id", strings.TrimSpace(conversationID),
		"client_request_id", strings.TrimSpace(clientRequestID),
		"command_type", strings.TrimSpace(commandType),
	)
}

// NormalizeRequestBody 归一化并校验 chat 请求体（trim、默认值、必填项）。
func NormalizeRequestBody(body *handler.ChatRequestBody) error {
	body.Message = strings.TrimSpace(body.Message)
	body.ConversationID = strings.TrimSpace(body.ConversationID)
	body.ClientRequestID = strings.TrimSpace(body.ClientRequestID)
	body.ExecutionMode = handler.NormalizeExecutionMode(body.ExecutionMode)
	body.Workdir = handler.NormalizeWorkdir(body.Workdir)
	body.QueuePolicy = normalizeQueuePolicy(body.QueuePolicy)
	body.SelectedSystemTools = handler.NormalizeSelectedSystemTools(body.SelectedSystemTools)
	body.UploadedFiles = handler.NormalizeChatUploadedFiles(body.UploadedFiles)
	body.RuntimeControls = handler.NormalizeChatRuntimeControls(body.RuntimeControls)
	selectedModel, err := handler.NormalizeChatSelectedModel(body.SelectedModel)
	if err != nil {
		return err
	}
	body.SelectedModel = selectedModel
	if body.ClientRequestID == "" {
		return errors.New("client_request_id is required")
	}
	if body.Message == "" && len(body.UploadedFiles) == 0 {
		return errors.New("message is required")
	}
	return nil
}

func normalizeQueuePolicy(value string) string {
	switch strings.TrimSpace(value) {
	case "append", "interrupt":
		return strings.TrimSpace(value)
	default:
		return "auto"
	}
}

// DispatchAcceptedCommand 把已接受的命令投递给桌面端并布防启动看门狗；
// cleanupWatch 在命令落定或判失败后关闭调用方的命令更新观察流。
func DispatchAcceptedCommand(
	parent context.Context,
	cfg *config.Config,
	sm *session.Manager,
	cleanupWatch func(),
	start session.ChatCommandStart,
	body handler.ChatRequestBody,
	baseMessageRef *MessageRef,
	traceID string,
) {
	DispatchAcceptedCommandWithOrigin(
		parent,
		cfg,
		sm,
		cleanupWatch,
		start,
		body,
		baseMessageRef,
		traceID,
		nil,
	)
}

// DispatchAcceptedCommandWithOrigin is the channel-only variant of
// DispatchAcceptedCommand. The origin is supplied by the authenticated gateway
// transport and is copied into the desktop request without passing through the
// user/LLM-controlled request body. Browser callers should use the wrapper
// above and therefore always send a nil origin.
func DispatchAcceptedCommandWithOrigin(
	parent context.Context,
	cfg *config.Config,
	sm *session.Manager,
	cleanupWatch func(),
	start session.ChatCommandStart,
	body handler.ChatRequestBody,
	baseMessageRef *MessageRef,
	traceID string,
	origin *gatewayv1.TrustedOrigin,
) {
	if cleanupWatch != nil {
		defer cleanupWatch()
	}
	timeout := DeliveryTimeout(cfg)
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	commandType := "chat.submit"
	if baseMessageRef != nil {
		commandType = "chat.edit_resend"
	}
	if err := sm.SendToAgentContext(ctx, buildCommandEnvelope(start.RunID, commandType, body, baseMessageRef, origin)); err != nil {
		message := "chat command failed"
		if err != nil && strings.TrimSpace(err.Error()) != "" {
			message = strings.TrimSpace(err.Error())
		}
		sm.FailChatCommand(start.RunID, "desktop_runtime_unavailable", message)
		return
	}
	LogCommandSpan(traceID, "command_delivered", start.RunID, start.ConversationID, body.ClientRequestID, commandType)
	WatchAcceptedCommandStartup(parent, cfg, sm, start.RunID)
}

// ProbeRuntime 验证桌面端连接可完成真实往返；探活请求 id 的特殊前缀同时是唤醒
// Chat WebView 运行时的信号。
func ProbeRuntime(
	ctx context.Context,
	sm *session.Manager,
) error {
	if sm == nil {
		return session.ErrAgentOffline
	}
	sessionEpoch, online := sm.ChatRuntimeProbeEpoch()
	if !online {
		return session.ErrAgentOffline
	}
	requestID := runtimeWakeRequestPrefix + uuid.NewString()
	response, err := sm.AwaitUnaryResponse(ctx, requestID, &gatewayv1.GatewayEnvelope{
		RequestId: requestID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_Ping{
			Ping: &gatewayv1.PingRequest{Timestamp: time.Now().Unix()},
		},
	})
	if err != nil {
		return err
	}
	if response == nil || response.GetPong() == nil {
		return errors.New("desktop agent returned an invalid chat runtime probe response")
	}
	if !sm.RecordChatRuntimeProbe(sessionEpoch) {
		return session.ErrAgentOffline
	}
	return nil
}

// ProbeRuntimeForCommand 在近期已有成功探活时直接复用结果。
func ProbeRuntimeForCommand(ctx context.Context, sm *session.Manager) error {
	if sm != nil && sm.ChatRuntimeProbeFresh(runtimeProbeReuseWindow) {
		return nil
	}
	return ProbeRuntime(ctx, sm)
}

// WatchAcceptedCommandStartup 对启动窗口内未落定（开始、结束或进入桌面提示队列）的命令判失败。
func WatchAcceptedCommandStartup(
	parent context.Context,
	cfg *config.Config,
	sm *session.Manager,
	runID string,
) {
	if sm == nil || strings.TrimSpace(runID) == "" {
		return
	}
	if !waitCommandWatchdog(parent, StartTimeout(cfg)) {
		return
	}
	if sm.ChatCommandSettled(runID) {
		return
	}
	if !waitCommandWatchdog(parent, RenderStartTimeout(cfg)) {
		return
	}
	if sm.ChatCommandSettled(runID) {
		return
	}
	sm.FailChatCommand(runID, "startup_timeout",
		"The desktop app did not start the remote chat request. Please retry.")
}

func waitCommandWatchdog(ctx context.Context, timeout time.Duration) bool {
	if timeout <= 0 {
		return true
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// StartTimeout / RenderStartTimeout / PrepareTimeout / DeliveryTimeout 返回各阶段超时
// （未配置时取保守默认值）。
func StartTimeout(cfg *config.Config) time.Duration {
	if cfg != nil && cfg.ChatStartTimeout > 0 {
		return cfg.ChatStartTimeout
	}
	return 5 * time.Second
}

func RenderStartTimeout(cfg *config.Config) time.Duration {
	if cfg != nil && cfg.ChatRenderStartTimeout > 0 {
		return cfg.ChatRenderStartTimeout
	}
	return 10 * time.Second
}

func PrepareTimeout(cfg *config.Config) time.Duration {
	if cfg != nil && cfg.ChatPrepareTimeout > 0 {
		return cfg.ChatPrepareTimeout
	}
	return 2 * time.Second
}

func DeliveryTimeout(cfg *config.Config) time.Duration {
	if cfg != nil && cfg.ChatDeliveryTimeout > 0 {
		return cfg.ChatDeliveryTimeout
	}
	return 5 * time.Second
}

// BuildAcceptedCommandPayloads 构造命令被接受时立即写入会话流的事件载荷
// （edit_resend 先补一条 rebase 事件）。
func BuildAcceptedCommandPayloads(
	body handler.ChatRequestBody,
	baseMessageRef *MessageRef,
) []map[string]any {
	payloads := make([]map[string]any, 0, 2)
	if baseMessageRef != nil {
		payloads = append(payloads, map[string]any{
			"type":             session.StreamEventRebased,
			"base_message_ref": baseMessageRef,
			"reason":           "edit_resend",
		})
	}
	payloads = append(payloads, buildUserMessageAppendedPayload(body, baseMessageRef))
	return payloads
}

func buildUserMessageAppendedPayload(
	body handler.ChatRequestBody,
	baseMessageRef *MessageRef,
) map[string]any {
	payload := map[string]any{
		"type":                  "user_message",
		"message":               body.Message,
		"uploaded_files":        body.UploadedFiles,
		"execution_mode":        body.ExecutionMode,
		"workdir":               body.Workdir,
		"selected_system_tools": body.SelectedSystemTools,
		"runtime_controls":      body.RuntimeControls,
		"selected_model":        body.SelectedModel,
	}
	if baseMessageRef != nil {
		payload["base_message_ref"] = baseMessageRef
		payload["reason"] = "edit_resend"
	}
	return payload
}

func buildCommandEnvelope(
	requestID string,
	commandType string,
	body handler.ChatRequestBody,
	baseMessageRef *MessageRef,
	origin *gatewayv1.TrustedOrigin,
) *gatewayv1.GatewayEnvelope {
	return &gatewayv1.GatewayEnvelope{
		RequestId: strings.TrimSpace(requestID),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_ChatCommand{
			ChatCommand: &gatewayv1.ChatCommandRequest{
				Type:           strings.TrimSpace(commandType),
				Request:        buildProtoRequest(body, origin),
				BaseMessageRef: BuildProtoMessageRef(baseMessageRef),
			},
		},
	}
}

// BuildCancelCommandPayload 构造 chat.cancel 的 GatewayEnvelope 载荷臂。
func BuildCancelCommandPayload(conversationID string) *gatewayv1.GatewayEnvelope_ChatCommand {
	return &gatewayv1.GatewayEnvelope_ChatCommand{
		ChatCommand: &gatewayv1.ChatCommandRequest{
			Type: "chat.cancel",
			Cancel: &gatewayv1.CancelChatRequest{
				ConversationId: strings.TrimSpace(conversationID),
			},
		},
	}
}

func buildProtoRequest(body handler.ChatRequestBody, origin *gatewayv1.TrustedOrigin) *gatewayv1.ChatRequest {
	return &gatewayv1.ChatRequest{
		ConversationId:      body.ConversationID,
		ClientRequestId:     body.ClientRequestID,
		Message:             body.Message,
		SelectedModel:       handler.ToProtoChatSelectedModel(body.SelectedModel),
		RuntimeControls:     handler.ToProtoChatRuntimeControls(body.RuntimeControls),
		ExecutionMode:       body.ExecutionMode,
		Workdir:             body.Workdir,
		SelectedSystemTools: body.SelectedSystemTools,
		UploadedFiles:       handler.ToProtoChatUploadedFiles(body.UploadedFiles),
		QueuePolicy:         body.QueuePolicy,
		TrustedOrigin:       origin,
	}
}

// BuildProtoMessageRef 把 MessageRef 转为 proto 表示（nil 安全）。
func BuildProtoMessageRef(ref *MessageRef) *gatewayv1.ChatMessageRef {
	if ref == nil {
		return nil
	}
	return &gatewayv1.ChatMessageRef{
		SegmentIndex: int32(ref.SegmentIndex),
		MessageIndex: int32(ref.MessageIndex),
		SegmentId:    strings.TrimSpace(ref.SegmentID),
		MessageId:    strings.TrimSpace(ref.MessageID),
		Role:         strings.TrimSpace(ref.Role),
		ContentHash:  strings.TrimSpace(ref.ContentHash),
	}
}

// RequestBodyFromProto 把 v2 直带的 proto ChatRequest 还原为编排层请求体
// （buildProtoRequest 的逆向；调用方随后统一走 NormalizeRequestBody）。
func RequestBodyFromProto(req *gatewayv1.ChatRequest) handler.ChatRequestBody {
	if req == nil {
		return handler.ChatRequestBody{}
	}
	body := handler.ChatRequestBody{
		ConversationID:      req.GetConversationId(),
		ClientRequestID:     req.GetClientRequestId(),
		Message:             req.GetMessage(),
		ExecutionMode:       req.GetExecutionMode(),
		Workdir:             req.GetWorkdir(),
		SelectedSystemTools: req.GetSelectedSystemTools(),
		QueuePolicy:         req.GetQueuePolicy(),
	}
	if selected := req.GetSelectedModel(); selected != nil {
		body.SelectedModel = &handler.ChatSelectedModelBody{
			CustomProviderID: selected.GetCustomProviderId(),
			Model:            selected.GetModel(),
			ProviderType:     selected.GetProviderType(),
		}
	}
	if controls := req.GetRuntimeControls(); controls != nil {
		thinking := controls.GetThinkingEnabled()
		webSearch := controls.GetNativeWebSearchEnabled()
		body.RuntimeControls = &handler.ChatRuntimeControlsBody{
			ThinkingEnabled:        &thinking,
			NativeWebSearchEnabled: &webSearch,
			Reasoning:              controls.GetReasoning(),
		}
	}
	for _, file := range req.GetUploadedFiles() {
		body.UploadedFiles = append(body.UploadedFiles, handler.ChatUploadedFileBody{
			RelativePath: file.GetRelativePath(),
			AbsolutePath: file.GetAbsolutePath(),
			FileName:     file.GetFileName(),
			Kind:         file.GetKind(),
			SizeBytes:    file.GetSizeBytes(),
		})
	}
	return body
}

// MessageRefFromProto 把 proto 消息引用还原为编排层表示（nil 安全）。
func MessageRefFromProto(ref *gatewayv1.ChatMessageRef) *MessageRef {
	if ref == nil {
		return nil
	}
	return &MessageRef{
		SegmentIndex: int(ref.GetSegmentIndex()),
		MessageIndex: int(ref.GetMessageIndex()),
		SegmentID:    ref.GetSegmentId(),
		MessageID:    ref.GetMessageId(),
		Role:         ref.GetRole(),
		ContentHash:  ref.GetContentHash(),
	}
}

// ValidateMessageRef 校验并归一化消息引用（原地 trim）。
func ValidateMessageRef(ref *MessageRef) error {
	if ref == nil {
		return nil
	}
	if ref.SegmentIndex < 0 || ref.MessageIndex < 0 {
		return errors.New("base_message_ref indexes must be non-negative")
	}
	ref.SegmentID = strings.TrimSpace(ref.SegmentID)
	ref.MessageID = strings.TrimSpace(ref.MessageID)
	ref.Role = strings.TrimSpace(ref.Role)
	ref.ContentHash = strings.TrimSpace(ref.ContentHash)
	if ref.SegmentID == "" || ref.MessageID == "" || ref.Role == "" || ref.ContentHash == "" {
		return errors.New("base_message_ref requires segment_id, message_id, role, and content_hash")
	}
	if ref.Role != "user" {
		return errors.New("base_message_ref role must be user")
	}
	return nil
}

// DecodeCommandPayload 解码 v1 JSON 线格式的 chat.command 载荷（{type, payload:{...}}）；
// v2 直带 proto ChatCommandRequest，不经此路。
func DecodeCommandPayload(raw json.RawMessage) (string, handler.ChatRequestBody, *MessageRef, error) {
	type commandEnvelope struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	type commandPayload struct {
		BaseMessageRef *MessageRef `json:"base_message_ref,omitempty"`
		handler.ChatRequestBody
	}

	var envelope commandEnvelope
	if err := decodeStrictJSON(raw, &envelope); err != nil {
		return "", handler.ChatRequestBody{}, nil, err
	}

	commandType := strings.TrimSpace(envelope.Type)
	if commandType == "" {
		return "", handler.ChatRequestBody{}, nil, errors.New("chat command type is required")
	}
	if len(envelope.Payload) == 0 || string(envelope.Payload) == "null" {
		return "", handler.ChatRequestBody{}, nil, errors.New("chat command payload is required")
	}
	if commandType == "chat.cancel" {
		return commandType, handler.ChatRequestBody{}, nil, nil
	}

	var payload commandPayload
	if err := decodeStrictJSON(envelope.Payload, &payload); err != nil {
		return "", handler.ChatRequestBody{}, nil, err
	}

	return commandType, payload.ChatRequestBody, payload.BaseMessageRef, nil
}

func decodeStrictJSON(raw []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("invalid trailing JSON")
	}
	return nil
}
