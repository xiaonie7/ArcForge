package pbws

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"net/http"
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
			cfg:  s.cfg,
			sm:   s.sm,
			srv:  s,
			conn: conn,
			runs: make(map[string]func()),
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
	body := handler.ChatRequestBody{
		ConversationID:  conversationID,
		ClientRequestID: clientRequestID,
		Message:         strings.TrimSpace(inbound.GetText()),
		QueuePolicy:     "append",
	}
	seededPayloads := channelSeededPayloads(channelCommand, body)
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

	runID := "channel-run-" + uuid.NewString()
	start := c.sm.StartChatCommand(
		runID,
		conversationID,
		"",
		clientRequestID,
		seededPayloads,
	)
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
	if command != "" {
		if _, ok := channelCommandAllowlist[command]; !ok {
			return errors.New("unsupported channel command")
		}
		if text != "" {
			return errors.New("channel commands must not include message text")
		}
	} else if text == "" {
		return errors.New("text is required")
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
	return nil
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
			switch event.Type {
			case "token":
				text, ok := channelVisibleTokenText(event.Payload)
				if !ok {
					return false
				}
				_ = c.send(wscore.FrameData, "channel_delta", &gatewayv2.ChannelServerFrame{
					RequestId: requestID,
					Payload: &gatewayv2.ChannelServerFrame_Delta{Delta: &gatewayv2.ChannelDelta{
						RunId: start.RunID, ConversationId: start.ConversationID, Seq: event.Seq, Text: text,
					}},
				})
			case session.StreamEventRunFinished:
				status, _ := event.Payload["status"].(string)
				errorCode, _ := event.Payload["error_code"].(string)
				message, _ := event.Payload["message"].(string)
				_ = c.send(wscore.FrameControl, "channel_final", &gatewayv2.ChannelServerFrame{
					RequestId: requestID,
					Payload: &gatewayv2.ChannelServerFrame_Final{Final: &gatewayv2.ChannelFinal{
						RunId: start.RunID, ConversationId: start.ConversationID, Status: status,
						ErrorCode: errorCode, Message: message,
					}},
				})
				return true
			}
			return false
		}
		for _, event := range sub.Events {
			if forward(event) {
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

func channelVisibleTokenText(payload map[string]any) (string, bool) {
	if payload == nil {
		return "", false
	}
	if _, internalCheckpoint := payload["checkpoint"]; internalCheckpoint {
		return "", false
	}
	if api, _ := payload["api"].(string); strings.EqualFold(strings.TrimSpace(api), "arcforge-compaction") {
		return "", false
	}
	text, _ := payload["text"].(string)
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
}
