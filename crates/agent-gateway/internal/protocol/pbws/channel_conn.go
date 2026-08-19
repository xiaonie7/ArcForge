package pbws

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/liveagent/agent-gateway/internal/auth"
	"github.com/liveagent/agent-gateway/internal/chatcmd"
	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/handler"
	"github.com/liveagent/agent-gateway/internal/observability"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
	"github.com/liveagent/agent-gateway/internal/transport/wscore"
)

const (
	channelName              = "wecom"
	channelMaxIDBytes        = 256
	channelMaxSessionIDBytes = 128
	channelMaxTextSize       = 128 * 1024
	channelMaxFiles          = 9
	channelMaxFileBytes      = 20 << 20
	channelMaxFilesBytes     = 20 << 20
	channelMaxFileNameBytes  = 512
	channelMaxMIMETypeBytes  = 256
	channelMaxJSONInteger    = 1<<53 - 1
	channelInputMaxQuestions = 4
	channelInputMinOptions   = 2
	channelInputMaxOptions   = 6
	channelInputMaxHeader    = 128
	channelInputMaxPrompt    = 4 * 1024
	channelInputMaxLabel     = 512
	channelInputMaxDesc      = 2 * 1024
	channelInputMaxTotal     = 32 * 1024
)

const (
	channelInputMaxFuture   = 10 * time.Minute
	channelInputTerminalTTL = 10 * time.Minute
)

var channelCommandAllowlist = map[string]struct{}{
	"compact": {},
	"new":     {},
}

type channelBinding struct {
	tenantID    string
	botID       string
	connectorID string
	authAt      time.Time
}

type channelPresentedFile struct {
	path      string
	fileName  string
	mimeType  string
	fileID    string
	sizeBytes uint64
	mtimeMS   uint64
}

type channelInputOptionBinding struct {
	id            string
	selectedLabel string
}

type channelInputQuestionBinding struct {
	id         string
	questionID string
	options    map[string]channelInputOptionBinding
}

type channelInputInteraction struct {
	id             string
	requestID      string
	runID          string
	conversationID string
	toolCallID     string
	deadlineAtMS   int64
	questions      []channelInputQuestionBinding
	answering      bool
	answered       bool
}

type channelInputTerminal struct {
	status    string
	expiresAt time.Time
}

type channelConn struct {
	cfg  *config.Config
	sm   *session.Manager
	srv  *Server
	conn *websocket.Conn
	core *wscore.Conn
	done <-chan struct{}

	binding channelBinding

	runsMu sync.Mutex
	runs   map[string]func()

	inputsMu      sync.Mutex
	inputs        map[string]*channelInputInteraction
	inputByTool   map[string]string
	inputTerminal map[string]channelInputTerminal
}

// ChannelHandler serves the restricted connector link. It has a separate
// credential from browser/API connections and accepts no browser operations.
func (s *Server) ChannelHandler() http.Handler {
	upgrader := s.upgrader()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		conn.SetReadLimit(s.readLimit())
		c := &channelConn{
			cfg:           s.cfg,
			sm:            s.sm,
			srv:           s,
			conn:          conn,
			runs:          make(map[string]func()),
			inputs:        make(map[string]*channelInputInteraction),
			inputByTool:   make(map[string]string),
			inputTerminal: make(map[string]channelInputTerminal),
		}
		c.core = wscore.NewConn(conn, wscore.Config{
			WriteTimeout:    s.writeTimeout(),
			QueueSize:       s.cfg.WebSocketWriteQueueSize,
			HeartbeatPeriod: s.cfg.WebSocketHeartbeatPeriod,
			HeartbeatGrace:  s.cfg.WebSocketHeartbeatGrace,
			Remote:          r.RemoteAddr,
			OnClose:         c.cleanupRuns,
		})
		c.done = c.core.Done()
		conn.SetPongHandler(func(string) error {
			c.core.TouchInboundActivity()
			return nil
		})
		_ = conn.SetReadDeadline(time.Now().Add(c.core.IdleTimeout()))
		defer c.core.Close()
		c.serve()
	})
}

func (c *channelConn) serve() {
	if !c.handshake() {
		return
	}
	observability.Usage.V2ChannelConnectionsTotal.Add(1)
	observability.Usage.V2ChannelConnectionsActive.Add(1)
	defer observability.Usage.V2ChannelConnectionsActive.Add(-1)

	c.core.StartWriteLoop()
	c.core.StartHeartbeat(c.buildHeartbeatPing)
	for {
		frame, ok := c.readFrame()
		if !ok {
			return
		}
		c.core.TouchInboundActivity()
		switch payload := frame.GetPayload().(type) {
		case *gatewayv2.ChannelClientFrame_Pong:
			continue
		case *gatewayv2.ChannelClientFrame_Hello:
			_ = c.sendLocalError(frame.GetRequestId(), "already authenticated")
		case *gatewayv2.ChannelClientFrame_Inbound:
			go c.handleInbound(frame.GetRequestId(), payload.Inbound)
		case *gatewayv2.ChannelClientFrame_InputAnswer:
			go c.handleInputAnswer(frame.GetRequestId(), payload.InputAnswer)
		case nil:
			_ = c.sendLocalError(frame.GetRequestId(), "frame payload is required")
		default:
			_ = c.sendLocalError(frame.GetRequestId(), "unsupported channel frame payload")
		}
	}
}

func (c *channelConn) handshake() bool {
	frame, ok := c.readFrame()
	if !ok {
		return false
	}
	hello := frame.GetHello()
	verdict, binding := c.vetChannelHello(hello)
	if !verdict.ok {
		_ = writeDirectMessage(c.conn, c.srv.writeTimeout(), &gatewayv2.ChannelServerFrame{
			RequestId: frame.GetRequestId(),
			Payload: &gatewayv2.ChannelServerFrame_Hello{
				Hello: c.srv.serverHello(false, verdict.message, ""),
			},
		})
		closeUnauthorized(c.conn, c.srv.writeTimeout())
		return false
	}
	c.binding = binding
	c.core.SetAuthorized()
	c.core.TouchInboundActivity()
	if err := c.send(wscore.FrameResponse, "hello", &gatewayv2.ChannelServerFrame{
		RequestId: frame.GetRequestId(),
		Payload: &gatewayv2.ChannelServerFrame_Hello{
			Hello: c.srv.serverHello(true, "", ""),
		},
	}); err != nil {
		c.core.Close()
		return false
	}
	return true
}

