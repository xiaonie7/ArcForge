package pbws

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
	"github.com/liveagent/agent-gateway/internal/transport/wscore"
	"google.golang.org/protobuf/proto"
)

// Only authenticated agent requests can enter this relay. The browser
// allowlist deliberately excludes ChannelBindingResponse and never accepts
// AgentEnvelope. No routing state or operation outcome is invented here.
type channelBindingPending struct {
	owner       *channelConn
	operationID string
	answer      chan *gatewayv1.ChannelBindingResponse
}

func (s *Server) registerLifecycleChannel(c *channelConn) {
	s.channelsMu.Lock()
	defer s.channelsMu.Unlock()
	if s.channels == nil {
		s.channels = make(map[string]*channelConn)
	}
	s.channels[channelInstallationID(c.binding)] = c
}

func (s *Server) unregisterLifecycleChannel(c *channelConn) {
	s.channelsMu.Lock()
	defer s.channelsMu.Unlock()
	key := channelInstallationID(c.binding)
	if s.channels[key] == c {
		delete(s.channels, key)
	}
}

func (s *Server) receiveBindingResponse(c *channelConn, requestID string, response *gatewayv1.ChannelBindingResponse) {
	if response == nil {
		return
	}
	s.channelsMu.Lock()
	pending := s.bindingPending[requestID]
	s.channelsMu.Unlock()
	if pending == nil || pending.owner != c || pending.operationID != response.GetOperationId() {
		return
	}
	select {
	case pending.answer <- response:
	default:
	}
}

func (s *Server) relayBinding(ctx context.Context, request *gatewayv1.ChannelBindingRequest) *gatewayv1.ChannelBindingResponse {
	result := &gatewayv1.ChannelBindingResponse{OperationId: request.GetOperationId(), Status: "unavailable"}
	if request == nil || strings.TrimSpace(request.GetOperationId()) == "" || len(request.GetOperationId()) > 256 ||
		(request.GetAction() != "close" && request.GetAction() != "query") || request.GetInstallationId() == "" ||
		len(request.GetInstallationId()) > 4096 || request.GetScopeKey() == "" || len(request.GetScopeKey()) > 2048 ||
		request.GetExpectedSessionId() == "" || len(request.GetExpectedSessionId()) > 128 ||
		request.GetExpectedGeneration() == 0 || request.GetExpectedGeneration() > channelMaxJSONInteger {
		result.Status = "conflict"
		result.Message = "Invalid binding lifecycle request"
		return result
	}
	s.channelsMu.Lock()
	c := s.channels[request.GetInstallationId()]
	if c == nil {
		s.channelsMu.Unlock()
		return result
	}
	if c.binding.lifecycleVersion != 1 {
		s.channelsMu.Unlock()
		result.Status = "unsupported"
		return result
	}
	if len(s.bindingPending) >= 256 {
		s.channelsMu.Unlock()
		result.Status = "busy"
		return result
	}
	if s.bindingPending == nil {
		s.bindingPending = make(map[string]*channelBindingPending)
	}
	requestID := "binding-" + uuid.NewString()
	pending := &channelBindingPending{owner: c, operationID: request.GetOperationId(), answer: make(chan *gatewayv1.ChannelBindingResponse, 1)}
	s.bindingPending[requestID] = pending
	s.channelsMu.Unlock()
	defer func() { s.channelsMu.Lock(); delete(s.bindingPending, requestID); s.channelsMu.Unlock() }()
	if err := c.send(wscore.FrameResponse, requestID, &gatewayv2.ChannelServerFrame{
		RequestId: requestID,
		Payload:   &gatewayv2.ChannelServerFrame_BindingRequest{BindingRequest: request},
	}); err != nil {
		return result
	}
	select {
	case answer := <-pending.answer:
		return answer
	case <-c.done:
		return result
	case <-ctx.Done():
		return result
	}
}

