package observability

import "sync/atomic"

// ProtoUsage 统计 v2 协议链路使用量：进程内原子计数，经 /api/status 的
// protocol_usage 字段暴露。（v1 计数器已随 v1 协议移除。）
type ProtoUsage struct {
	V2BrowserConnectionsTotal  atomic.Int64
	V2BrowserConnectionsActive atomic.Int64
	V2BrowserRequestsTotal     atomic.Int64
	V2AgentConnectsTotal       atomic.Int64
	V2AgentActive              atomic.Int64
	V2TerminalConnectsTotal    atomic.Int64
	V2ChannelConnectionsTotal  atomic.Int64
	V2ChannelConnectionsActive atomic.Int64
	V2ChannelRequestsTotal     atomic.Int64
}

// Usage 是进程级单例；各协议层直接打点。
var Usage ProtoUsage

// Snapshot 导出当前计数（键名即对外 JSON 字段名）。
func (u *ProtoUsage) Snapshot() map[string]int64 {
	return map[string]int64{
		// Deprecated: v1 协议已删除，这些键恒为 0。保留一个版本给仍在读取 v1 计数的
		// 外部监控/升级门禁一个过渡窗口（0 即"v1 流量为零"，语义真实），下个版本删除。
		"v1_ws_connections_total":          0,
		"v1_ws_connections_active":         0,
		"v1_ws_requests_total":             0,
		"v1_terminal_ws_connections_total": 0,
		"v1_grpc_agent_connects_total":     0,
		"v1_grpc_agent_active":             0,
		"v1_grpc_terminal_connects_total":  0,

		"v2_browser_connections_total":  u.V2BrowserConnectionsTotal.Load(),
		"v2_browser_connections_active": u.V2BrowserConnectionsActive.Load(),
		"v2_browser_requests_total":     u.V2BrowserRequestsTotal.Load(),
		"v2_agent_connects_total":       u.V2AgentConnectsTotal.Load(),
		"v2_agent_active":               u.V2AgentActive.Load(),
		"v2_terminal_connects_total":    u.V2TerminalConnectsTotal.Load(),
		"v2_channel_connections_total":  u.V2ChannelConnectionsTotal.Load(),
		"v2_channel_connections_active": u.V2ChannelConnectionsActive.Load(),
		"v2_channel_requests_total":     u.V2ChannelRequestsTotal.Load(),
	}
}