func (c *channelConn) vetChannelHello(hello *gatewayv2.ClientHello) (helloVerdict, channelBinding) {
	if hello == nil {
		return helloVerdict{message: "hello frame is required"}, channelBinding{}
	}
	if hello.GetProtocolVersion() != ProtocolVersion {
		return helloVerdict{message: "unsupported protocol version"}, channelBinding{}
	}
	if hello.GetRole() != gatewayv2.ClientRole_CLIENT_ROLE_CHANNEL {
		return helloVerdict{message: "channel role is required"}, channelBinding{}
	}
	if c.cfg == nil || strings.TrimSpace(c.cfg.ChannelToken) == "" {
		return helloVerdict{message: "channel connector is disabled"}, channelBinding{}
	}
	if !auth.ValidateToken(hello.GetToken(), c.cfg.ChannelToken) {
		return helloVerdict{message: "unauthorized"}, channelBinding{}
	}
	binding := channelBinding{
		tenantID:    strings.TrimSpace(hello.GetChannelTenantId()),
		botID:       strings.TrimSpace(hello.GetChannelBotId()),
		connectorID: strings.TrimSpace(hello.GetConnectorId()),
		authAt:      time.Now().UTC(),
	}
	if binding.tenantID == "" || binding.botID == "" || binding.connectorID == "" {
		return helloVerdict{message: "channel tenant_id, bot_id and connector_id are required"}, channelBinding{}
	}
	if expected := strings.TrimSpace(c.cfg.ChannelTenantID); expected != "" && expected != binding.tenantID {
		return helloVerdict{message: "unexpected channel tenant"}, channelBinding{}
	}
	if expected := strings.TrimSpace(c.cfg.ChannelBotID); expected != "" && expected != binding.botID {
		return helloVerdict{message: "unexpected channel bot"}, channelBinding{}
	}
	if expected := strings.TrimSpace(c.cfg.ChannelConnectorID); expected != "" && expected != binding.connectorID {
		return helloVerdict{message: "unexpected channel connector"}, channelBinding{}
	}
	return helloVerdict{ok: true}, binding
}

func (c *channelConn) readFrame() (*gatewayv2.ChannelClientFrame, bool) {
	for {
		messageType, data, err := c.conn.ReadMessage()
		if err != nil {
			return nil, false
		}
		if messageType != websocket.BinaryMessage {
			continue
		}
		var frame gatewayv2.ChannelClientFrame
		if err := proto.Unmarshal(data, &frame); err != nil {
			return nil, false
		}
		return &frame, true
	}
}

func (c *channelConn) handleInbound(requestID string, inbound *gatewayv2.ChannelInboundMessage) {
	observability.Usage.V2ChannelRequestsTotal.Add(1)
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		requestID = "channel-" + uuid.NewString()
	}
	if err := validateChannelInbound(inbound); err != nil {
		_ = c.sendLocalError(requestID, err.Error())
		return
	}
	if strings.EqualFold(strings.TrimSpace(inbound.GetChatType()), "group") &&
		(c.cfg == nil || !c.cfg.ChannelAllowGroupMessages) {
		_ = c.sendLocalError(requestID, "group messages are disabled for this channel")
		return
	}

	conversationID := channelConversationID(c.binding, inbound)
	clientRequestID := channelRequestID(c.binding, inbound)
	channelCommand := strings.ToLower(strings.TrimSpace(inbound.GetCommand()))
	if existing, ok := c.sm.LookupChatCommand(clientRequestID); ok {
		if err := c.sendAccepted(requestID, inbound.GetExternalMessageId(), existing); err != nil {
			return
		}
		c.subscribeRun(requestID, inbound.GetExternalMessageId(), existing)
		return
	}
	if !c.sm.IsOnline() {
		_ = c.sendLocalError(requestID, "agent offline")
		return
	}
	probeCtx, probeCancel := context.WithTimeout(context.Background(), chatcmd.PrepareTimeout(c.cfg))
	probeErr := chatcmd.ProbeRuntimeForCommand(probeCtx, c.sm)
	probeCancel()
	if probeErr != nil {
		_ = c.sendLocalError(requestID, errorMessage(probeErr))
		return
	}

	uploadedFiles := []handler.ChatUploadedFileBody(nil)
	if len(inbound.GetFiles()) > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), c.requestTimeout())
		var err error
		uploadedFiles, err = c.importInboundFiles(ctx, inbound.GetFiles())
		cancel()
		if err != nil {
			_ = c.sendLocalError(requestID, errorMessage(err))
			return
		}
	}
	body := channelChatRequestBody(conversationID, clientRequestID, inbound, uploadedFiles)
	seededPayloads := channelSeededPayloads(channelCommand, body)

	runID := "channel-run-" + uuid.NewString()
	start := c.sm.StartChatCommand(
		runID,
		conversationID,
		"",
		clientRequestID,
		seededPayloads,
	)
	if start.PersistenceError != "" {
		_ = c.sendLocalError(requestID, "gateway command state is unavailable")
		return
	}
	if err := c.sendAccepted(requestID, inbound.GetExternalMessageId(), start); err != nil {
		return
	}
	c.subscribeRun(requestID, inbound.GetExternalMessageId(), start)
	if start.Deduped {
		// Another connector callback won the atomic dedupe race. Do not submit
		// the same external message to the desktop a second time.
		return
	}
	origin := channelTrustedOrigin(c.binding, inbound, start.RunID, channelCommand)
	go chatcmd.DispatchAcceptedCommandWithOrigin(
		context.Background(), c.cfg, c.sm, nil, start, body, nil,
		chatcmd.NewTraceID(), origin,
	)
}

func channelChatRequestBody(
	conversationID string,
	clientRequestID string,
	inbound *gatewayv2.ChannelInboundMessage,
	uploadedFiles []handler.ChatUploadedFileBody,
) handler.ChatRequestBody {
	return handler.ChatRequestBody{
		ConversationID:  conversationID,
		ClientRequestID: clientRequestID,
		Message:         strings.TrimSpace(inbound.GetText()),
		UploadedFiles:   uploadedFiles,
		// The connector already serializes turns per WeCom session. "append"
		// would park even the first turn of an idle conversation in the desktop
		// GUI queue, which only auto-drains after an active run becomes idle.
		QueuePolicy: "auto",
	}
}

func (c *channelConn) requestTimeout() time.Duration {
	if c.srv != nil {
		return c.srv.requestTimeout()
	}
	if c.cfg != nil && c.cfg.RequestTimeout > 0 {
		return c.cfg.RequestTimeout
	}
	return 2 * time.Minute
}

func (c *channelConn) importInboundFiles(
	ctx context.Context,
	files []*gatewayv2.ChannelInboundFile,
) ([]handler.ChatUploadedFileBody, error) {
	uploads := make([]*gatewayv1.UploadReadableFile, 0, len(files))
	for _, file := range files {
		if file == nil {
			return nil, errors.New("channel file is required")
		}
		uploads = append(uploads, &gatewayv1.UploadReadableFile{
			FileName: strings.TrimSpace(file.GetFileName()),
			MimeType: strings.TrimSpace(file.GetMimeType()),
			Content:  file.GetContent(),
		})
	}

	requestID := "channel-upload-" + uuid.NewString()
	env, err := c.sm.AwaitUnaryResponse(ctx, requestID, &gatewayv1.GatewayEnvelope{
		RequestId: requestID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_UploadReadableFiles{
			UploadReadableFiles: &gatewayv1.UploadReadableFilesRequest{
				// Channel principals inherit the desktop's current workspace. Empty
				// workdir therefore means staging-only for this internal request.
				Workdir: "",
				Files:   uploads,
			},
		},
	})
	if err != nil {
		return nil, err
	}
	if errResp := env.GetError(); errResp != nil {
		message := strings.TrimSpace(errResp.GetMessage())
		if message == "" {
			message = "channel file import failed"
		}
		return nil, errors.New(message)
	}
	resp := env.GetUploadReadableFilesResp()
	if resp == nil {
		return nil, errors.New("unexpected channel file import response")
	}
	if len(resp.GetFiles()) != len(files) || len(resp.GetSkipped()) > 0 {
		return nil, errors.New("one or more channel files could not be imported")
	}

	result := make([]handler.ChatUploadedFileBody, 0, len(resp.GetFiles()))
	for _, file := range resp.GetFiles() {
		if file == nil {
			return nil, errors.New("channel file import returned an empty file")
		}
		result = append(result, handler.ChatUploadedFileBody{
			RelativePath: file.GetRelativePath(),
			AbsolutePath: file.GetAbsolutePath(),
			FileName:     file.GetFileName(),
			Kind:         file.GetKind(),
			SizeBytes:    file.GetSizeBytes(),
		})
	}
	return result, nil
}

