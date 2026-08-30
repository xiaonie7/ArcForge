// Package pbws 实现 v2 统一线协议（WebSocket+Protobuf）服务端的三条链路（见 proto/v2/gateway_ws.proto）：
// /ws/v2 浏览器直通、/ws/v2/agent 桌面端信封流、/ws/v2/terminal 终端数据面。
// 本包只做帧编解码、鉴权握手、直通白名单与事件扇出；会话状态复用 session，
// 传输运行时复用 wscore，跨协议域逻辑复用 shared 与 chatcmd。
package pbws

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/protocol/shared"
	"github.com/liveagent/agent-gateway/internal/session"
)

// Subprotocol 是 v2 的 WebSocket 子协议名；服务端必须回显，否则浏览器主动断开握手。
const Subprotocol = "liveagent.v2.pb"

// ProtocolVersion 是本包实现的协议版本号（ClientHello.protocol_version）。
const ProtocolVersion = 2

// closeCodeUnauthorized 是鉴权失败时的自定义关闭码（4000-4999 为应用保留段）。
const closeCodeUnauthorized = 4401

// Server 聚合三条 v2 链路的依赖，由 http 路由层构造一次、复用于全部连接。
type Server struct {
	cfg              *config.Config
	sm               *session.Manager
	channelsMu       sync.Mutex
	channels         map[string]*channelConn
	bindingPending   map[string]*channelBindingPending
	bindingSnapshots map[string]map[string]*gatewayv1.ChannelBindingRegistration
}

// NewServer 构造 v2 协议服务端。
func NewServer(cfg *config.Config, sm *session.Manager) *Server {
	return &Server{cfg: cfg, sm: sm}
}

func (s *Server) upgrader() websocket.Upgrader {
	return websocket.Upgrader{
		Subprotocols: []string{Subprotocol},
		CheckOrigin: func(r *http.Request) bool {
			return shared.OriginAllowed(r)
		},
	}
}

// readLimit 复用 GRPCMaxMessageBytes 配置（历史命名保留，语义为消息大小上限）。
func (s *Server) readLimit() int64 {
	if s.cfg != nil && s.cfg.GRPCMaxMessageBytes > 0 {
		return int64(s.cfg.GRPCMaxMessageBytes)
	}
	return int64(config.DefaultGRPCMaxMessageBytes)
}

func (s *Server) heartbeatPeriod() time.Duration {
	if s.cfg != nil && s.cfg.WebSocketHeartbeatPeriod > 0 {
		return s.cfg.WebSocketHeartbeatPeriod
	}
	return 15 * time.Second
}

func (s *Server) writeTimeout() time.Duration {
	if s.cfg != nil && s.cfg.WebSocketWriteTimeout > 0 {
		return s.cfg.WebSocketWriteTimeout
	}
	return 10 * time.Second
}

func (s *Server) requestTimeout() time.Duration {
	if s.cfg != nil && s.cfg.RequestTimeout > 0 {
		return s.cfg.RequestTimeout
	}
	return 2 * time.Minute
}

// errorMessage 把内部错误映射为对客户端友好的信息（与 v1 一致）。
func errorMessage(err error) string {
	if err == nil {
		return "request failed"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "request timed out"
	}
	if errors.Is(err, context.Canceled) {
		return "request canceled"
	}
	if errors.Is(err, session.ErrAgentOffline) {
		return "agent offline"
	}
	return err.Error()
}

// writeDirectMessage 在写泵启动前（握手阶段）直接写出一条二进制帧。
func writeDirectMessage(conn *websocket.Conn, timeout time.Duration, msg proto.Message) error {
	data, err := proto.Marshal(msg)
	if err != nil {
		return err
	}
	if timeout > 0 {
		if err := conn.SetWriteDeadline(time.Now().Add(timeout)); err != nil {
			return err
		}
		defer func() {
			_ = conn.SetWriteDeadline(time.Time{})
		}()
	}
	return conn.WriteMessage(websocket.BinaryMessage, data)
}