func (s *Server) handleAgentBindingRequest(parent context.Context, sess *session.AgentSession, requestID string, request *gatewayv1.ChannelBindingRequest) {
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	result := s.relayBinding(ctx, request)
	// Bind the response to the originating agent connection, not a replacement.
	_ = sess.SendToAgentContext(parent, &gatewayv1.GatewayEnvelope{
		RequestId: requestID, Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_ChannelBindingResp{ChannelBindingResp: result},
	})
}

func bindingSnapshotKey(registration *gatewayv1.ChannelBindingRegistration) string {
	// One installation has exactly one current route per opaque adapter scope.
	// Replacing by scope bounds memory across session rotations while retaining
	// the latest route needed for a later agent reconnect.
	return registration.GetScopeKey()
}

func rememberCurrentBinding(current map[string]*gatewayv1.ChannelBindingRegistration, registration *gatewayv1.ChannelBindingRegistration) {
	if registration == nil {
		return
	}
	key := bindingSnapshotKey(registration)
	existing := current[key]
	if existing != nil {
		if registration.GetGeneration() < existing.GetGeneration() {
			return
		}
		// A generation identifies one immutable route. If a broken or stale
		// connector presents a different session at the same generation, retain
		// the first authenticated route instead of making reconnect replay depend
		// on goroutine/page arrival order.
		if registration.GetGeneration() == existing.GetGeneration() &&
			registration.GetSessionId() != existing.GetSessionId() {
			return
		}
	}
	current[key] = proto.Clone(registration).(*gatewayv1.ChannelBindingRegistration)
}

func (s *Server) rememberBindingSnapshot(installationID string, registrations []*gatewayv1.ChannelBindingRegistration) {
	s.channelsMu.Lock()
	defer s.channelsMu.Unlock()
	if s.bindingSnapshots == nil {
		s.bindingSnapshots = make(map[string]map[string]*gatewayv1.ChannelBindingRegistration)
	}
	current := s.bindingSnapshots[installationID]
	if current == nil {
		current = make(map[string]*gatewayv1.ChannelBindingRegistration, len(registrations))
		s.bindingSnapshots[installationID] = current
	}
	for _, registration := range registrations {
		rememberCurrentBinding(current, registration)
	}
}

func (s *Server) rememberInboundBinding(c *channelConn, inbound *gatewayv2.ChannelInboundMessage, conversationID string) {
	if c == nil || c.binding.lifecycleVersion != 1 || inbound == nil {
		return
	}
	registration := &gatewayv1.ChannelBindingRegistration{
		ConversationId:   conversationID,
		InstallationId:   channelInstallationID(c.binding),
		ScopeKey:         inbound.GetChannelScopeKey(),
		SessionId:        inbound.GetChannelSessionId(),
		Generation:       inbound.GetChannelSessionGeneration(),
		LifecycleVersion: 1,
	}
	s.channelsMu.Lock()
	defer s.channelsMu.Unlock()
	if s.bindingSnapshots == nil {
		s.bindingSnapshots = make(map[string]map[string]*gatewayv1.ChannelBindingRegistration)
	}
	bindings := s.bindingSnapshots[registration.GetInstallationId()]
	if bindings == nil {
		bindings = make(map[string]*gatewayv1.ChannelBindingRegistration)
		s.bindingSnapshots[registration.GetInstallationId()] = bindings
	}
	rememberCurrentBinding(bindings, registration)
}

func (s *Server) replayBindingSnapshots(ctx context.Context, sess *session.AgentSession) {
	s.channelsMu.Lock()
	snapshots := make([][]*gatewayv1.ChannelBindingRegistration, 0, len(s.bindingSnapshots))
	for _, stored := range s.bindingSnapshots {
		registrations := make([]*gatewayv1.ChannelBindingRegistration, 0, len(stored))
		for _, registration := range stored {
			registrations = append(registrations, proto.Clone(registration).(*gatewayv1.ChannelBindingRegistration))
		}
		snapshots = append(snapshots, registrations)
	}
	s.channelsMu.Unlock()
	for _, registrations := range snapshots {
		for offset := 0; offset < len(registrations); offset += 100 {
			end := min(offset+100, len(registrations))
			deliveryCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := sess.SendToAgentContext(deliveryCtx, &gatewayv1.GatewayEnvelope{
				RequestId: "channel-bindings-replay-" + uuid.NewString(), Timestamp: time.Now().Unix(),
				Payload: &gatewayv1.GatewayEnvelope_ChannelBindingsSnapshot{ChannelBindingsSnapshot: &gatewayv1.ChannelBindingsSnapshot{Bindings: registrations[offset:end]}},
			})
			cancel()
			if err != nil {
				return
			}
		}
	}
}