func channelTrustedOrigin(
	binding channelBinding,
	inbound *gatewayv2.ChannelInboundMessage,
	runID string,
	channelCommand string,
) *gatewayv1.TrustedOrigin {
	return &gatewayv1.TrustedOrigin{
		Channel:           channelName,
		TenantId:          binding.tenantID,
		BotId:             binding.botID,
		ExternalUserId:    strings.TrimSpace(inbound.GetExternalUserId()),
		ChatId:            strings.TrimSpace(inbound.GetChatId()),
		ChatType:          trustedChatType(inbound.GetChatType()),
		ExternalMessageId: strings.TrimSpace(inbound.GetExternalMessageId()),
		ConnectorId:       binding.connectorID,
		AuthenticatedAt:   binding.authAt.Unix(),
		// The desktop bridge validates this against the envelope request id,
		// which is the session run id, not the connector frame request id.
		GatewayRequestId: strings.TrimSpace(runID),
		ChannelSessionId: strings.TrimSpace(inbound.GetChannelSessionId()),
		ChannelCommand:   channelCommand,
	}
}

func validateChannelInbound(inbound *gatewayv2.ChannelInboundMessage) error {
	if inbound == nil {
		return errors.New("inbound message is required")
	}
	for label, value := range map[string]string{
		"external_message_id": inbound.GetExternalMessageId(),
		"external_user_id":    inbound.GetExternalUserId(),
		"chat_type":           inbound.GetChatType(),
		"channel_session_id":  inbound.GetChannelSessionId(),
	} {
		value = strings.TrimSpace(value)
		if value == "" {
			return errors.New(label + " is required")
		}
		if len(value) > channelMaxIDBytes {
			return errors.New(label + " is too long")
		}
		if !validChannelID(value) {
			return errors.New(label + " contains invalid characters")
		}
	}
	chatType := strings.ToLower(strings.TrimSpace(inbound.GetChatType()))
	if chatType != "single" && chatType != "group" {
		return errors.New("chat_type must be single or group")
	}
	chatID := strings.TrimSpace(inbound.GetChatId())
	if chatType == "group" && chatID == "" {
		return errors.New("chat_id is required for group messages")
	}
	if len(chatID) > channelMaxIDBytes {
		return errors.New("chat_id is too long")
	}
	if chatID != "" && !validChannelID(chatID) {
		return errors.New("chat_id contains invalid characters")
	}
	command := strings.ToLower(strings.TrimSpace(inbound.GetCommand()))
	text := strings.TrimSpace(inbound.GetText())
	files := inbound.GetFiles()
	if command != "" {
		if _, ok := channelCommandAllowlist[command]; !ok {
			return errors.New("unsupported channel command")
		}
		if text != "" || len(files) > 0 {
			return errors.New("channel commands must not include message text or files")
		}
	} else if text == "" && len(files) == 0 {
		return errors.New("text or files is required")
	}
	sessionID := strings.TrimSpace(inbound.GetChannelSessionId())
	if len(sessionID) > channelMaxSessionIDBytes {
		return errors.New("channel_session_id is too long")
	}
	if !validChannelSessionID(sessionID) {
		return errors.New("channel_session_id contains invalid characters")
	}
	if len(inbound.GetText()) > channelMaxTextSize {
		return errors.New("text is too long")
	}
	return validateChannelFiles(files)
}

func validateChannelFiles(files []*gatewayv2.ChannelInboundFile) error {
	if len(files) > channelMaxFiles {
		return errors.New("too many channel files")
	}
	totalBytes := 0
	for _, file := range files {
		if file == nil {
			return errors.New("channel file is required")
		}
		fileName := strings.TrimSpace(file.GetFileName())
		if fileName == "" {
			return errors.New("channel file_name is required")
		}
		if len(fileName) > channelMaxFileNameBytes {
			return errors.New("channel file_name is too long")
		}
		if !validChannelFileText(fileName) {
			return errors.New("channel file_name contains invalid characters")
		}
		mimeType := strings.TrimSpace(file.GetMimeType())
		if len(mimeType) > channelMaxMIMETypeBytes {
			return errors.New("channel file mime_type is too long")
		}
		if !validChannelFileText(mimeType) {
			return errors.New("channel file mime_type contains invalid characters")
		}
		fileBytes := len(file.GetContent())
		if fileBytes > channelMaxFileBytes {
			return errors.New("channel file is too large")
		}
		totalBytes += fileBytes
		if totalBytes > channelMaxFilesBytes {
			return errors.New("channel files are too large")
		}
	}
	return nil
}

func validChannelFileText(value string) bool {
	for _, r := range value {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func validChannelSessionID(value string) bool {
	for _, r := range strings.TrimSpace(value) {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' || r == ':' {
			continue
		}
		return false
	}
	return true
}

func channelSeededPayloads(command string, body handler.ChatRequestBody) []map[string]any {
	if strings.TrimSpace(command) != "" {
		// Control commands are not user prompts and must never appear in the
		// conversation transcript as a synthetic user message.
		return nil
	}
	return chatcmd.BuildAcceptedCommandPayloads(body, nil)
}

func validChannelID(value string) bool {
	for _, r := range strings.TrimSpace(value) {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func channelConversationID(binding channelBinding, inbound *gatewayv2.ChannelInboundMessage) string {
	chatType := strings.ToLower(strings.TrimSpace(inbound.GetChatType()))
	chatKey := "direct"
	if chatType == "group" {
		chatKey = strings.TrimSpace(inbound.GetChatId())
	}
	key := strings.Join([]string{
		channelName,
		binding.tenantID,
		binding.botID,
		trustedChatType(chatType),
		chatKey,
		strings.TrimSpace(inbound.GetExternalUserId()),
		strings.TrimSpace(inbound.GetChannelSessionId()),
	}, "\x00")
	digest := sha256.Sum256([]byte("conversation|" + key))
	return "wecom:" + fmtHex(digest[:])
}

func trustedChatType(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), "single") {
		return "direct"
	}
	return "group"
}

func channelRequestID(binding channelBinding, inbound *gatewayv2.ChannelInboundMessage) string {
	chatType := strings.ToLower(strings.TrimSpace(inbound.GetChatType()))
	chatKey := "direct"
	if chatType == "group" {
		chatKey = strings.TrimSpace(inbound.GetChatId())
	}
	key := strings.Join([]string{
		binding.tenantID,
		binding.botID,
		binding.connectorID,
		trustedChatType(chatType),
		chatKey,
		strings.TrimSpace(inbound.GetExternalUserId()),
		strings.TrimSpace(inbound.GetExternalMessageId()),
	}, "\x00")
	return "wecom-msg-" + channelDigest(binding.botID, key)
}

func channelDigest(secret, value string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(value))
	return fmtHex(mac.Sum(nil))
}

func fmtHex(value []byte) string {
	const hex = "0123456789abcdef"
	result := make([]byte, len(value)*2)
	for i, b := range value {
		result[i*2] = hex[b>>4]
		result[i*2+1] = hex[b&0x0f]
	}
	return string(result)
}

func channelInputText(
	record map[string]any,
	key string,
	maxBytes int,
	required bool,
) (string, bool) {
	raw, exists := record[key]
	if !exists {
		return "", !required
	}
	value, ok := raw.(string)
	if !ok {
		return "", false
	}
	value = strings.TrimSpace(value)
	if required && value == "" {
		return "", false
	}
	if len(value) > maxBytes || !validChannelInputText(value) {
		return "", false
	}
	return value, true
}

func validChannelInputText(value string) bool {
	for _, r := range value {
		if unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' {
			return false
		}
	}
	return true
}

func channelInputDeadline(value any) (int64, bool) {
	parsed, ok := channelUint64(value)
	if !ok || parsed == 0 || parsed > math.MaxInt64 {
		return 0, false
	}
	return int64(parsed), true
}

func channelInputRequestFromToolCall(
	requestID string,
	event *session.ConversationEvent,
	now time.Time,
) (*gatewayv2.ChannelInputRequest, *channelInputInteraction, bool) {
	if event == nil || event.Type != "tool_call" || event.Payload == nil {
		return nil, nil, false
	}
	name, _ := event.Payload["name"].(string)
	if strings.TrimSpace(name) != "AskUserQuestion" {
		return nil, nil, false
	}
	toolCallID := channelStringField(event.Payload, "id", "toolCallId", "tool_call_id")
	if toolCallID == "" || len(toolCallID) > channelMaxIDBytes || !validChannelID(toolCallID) {
		return nil, nil, false
	}
	arguments, ok := event.Payload["arguments"].(map[string]any)
	if !ok {
		return nil, nil, false
	}
	deadlineAtMS, ok := channelInputDeadline(arguments["__askUserQuestionDeadlineAt"])
	if !ok {
		return nil, nil, false
	}
	deadline := time.UnixMilli(deadlineAtMS)
	if !deadline.After(now) || deadline.After(now.Add(channelInputMaxFuture)) {
		return nil, nil, false
	}
	rawQuestions, ok := arguments["questions"].([]any)
	if !ok || len(rawQuestions) == 0 || len(rawQuestions) > channelInputMaxQuestions {
		return nil, nil, false
	}

	interactionID := "input-" + uuid.NewString()
	request := &gatewayv2.ChannelInputRequest{
		InteractionId:  interactionID,
		RunId:          event.RunID,
		ConversationId: event.ConversationID,
		Seq:            event.Seq,
		DeadlineAtMs:   deadlineAtMS,
		Questions:      make([]*gatewayv2.ChannelInputQuestion, 0, len(rawQuestions)),
	}
	interaction := &channelInputInteraction{
		id:             interactionID,
		requestID:      strings.TrimSpace(requestID),
		runID:          event.RunID,
		conversationID: event.ConversationID,
		toolCallID:     toolCallID,
		deadlineAtMS:   deadlineAtMS,
		questions:      make([]channelInputQuestionBinding, 0, len(rawQuestions)),
	}
	seenQuestionIDs := make(map[string]struct{}, len(rawQuestions))
	expectedOptionCount := 0
	totalBytes := 0
	for questionIndex, rawQuestion := range rawQuestions {
		record, ok := rawQuestion.(map[string]any)
		if !ok {
			return nil, nil, false
		}
		prompt, ok := channelInputText(record, "prompt", channelInputMaxPrompt, true)
		if !ok {
			return nil, nil, false
		}
		header, ok := channelInputText(record, "header", channelInputMaxHeader, false)
		if !ok {
			return nil, nil, false
		}
		questionID, ok := channelInputText(record, "id", channelMaxIDBytes, false)
		if !ok {
			return nil, nil, false
		}
		if questionID == "" {
			questionID = "q" + strconv.Itoa(questionIndex+1)
		}
		if !validChannelID(questionID) {
			return nil, nil, false
		}
		if _, duplicate := seenQuestionIDs[questionID]; duplicate {
			return nil, nil, false
		}
		seenQuestionIDs[questionID] = struct{}{}
		rawOptions, ok := record["options"].([]any)
		if !ok || len(rawOptions) < channelInputMinOptions || len(rawOptions) > channelInputMaxOptions {
			return nil, nil, false
		}
		if questionIndex == 0 {
			expectedOptionCount = len(rawOptions)
		} else if len(rawOptions) != expectedOptionCount {
			return nil, nil, false
		}

		questionAlias := "q" + strconv.Itoa(questionIndex+1)
		outputQuestion := &gatewayv2.ChannelInputQuestion{
			Id:      questionAlias,
			Header:  header,
			Prompt:  prompt,
			Options: make([]*gatewayv2.ChannelInputOption, 0, len(rawOptions)),
		}
		binding := channelInputQuestionBinding{
			id:         questionAlias,
			questionID: questionID,
			options:    make(map[string]channelInputOptionBinding, len(rawOptions)),
		}
		seenLabels := make(map[string]struct{}, len(rawOptions))
		recommendedCount := 0
		for optionIndex, rawOption := range rawOptions {
			optionRecord, ok := rawOption.(map[string]any)
			if !ok {
				return nil, nil, false
			}
			label, ok := channelInputText(optionRecord, "label", channelInputMaxLabel, true)
			if !ok {
				return nil, nil, false
			}
			description, ok := channelInputText(optionRecord, "description", channelInputMaxDesc, false)
			if !ok {
				return nil, nil, false
			}
			if _, duplicate := seenLabels[label]; duplicate {
				return nil, nil, false
			}
			seenLabels[label] = struct{}{}
			recommended := false
			if rawRecommended, exists := optionRecord["recommended"]; exists {
				recommended, ok = rawRecommended.(bool)
				if !ok {
					return nil, nil, false
				}
			}
			if recommended {
				recommendedCount++
				if recommendedCount > 1 {
					return nil, nil, false
				}
			}
			optionAlias := "o" + strconv.Itoa(optionIndex+1)
			outputQuestion.Options = append(outputQuestion.Options, &gatewayv2.ChannelInputOption{
				Id:          optionAlias,
				Label:       label,
				Description: description,
				Recommended: recommended,
			})
			binding.options[optionAlias] = channelInputOptionBinding{
				id:            optionAlias,
				selectedLabel: label,
			}
			totalBytes += len(label) + len(description)
		}
		totalBytes += len(header) + len(prompt)
		if totalBytes > channelInputMaxTotal {
			return nil, nil, false
		}
		request.Questions = append(request.Questions, outputQuestion)
		interaction.questions = append(interaction.questions, binding)
	}
	return request, interaction, true
}

func channelInputToolKey(runID, toolCallID string) string {
	return strings.TrimSpace(runID) + "\x00" + strings.TrimSpace(toolCallID)
}