func (c *channelConn) forwardBindingSnapshot(snapshot *gatewayv2.ChannelSessionSnapshot) {
	if c.binding.lifecycleVersion != 1 || snapshot == nil || len(snapshot.GetBindings()) > 100 {
		return
	}
	registrations := make([]*gatewayv1.ChannelBindingRegistration, 0, len(snapshot.GetBindings()))
	for _, original := range snapshot.GetBindings() {
		if validateChannelBindingSnapshotEntry(original) != nil {
			return
		}
		inbound := proto.Clone(original).(*gatewayv2.ChannelInboundMessage)
		registrations = append(registrations, &gatewayv1.ChannelBindingRegistration{
			ConversationId: channelConversationID(c.binding, inbound), InstallationId: channelInstallationID(c.binding),
			ScopeKey: inbound.GetChannelScopeKey(), SessionId: inbound.GetChannelSessionId(), Generation: inbound.GetChannelSessionGeneration(), LifecycleVersion: 1,
		})
	}
	c.srv.rememberBindingSnapshot(channelInstallationID(c.binding), registrations)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = c.sm.SendToAgentContext(ctx, &gatewayv1.GatewayEnvelope{
		RequestId: "channel-bindings-" + uuid.NewString(), Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_ChannelBindingsSnapshot{ChannelBindingsSnapshot: &gatewayv1.ChannelBindingsSnapshot{Bindings: registrations}},
	})
}

// Snapshot rows intentionally contain no message body or message id. Their
// scope key is an opaque, installation-local adapter contract: the Gateway
// validates bounds and identity fields but never interprets a vendor format.
func validateChannelBindingSnapshotEntry(inbound *gatewayv2.ChannelInboundMessage) error {
	if inbound == nil {
		return errors.New("channel binding snapshot entry is required")
	}
	if inbound.GetText() != "" || inbound.GetCommand() != "" || len(inbound.GetFiles()) != 0 {
		return errors.New("channel binding snapshot must not contain message content")
	}
	for label, value := range map[string]string{
		"external_user_id":   inbound.GetExternalUserId(),
		"chat_type":          inbound.GetChatType(),
		"channel_session_id": inbound.GetChannelSessionId(),
	} {
		value = strings.TrimSpace(value)
		if value == "" {
			return errors.New(label + " is required")
		}
		if len(value) > channelMaxIDBytes || !validChannelID(value) {
			return errors.New("invalid " + label)
		}
	}
	chatType := strings.ToLower(strings.TrimSpace(inbound.GetChatType()))
	if chatType != "single" && chatType != "group" {
		return errors.New("chat_type must be single or group")
	}
	chatID := strings.TrimSpace(inbound.GetChatId())
	if chatType == "group" && chatID == "" {
		return errors.New("chat_id is required for group bindings")
	}
	if len(chatID) > channelMaxIDBytes || (chatID != "" && !validChannelID(chatID)) {
		return errors.New("invalid chat_id")
	}
	sessionID := strings.TrimSpace(inbound.GetChannelSessionId())
	if len(sessionID) > channelMaxSessionIDBytes || !validChannelSessionID(sessionID) {
		return errors.New("invalid channel_session_id")
	}
	scopeKey := strings.TrimSpace(inbound.GetChannelScopeKey())
	if scopeKey == "" || len(inbound.GetChannelScopeKey()) > 2048 {
		return errors.New("invalid channel_scope_key")
	}
	if inbound.GetChannelSessionGeneration() == 0 || inbound.GetChannelSessionGeneration() > channelMaxJSONInteger {
		return errors.New("invalid channel_session_generation")
	}
	return nil
}