func (c *channelConn) ensureInputStateLocked() {
	if c.inputs == nil {
		c.inputs = make(map[string]*channelInputInteraction)
	}
	if c.inputByTool == nil {
		c.inputByTool = make(map[string]string)
	}
	if c.inputTerminal == nil {
		c.inputTerminal = make(map[string]channelInputTerminal)
	}
}

func (c *channelConn) sweepInputTerminalLocked(now time.Time) {
	for interactionID, terminal := range c.inputTerminal {
		if !terminal.expiresAt.After(now) {
			delete(c.inputTerminal, interactionID)
		}
	}
}

func (c *channelConn) forwardInputRequest(requestID string, event *session.ConversationEvent) {
	request, interaction, ok := channelInputRequestFromToolCall(requestID, event, time.Now())
	if !ok {
		return
	}
	key := channelInputToolKey(interaction.runID, interaction.toolCallID)
	c.inputsMu.Lock()
	c.ensureInputStateLocked()
	c.sweepInputTerminalLocked(time.Now())
	if _, duplicate := c.inputByTool[key]; duplicate {
		c.inputsMu.Unlock()
		return
	}
	c.inputs[interaction.id] = interaction
	c.inputByTool[key] = interaction.id
	c.inputsMu.Unlock()

	if err := c.sendInputRequest(interaction.requestID, request); err != nil {
		c.inputsMu.Lock()
		if c.inputs[interaction.id] == interaction {
			delete(c.inputs, interaction.id)
			delete(c.inputByTool, key)
		}
		c.inputsMu.Unlock()
	}
}

type channelDesktopInputAnswer struct {
	QuestionID    string `json:"questionId"`
	SelectedLabel string `json:"selectedLabel"`
}

func (c *channelConn) translateInputAnswer(
	answer *gatewayv2.ChannelInputAnswer,
	now time.Time,
) (*channelInputInteraction, []channelDesktopInputAnswer, string, string) {
	if answer == nil {
		return nil, nil, "invalid_request", "input answer is required"
	}
	interactionID := strings.TrimSpace(answer.GetInteractionId())
	if interactionID == "" || len(interactionID) > channelMaxIDBytes || !validChannelID(interactionID) {
		return nil, nil, "invalid_request", "invalid interaction_id"
	}
	c.inputsMu.Lock()
	defer c.inputsMu.Unlock()
	c.ensureInputStateLocked()
	c.sweepInputTerminalLocked(now)
	interaction := c.inputs[interactionID]
	if interaction == nil {
		if _, resolved := c.inputTerminal[interactionID]; resolved {
			return nil, nil, "already_resolved", "input interaction is already resolved"
		}
		return nil, nil, "not_found", "input interaction was not found"
	}
	if interaction.deadlineAtMS <= now.UnixMilli() {
		return nil, nil, "expired", "input interaction has expired"
	}
	if interaction.answering {
		return nil, nil, "answer_in_progress", "an answer is already being submitted"
	}
	if interaction.answered {
		return nil, nil, "already_answered", "input interaction was already answered"
	}
	if len(answer.GetSelections()) != len(interaction.questions) {
		return nil, nil, "invalid_selection", "every question requires one selection"
	}
	selections := make(map[string]string, len(answer.GetSelections()))
	for _, selection := range answer.GetSelections() {
		if selection == nil {
			return nil, nil, "invalid_selection", "selection is required"
		}
		questionID := strings.TrimSpace(selection.GetQuestionId())
		optionID := strings.TrimSpace(selection.GetOptionId())
		if questionID == "" || optionID == "" {
			return nil, nil, "invalid_selection", "question_id and option_id are required"
		}
		if _, duplicate := selections[questionID]; duplicate {
			return nil, nil, "invalid_selection", "duplicate question selection"
		}
		selections[questionID] = optionID
	}
	translated := make([]channelDesktopInputAnswer, 0, len(interaction.questions))
	for _, question := range interaction.questions {
		optionID, exists := selections[question.id]
		if !exists {
			return nil, nil, "invalid_selection", "unknown or missing question_id"
		}
		option, exists := question.options[optionID]
		if !exists {
			return nil, nil, "invalid_selection", "unknown option_id"
		}
		translated = append(translated, channelDesktopInputAnswer{
			QuestionID:    question.questionID,
			SelectedLabel: option.selectedLabel,
		})
	}
	interaction.answering = true
	return interaction, translated, "", ""
}

func (c *channelConn) handleInputAnswer(requestID string, answer *gatewayv2.ChannelInputAnswer) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		requestID = "channel-input-answer-" + uuid.NewString()
	}
	interactionID := ""
	if answer != nil {
		interactionID = strings.TrimSpace(answer.GetInteractionId())
	}
	interaction, translated, status, message := c.translateInputAnswer(answer, time.Now())
	if interaction == nil {
		_ = c.sendInputAnswerResult(requestID, interactionID, false, status, message)
		return
	}

	accepted, responseStatus, responseMessage := c.submitInputAnswer(interaction, translated)
	c.inputsMu.Lock()
	if current := c.inputs[interaction.id]; current == interaction {
		current.answering = false
		if accepted {
			current.answered = true
		}
	}
	c.inputsMu.Unlock()
	_ = c.sendInputAnswerResult(
		requestID,
		interaction.id,
		accepted,
		responseStatus,
		responseMessage,
	)
}

func (c *channelConn) submitInputAnswer(
	interaction *channelInputInteraction,
	answers []channelDesktopInputAnswer,
) (bool, string, string) {
	requestJSON, err := json.Marshal(answers)
	if err != nil {
		return false, "invalid_request", "could not encode input answer"
	}
	remaining := time.Until(time.UnixMilli(interaction.deadlineAtMS))
	if remaining <= 0 {
		return false, "expired", "input interaction has expired"
	}
	timeout := c.requestTimeout()
	if remaining < timeout {
		timeout = remaining
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	requestID := "channel-input-answer-" + uuid.NewString()
	envelope, err := c.sm.AwaitUnaryResponse(ctx, requestID, &gatewayv1.GatewayEnvelope{
		RequestId: requestID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_ChatQueue{
			ChatQueue: &gatewayv1.ChatQueueRequest{
				Action:         "tool_answer",
				ConversationId: interaction.conversationID,
				ItemId:         interaction.toolCallID,
				RequestJson:    string(requestJSON),
			},
		},
	})
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return false, "expired", "input answer deadline elapsed"
		}
		return false, "unavailable", "desktop input handler is unavailable"
	}
	if envelope.GetError() != nil {
		return false, "rejected", "desktop rejected the input answer"
	}
	response := envelope.GetChatQueueResp()
	if response == nil {
		return false, "invalid_response", "desktop returned an invalid input response"
	}
	if response.GetAccepted() {
		return true, "accepted", ""
	}
	message := strings.TrimSpace(response.GetMessage())
	if len(message) > channelInputMaxPrompt || !validChannelInputText(message) {
		message = "desktop rejected the input answer"
	}
	return false, "rejected", message
}

func channelInputResolvedSelections(
	interaction *channelInputInteraction,
	payload map[string]any,
) []*gatewayv2.ChannelInputAnswerSelection {
	if interaction == nil || payload == nil {
		return nil
	}
	details, ok := payload["details"].(map[string]any)
	if !ok {
		return nil
	}
	rawAnswers, ok := details["answers"].([]any)
	if !ok || len(rawAnswers) != len(interaction.questions) {
		return nil
	}
	labelsByQuestion := make(map[string]string, len(rawAnswers))
	for _, rawAnswer := range rawAnswers {
		answer, ok := rawAnswer.(map[string]any)
		if !ok {
			return nil
		}
		questionID := channelStringField(answer, "questionId", "question_id")
		selectedLabel := channelStringField(answer, "selectedLabel", "selected_label")
		if questionID == "" || selectedLabel == "" {
			return nil
		}
		if _, duplicate := labelsByQuestion[questionID]; duplicate {
			return nil
		}
		labelsByQuestion[questionID] = selectedLabel
	}
	selections := make([]*gatewayv2.ChannelInputAnswerSelection, 0, len(interaction.questions))
	for _, question := range interaction.questions {
		selectedLabel, exists := labelsByQuestion[question.questionID]
		if !exists {
			return nil
		}
		selectedOptionID := ""
		for optionID, option := range question.options {
			if option.selectedLabel == selectedLabel {
				selectedOptionID = optionID
				break
			}
		}
		if selectedOptionID == "" {
			return nil
		}
		selections = append(selections, &gatewayv2.ChannelInputAnswerSelection{
			QuestionId: question.id,
			OptionId:   selectedOptionID,
		})
	}
	return selections
}

func channelInputResolutionStatus(payload map[string]any) string {
	if payload == nil {
		return "failed"
	}
	if details, ok := payload["details"].(map[string]any); ok {
		if cancelled, _ := details["cancelled"].(bool); cancelled {
			return "cancelled"
		}
		if timedOut, _ := details["timedOut"].(bool); timedOut {
			return "timed_out"
		}
	}
	if isError, _ := payload["isError"].(bool); isError {
		return "failed"
	}
	return "answered"
}

func (c *channelConn) detachInputLocked(
	interaction *channelInputInteraction,
	status string,
	now time.Time,
) {
	delete(c.inputs, interaction.id)
	delete(c.inputByTool, channelInputToolKey(interaction.runID, interaction.toolCallID))
	c.inputTerminal[interaction.id] = channelInputTerminal{
		status:    status,
		expiresAt: now.Add(channelInputTerminalTTL),
	}
}

func (c *channelConn) resolveInputToolEvent(event *session.ConversationEvent) {
	if event == nil || event.Payload == nil {
		return
	}
	name, _ := event.Payload["name"].(string)
	if strings.TrimSpace(name) != "AskUserQuestion" {
		return
	}
	toolCallID := channelStringField(event.Payload, "id", "toolCallId", "tool_call_id")
	if toolCallID == "" {
		return
	}
	status := channelInputResolutionStatus(event.Payload)
	now := time.Now()
	c.inputsMu.Lock()
	c.ensureInputStateLocked()
	interactionID := c.inputByTool[channelInputToolKey(event.RunID, toolCallID)]
	interaction := c.inputs[interactionID]
	if interaction != nil {
		c.detachInputLocked(interaction, status, now)
	}
	c.inputsMu.Unlock()
	if interaction == nil {
		return
	}
	_ = c.sendInputResolved(
		interaction.requestID,
		interaction.id,
		status,
		channelInputResolvedSelections(interaction, event.Payload),
		"",
	)
}

func (c *channelConn) resolveInputsForRun(runID, message string) {
	now := time.Now()
	c.inputsMu.Lock()
	c.ensureInputStateLocked()
	interactions := make([]*channelInputInteraction, 0)
	for _, interaction := range c.inputs {
		if interaction.runID != runID {
			continue
		}
		c.detachInputLocked(interaction, "run_finished", now)
		interactions = append(interactions, interaction)
	}
	c.inputsMu.Unlock()
	if len(message) > channelInputMaxPrompt || !validChannelInputText(message) {
		message = ""
	}
	for _, interaction := range interactions {
		_ = c.sendInputResolved(
			interaction.requestID,
			interaction.id,
			"run_finished",
			nil,
			message,
		)
	}
}

func channelPresentedFiles(payload map[string]any) ([]channelPresentedFile, bool) {
	if payload == nil {
		return nil, false
	}
	name, _ := payload["name"].(string)
	if strings.TrimSpace(name) != "PresentFile" {
		return nil, false
	}
	isError, ok := payload["isError"].(bool)
	if !ok || isError {
		return nil, false
	}
	details, ok := payload["details"].(map[string]any)
	if !ok {
		return nil, false
	}
	kind, _ := details["kind"].(string)
	if strings.TrimSpace(kind) != "display_file" {
		return nil, false
	}
	rawFiles, ok := details["files"].([]any)
	if !ok || len(rawFiles) == 0 || len(rawFiles) > channelMaxFiles {
		return nil, false
	}

	files := make([]channelPresentedFile, 0, len(rawFiles))
	var totalBytes uint64
	for _, rawFile := range rawFiles {
		item, ok := rawFile.(map[string]any)
		if !ok {
			return nil, false
		}
		path := channelStringField(item, "relativePath", "relative_path", "path")
		fileName := channelStringField(item, "fileName", "file_name")
		mimeType := channelStringField(item, "mimeType", "mime_type")
		fileID := channelStringField(item, "fileId", "file_id")
		sizeBytes, sizeOK := channelUint64(item["sizeBytes"])
		if !sizeOK {
			sizeBytes, sizeOK = channelUint64(item["size_bytes"])
		}
		mtimeMS, mtimeOK := channelUint64(item["mtimeMs"])
		if !mtimeOK {
			mtimeMS, mtimeOK = channelUint64(item["mtime_ms"])
		}
		if path == "" || fileName == "" || fileID == "" || !sizeOK || !mtimeOK || mtimeMS == 0 {
			return nil, false
		}
		if len(fileName) > channelMaxFileNameBytes || !validChannelFileText(fileName) ||
			len(mimeType) > channelMaxMIMETypeBytes || !validChannelFileText(mimeType) ||
			sizeBytes > channelMaxFileBytes {
			return nil, false
		}
		if totalBytes > channelMaxFilesBytes-sizeBytes {
			return nil, false
		}
		totalBytes += sizeBytes
		files = append(files, channelPresentedFile{
			path:      path,
			fileName:  fileName,
			mimeType:  mimeType,
			fileID:    fileID,
			sizeBytes: sizeBytes,
			mtimeMS:   mtimeMS,
		})
	}
	return files, true
}

func channelStringField(object map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := object[key].(string); ok {
			if value = strings.TrimSpace(value); value != "" {
				return value
			}
		}
	}
	return ""
}

func channelUint64(value any) (uint64, bool) {
	switch number := value.(type) {
	case uint64:
		return number, true
	case uint:
		return uint64(number), true
	case uint32:
		return uint64(number), true
	case int:
		if number >= 0 {
			return uint64(number), true
		}
	case int64:
		if number >= 0 {
			return uint64(number), true
		}
	case int32:
		if number >= 0 {
			return uint64(number), true
		}
	case float64:
		if number >= 0 && number <= channelMaxJSONInteger && math.Trunc(number) == number {
			return uint64(number), true
		}
	case float32:
		value := float64(number)
		if value >= 0 && value <= channelMaxJSONInteger && math.Trunc(value) == value {
			return uint64(value), true
		}
	case json.Number:
		parsed, err := number.Int64()
		if err == nil && parsed >= 0 {
			return uint64(parsed), true
		}
	}
	return 0, false
}

func (c *channelConn) readPresentedArtifact(
	ctx context.Context,
	workdir string,
	file channelPresentedFile,
) (*gatewayv1.FsReadWorkspaceArtifactResponse, error) {
	requestID := "channel-artifact-" + uuid.NewString()
	env, err := c.sm.AwaitUnaryResponse(ctx, requestID, &gatewayv1.GatewayEnvelope{
		RequestId: requestID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_FsReadWorkspaceArtifact{
			FsReadWorkspaceArtifact: &gatewayv1.FsReadWorkspaceArtifactRequest{
				Workdir:           workdir,
				Path:              file.path,
				ExpectedFileId:    file.fileID,
				ExpectedSizeBytes: file.sizeBytes,
				ExpectedMtimeMs:   file.mtimeMS,
			},
		},
	})
	if err != nil {
		return nil, err
	}
	if env.GetError() != nil {
		return nil, errors.New("desktop rejected the presented file")
	}
	resp := env.GetFsReadWorkspaceArtifactResp()
	if resp == nil {
		return nil, errors.New("unexpected workspace artifact response")
	}
	if strings.TrimSpace(resp.GetPath()) != file.path ||
		strings.TrimSpace(resp.GetFileName()) != file.fileName ||
		resp.GetSizeBytes() != file.sizeBytes ||
		uint64(len(resp.GetContent())) != resp.GetSizeBytes() ||
		len(resp.GetContent()) > channelMaxFileBytes {
		return nil, errors.New("workspace artifact metadata changed")
	}
	if file.mimeType != "" && !strings.EqualFold(strings.TrimSpace(resp.GetMimeType()), file.mimeType) {
		return nil, errors.New("workspace artifact mime type changed")
	}
	return resp, nil
}

func (c *channelConn) forwardPresentedFiles(
	requestID string,
	runID string,
	conversationID string,
	seq int64,
	files []channelPresentedFile,
) {
	workdir, ok := c.sm.ConversationRunWorkdir(conversationID, runID)
	if !ok {
		for _, file := range files {
			_ = c.sendRunFileError(requestID, runID, conversationID, seq, file)
		}
		return
	}
	c.forwardPresentedFilesFromWorkdir(requestID, runID, conversationID, seq, workdir, files)
}

func (c *channelConn) forwardPresentedFilesFromWorkdir(
	requestID string,
	runID string,
	conversationID string,
	seq int64,
	workdir string,
	files []channelPresentedFile,
) {
	workdir = strings.TrimSpace(workdir)
	if workdir == "" {
		for _, file := range files {
			_ = c.sendRunFileError(requestID, runID, conversationID, seq, file)
		}
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), c.requestTimeout())
	defer cancel()
	for _, file := range files {
		response, err := c.readPresentedArtifact(ctx, workdir, file)
		if err != nil {
			_ = c.sendRunFileError(requestID, runID, conversationID, seq, file)
			continue
		}
		mimeType := strings.TrimSpace(response.GetMimeType())
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}
		_ = c.sendRunFile(requestID, &gatewayv2.ChannelFile{
			RunId:          runID,
			ConversationId: conversationID,
			Seq:            seq,
			FileName:       response.GetFileName(),
			MimeType:       mimeType,
			SizeBytes:      response.GetSizeBytes(),
			Content:        response.GetContent(),
		})
	}
}

func (c *channelConn) sendRunFileError(
	requestID string,
	runID string,
	conversationID string,
	seq int64,
	file channelPresentedFile,
) error {
	mimeType := file.mimeType
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	return c.sendRunFile(requestID, &gatewayv2.ChannelFile{
		RunId:          runID,
		ConversationId: conversationID,
		Seq:            seq,
		FileName:       file.fileName,
		MimeType:       mimeType,
		SizeBytes:      file.sizeBytes,
		ErrorCode:      "file_unavailable",
		Message:        "The presented file is no longer available.",
	})
}

func (c *channelConn) sendAccepted(requestID, externalMessageID string, start session.ChatCommandStart) error {
	return c.send(wscore.FrameControl, "channel_accepted", &gatewayv2.ChannelServerFrame{
		RequestId: requestID,
		Payload: &gatewayv2.ChannelServerFrame_Accepted{
			Accepted: &gatewayv2.ChannelAccepted{
				ExternalMessageId: externalMessageID,
				RunId:             start.RunID,
				ConversationId:    start.ConversationID,
				Deduped:           start.Deduped,
			},
		},
	})
}

func (c *channelConn) subscribeRun(requestID, externalMessageID string, start session.ChatCommandStart) {
	if terminal := start.Terminal; terminal != nil {
		payload := make(map[string]any)
		_ = json.Unmarshal([]byte(terminal.PayloadJSON), &payload)
		for _, durableFile := range terminal.PresentedFiles {
			filePayload := make(map[string]any)
			if json.Unmarshal([]byte(durableFile.PayloadJSON), &filePayload) != nil {
				continue
			}
			files, ok := channelPresentedFiles(filePayload)
			if !ok {
				continue
			}
			c.forwardPresentedFilesFromWorkdir(
				requestID,
				start.RunID,
				start.ConversationID,
				durableFile.Seq,
				durableFile.Workdir,
				files,
			)
		}
		if text, ok := channelFinalResponseText(terminal.Status, payload); ok {
			_ = c.sendRunDelta(
				requestID, start.RunID, start.ConversationID, start.AcceptedSeq, text,
			)
		}
		_ = c.sendRunFinal(
			requestID, start.RunID, start.ConversationID,
			terminal.Status, terminal.ErrorCode, terminal.Message,
		)
		return
	}
	sub := c.sm.SubscribeConversationStream(start.ConversationID, start.AcceptedSeq, "")
	c.runsMu.Lock()
	c.runs[start.RunID] = sub.Cleanup
	c.runsMu.Unlock()
	go func() {
		defer func() {
			sub.Cleanup()
			c.runsMu.Lock()
			delete(c.runs, start.RunID)
			c.runsMu.Unlock()
		}()
		forward := func(event *session.ConversationEvent) bool {
			if event == nil || event.RunID != start.RunID {
				return false
			}
			// Restricted channel clients receive only the canonical final answer,
			// validated PresentFile artifacts, and the user-facing portion of the
			// explicitly allowlisted AskUserQuestion interaction.
			switch event.Type {
			case "tool_call":
				c.forwardInputRequest(requestID, event)
			case "tool_result":
				c.resolveInputToolEvent(event)
				files, ok := channelPresentedFiles(event.Payload)
				if !ok {
					return false
				}
				c.forwardPresentedFiles(
					requestID,
					start.RunID,
					start.ConversationID,
					event.Seq,
					files,
				)
			case session.StreamEventRunFinished:
				status, _ := event.Payload["status"].(string)
				errorCode, _ := event.Payload["error_code"].(string)
				message, _ := event.Payload["message"].(string)
				c.resolveInputsForRun(start.RunID, message)
				if text, ok := channelFinalResponseText(status, event.Payload); ok {
					_ = c.sendRunDelta(
						requestID,
						start.RunID,
						start.ConversationID,
						event.Seq,
						text,
					)
				}
				_ = c.sendRunFinal(
					requestID,
					start.RunID,
					start.ConversationID,
					status,
					errorCode,
					message,
				)
				return true
			}
			return false
		}
		resolvedReplayTools := channelResolvedReplayTools(sub.Events)
		for _, event := range sub.Events {
			if forwardReplayEvent(forward, event, resolvedReplayTools) {
				return
			}
		}
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-sub.EventCh:
				if !ok {
					if sub.Overflowed() {
						_ = c.sendLocalError(requestID, "channel stream overflowed")
					}
					return
				}
				if forward(event) {
					return
				}
			}
		}
	}()
}

// channelResolvedReplayTools identifies AskUserQuestion calls that already
// have a terminal result in the replay window. A deduplicated channel request
// can replay an entire completed run; emitting its historical input_request
// would otherwise make the connector render a stale card before the result.
func channelResolvedReplayTools(events []*session.ConversationEvent) map[string]struct{} {
	resolved := make(map[string]struct{})
	for _, event := range events {
		if event == nil || event.Type != "tool_result" || event.Payload == nil {
			continue
		}
		name, _ := event.Payload["name"].(string)
		if strings.TrimSpace(name) != "AskUserQuestion" {
			continue
		}
		toolCallID := channelStringField(event.Payload, "id", "toolCallId", "tool_call_id")
		if toolCallID == "" {
			continue
		}
		resolved[channelInputToolKey(event.RunID, toolCallID)] = struct{}{}
	}
	return resolved
}

func forwardReplayEvent(
	forward func(*session.ConversationEvent) bool,
	event *session.ConversationEvent,
	resolved map[string]struct{},
) bool {
	if event == nil || event.Type != "tool_call" || event.Payload == nil {
		return forward(event)
	}
	name, _ := event.Payload["name"].(string)
	if strings.TrimSpace(name) != "AskUserQuestion" {
		return forward(event)
	}
	toolCallID := channelStringField(event.Payload, "id", "toolCallId", "tool_call_id")
	if toolCallID != "" {
		if _, alreadyResolved := resolved[channelInputToolKey(event.RunID, toolCallID)]; alreadyResolved {
			return false
		}
	}
	return forward(event)
}

func (c *channelConn) sendRunDelta(
	requestID string,
	runID string,
	conversationID string,
	seq int64,
	text string,
) error {
	return c.send(wscore.FrameResponse, "channel_delta", &gatewayv2.ChannelServerFrame{
		RequestId: requestID,
		Payload: &gatewayv2.ChannelServerFrame_Delta{Delta: &gatewayv2.ChannelDelta{
			RunId: runID, ConversationId: conversationID, Seq: seq, Text: text,
		}},
	})
}

func (c *channelConn) sendInputRequest(
	requestID string,
	request *gatewayv2.ChannelInputRequest,
) error {
	return c.send(wscore.FrameResponse, "channel_input_request", &gatewayv2.ChannelServerFrame{
		RequestId: requestID,
		Payload: &gatewayv2.ChannelServerFrame_InputRequest{
			InputRequest: request,
		},
	})
}

func (c *channelConn) sendInputAnswerResult(
	requestID string,
	interactionID string,
	accepted bool,
	status string,
	message string,
) error {
	return c.send(wscore.FrameResponse, "channel_input_answer_result", &gatewayv2.ChannelServerFrame{
		RequestId: requestID,
		Payload: &gatewayv2.ChannelServerFrame_InputAnswerResult{
			InputAnswerResult: &gatewayv2.ChannelInputAnswerResult{
				InteractionId: interactionID,
				Accepted:      accepted,
				Status:        status,
				Message:       message,
			},
		},
	})
}

func (c *channelConn) sendInputResolved(
	requestID string,
	interactionID string,
	status string,
	selections []*gatewayv2.ChannelInputAnswerSelection,
	message string,
) error {
	return c.send(wscore.FrameResponse, "channel_input_resolved", &gatewayv2.ChannelServerFrame{
		RequestId: requestID,
		Payload: &gatewayv2.ChannelServerFrame_InputResolved{
			InputResolved: &gatewayv2.ChannelInputResolved{
				InteractionId: interactionID,
				Status:        status,
				Selections:    selections,
				Message:       message,
			},
		},
	})
}

func (c *channelConn) sendRunFile(requestID string, file *gatewayv2.ChannelFile) error {
	return c.send(wscore.FrameResponse, "channel_file", &gatewayv2.ChannelServerFrame{
		RequestId: requestID,
		Payload:   &gatewayv2.ChannelServerFrame_File{File: file},
	})
}

func (c *channelConn) sendRunFinal(
	requestID string,
	runID string,
	conversationID string,
	status string,
	errorCode string,
	message string,
) error {
	return c.send(wscore.FrameResponse, "channel_final", &gatewayv2.ChannelServerFrame{
		RequestId: requestID,
		Payload: &gatewayv2.ChannelServerFrame_Final{Final: &gatewayv2.ChannelFinal{
			RunId: runID, ConversationId: conversationID, Status: status,
			ErrorCode: errorCode, Message: message,
		}},
	})
}

func channelFinalResponseText(status string, payload map[string]any) (string, bool) {
	if !strings.EqualFold(strings.TrimSpace(status), "completed") {
		return "", false
	}
	if payload == nil {
		return "", false
	}
	text, _ := payload["final_text"].(string)
	if strings.TrimSpace(text) == "" {
		return "", false
	}
	return text, true
}

func (c *channelConn) send(class wscore.FrameClass, kind string, frame *gatewayv2.ChannelServerFrame) error {
	data, err := proto.Marshal(frame)
	if err != nil {
		return err
	}
	return c.core.Enqueue(wscore.Frame{Class: class, RequestID: frame.GetRequestId(), Kind: kind, MessageType: websocket.BinaryMessage, Data: data})
}

func (c *channelConn) sendLocalError(requestID, message string) error {
	return c.send(wscore.FrameControl, "local_error", &gatewayv2.ChannelServerFrame{
		RequestId: requestID,
		Payload:   &gatewayv2.ChannelServerFrame_LocalError{LocalError: &gatewayv1.ErrorResponse{Message: message}},
	})
}

func (c *channelConn) buildHeartbeatPing() (wscore.Frame, bool) {
	data, err := proto.Marshal(&gatewayv2.ChannelServerFrame{Payload: &gatewayv2.ChannelServerFrame_Ping{
		Ping: &gatewayv2.PingFrame{Timestamp: time.Now().Unix()},
	}})
	if err != nil {
		return wscore.Frame{}, false
	}
	return wscore.Frame{Class: wscore.FramePing, Kind: "ping", MessageType: websocket.BinaryMessage, Data: data}, true
}

func (c *channelConn) cleanupRuns() {
	c.runsMu.Lock()
	runs := make([]func(), 0, len(c.runs))
	for _, cleanup := range c.runs {
		runs = append(runs, cleanup)
	}
	c.runs = make(map[string]func())
	c.runsMu.Unlock()
	for _, cleanup := range runs {
		if cleanup != nil {
			cleanup()
		}
	}
	c.inputsMu.Lock()
	c.inputs = make(map[string]*channelInputInteraction)
	c.inputByTool = make(map[string]string)
	c.inputTerminal = make(map[string]channelInputTerminal)
	c.inputsMu.Unlock()
}
