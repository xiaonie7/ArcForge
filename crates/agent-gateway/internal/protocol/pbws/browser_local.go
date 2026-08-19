package pbws

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/liveagent/agent-gateway/internal/chatcmd"
	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
	"github.com/liveagent/agent-gateway/internal/transport/wscore"
)

// 由网关状态直接应答（或由网关编排）的本地操作，与 v1 各处理器逐一对应；chat 编排复用 internal/chatcmd。

// handleStatusGet 对应 v1 "status.get"。
func (c *browserConn) handleStatusGet(requestID string) {
	_ = c.send(wscore.FrameResponse, "status", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		Payload: &gatewayv2.WebServerFrame_Status{
			Status: statusEvent(c.sm.Status()),
		},
	})
}

// handleChatPrepare 对应 v1 "chat.prepare"：探活/唤醒桌面运行时后返回与 status_get
// 同构的状态（新旧客户端共享一个状态归一化器）。
func (c *browserConn) handleChatPrepare(requestID string, _ *gatewayv2.ChatPrepareRequest) {
	ctx, cancel := context.WithTimeout(context.Background(), chatcmd.PrepareTimeout(c.cfg))
	defer cancel()
	if err := chatcmd.ProbeRuntime(ctx, c.sm); err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}
	// 与 v1 的 writePriorityResponse 等价：走控制队列，避免被数据积压饿死。
	_ = c.send(wscore.FrameControl, "status", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		Payload: &gatewayv2.WebServerFrame_Status{
			Status: statusEvent(c.sm.Status()),
		},
	})
}

// handleChatActivities 对应 v1 "chat.activities"：仅由网关状态应答，桌面端离线时亦可用。
func (c *browserConn) handleChatActivities(requestID string) {
	activities := c.sm.ActiveConversationActivities()
	running := make([]*gatewayv2.ChatRunActivity, 0, len(activities))
	for _, activity := range activities {
		running = append(running, chatRunActivityListItem(activity))
	}
	_ = c.send(wscore.FrameResponse, "chat_activities", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		Payload: &gatewayv2.WebServerFrame_ChatActivities{
			ChatActivities: &gatewayv2.ChatActivitiesResult{RunningConversations: running},
		},
	})
}

// handleChatCommand 对应 v1 "chat.command"：submit / edit_resend 经网关编排
// （去重、接受即回执、命令更新观察、启动看门狗、投递），cancel 单独处理。
func (c *browserConn) handleChatCommand(requestID string, cmd *gatewayv1.ChatCommandRequest) {
	commandType := strings.TrimSpace(cmd.GetType())
	body := chatcmd.RequestBodyFromProto(cmd.GetRequest())
	baseMessageRef := chatcmd.MessageRefFromProto(cmd.GetBaseMessageRef())

	switch commandType {
	case "chat.submit":
		baseMessageRef = nil
	case "chat.edit_resend":
		if baseMessageRef == nil {
			_ = c.sendLocalError(requestID, "base_message_ref is required")
			return
		}
		if err := chatcmd.ValidateMessageRef(baseMessageRef); err != nil {
			_ = c.sendLocalError(requestID, err.Error())
			return
		}
	case "chat.cancel":
		c.handleChatCancel(requestID, cmd.GetCancel())
		return
	default:
		_ = c.sendLocalError(requestID, "unsupported chat command")
		return
	}

	if err := chatcmd.NormalizeRequestBody(&body); err != nil {
		_ = c.sendLocalError(requestID, err.Error())
		return
	}

	if existing, ok := c.sm.LookupChatCommand(body.ClientRequestID); ok {
		c.respondChatCommandDeduped(requestID, body.ClientRequestID, existing)
		return
	}

	if !c.sm.IsOnline() {
		_ = c.sendLocalError(requestID, "agent offline")
		return
	}
	probeCtx, probeCancel := context.WithTimeout(
		context.Background(), chatcmd.PrepareTimeout(c.cfg),
	)
	probeErr := chatcmd.ProbeRuntimeForCommand(probeCtx, c.sm)
	probeCancel()
	if probeErr != nil {
		_ = c.sendLocalError(requestID, errorMessage(probeErr))
		return
	}

	runID := "chat-command-" + uuid.NewString()
	start := c.sm.StartChatCommand(
		runID,
		body.ConversationID,
		body.Workdir,
		body.ClientRequestID,
		chatcmd.BuildAcceptedCommandPayloads(body, baseMessageRef),
	)
	if start.PersistenceError != "" {
		_ = c.sendLocalError(requestID, "gateway command state is unavailable")
		return
	}
	if start.Deduped {
		c.respondChatCommandDeduped(requestID, body.ClientRequestID, start)
		return
	}
	updates, cleanupWatch := c.sm.WatchChatCommand(start.RunID)

	_ = c.sendChatCommandAccepted(requestID, start)

	go c.forwardChatCommandUpdates(updates, cleanupWatch)
	go chatcmd.DispatchAcceptedCommand(
		context.Background(), c.cfg, c.sm, cleanupWatch, start, body, baseMessageRef, chatcmd.NewTraceID(),
	)
}

// respondChatCommandDeduped 用既有运行应答重复的 client_request_id。持久化终态直接
// 回放；仍在当前进程中的运行继续观察前置阶段更新。
func (c *browserConn) respondChatCommandDeduped(
	requestID string,
	clientRequestID string,
	start session.ChatCommandStart,
) {
	_ = c.sendChatCommandAccepted(requestID, start)
	if start.Terminal != nil {
		_ = c.sendChatCommandTerminalReplay(clientRequestID, start)
		return
	}
	updates, cleanupWatch := c.sm.WatchChatCommand(start.RunID)
	go c.forwardChatCommandUpdates(updates, cleanupWatch)
	cleanupChatCommandWatchAfter(c.cfg, start.Recovering, cleanupWatch)
}

func (c *browserConn) sendChatCommandTerminalReplay(
	clientRequestID string,
	start session.ChatCommandStart,
) error {
	terminal := start.Terminal
	if terminal == nil {
		return nil
	}
	phase := strings.ToLower(strings.TrimSpace(terminal.Status))
	switch phase {
	case "completed", "failed", "cancelled", "unknown":
	default:
		phase = "unknown"
	}
	message := strings.TrimSpace(terminal.Message)
	runStarted := false
	var payload map[string]any
	if json.Unmarshal([]byte(terminal.PayloadJSON), &payload) == nil {
		runStarted, _ = payload["run_started"].(bool)
	}
	if phase == "completed" {
		if payload != nil {
			if finalText, ok := payload["final_text"].(string); ok && strings.TrimSpace(finalText) != "" {
				message = finalText
			}
		}
	}
	if message == "" {
		switch phase {
		case "failed":
			message = "The command failed."
		case "cancelled":
			message = "The command was cancelled."
		case "unknown":
			message = "The command outcome is unknown."
		}
	}
	return c.send(wscore.FrameControl, "chat_command_update", &gatewayv2.WebServerFrame{
		Payload: &gatewayv2.WebServerFrame_ChatCommandUpdate{
			ChatCommandUpdate: chatCommandUpdate(session.ChatCommandUpdate{
				RunID:           start.RunID,
				ClientRequestID: strings.TrimSpace(clientRequestID),
				ConversationID:  start.ConversationID,
				Phase:           phase,
				ErrorCode:       terminal.ErrorCode,
				Message:         message,
				RunStarted:      runStarted,
			}),
		},
	})
}

func (c *browserConn) sendChatCommandAccepted(requestID string, start session.ChatCommandStart) error {
	// 与 v1 的优先响应等价：接受回执延迟敏感，走控制队列。
	return c.send(wscore.FrameControl, "chat_accepted", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		Payload: &gatewayv2.WebServerFrame_ChatAccepted{
			ChatAccepted: &gatewayv2.ChatCommandAccepted{
				RunId:          start.RunID,
				ConversationId: start.ConversationID,
				AcceptedSeq:    start.AcceptedSeq,
				Deduped:        start.Deduped,
			},
		},
	})
}

// forwardChatCommandUpdates 把前置阶段结果（bound / queued_in_gui / failed）推给
// 发起命令的连接（走控制队列）。
func (c *browserConn) forwardChatCommandUpdates(
	updates <-chan session.ChatCommandUpdate,
	cleanup func(),
) {
	if cleanup != nil {
		defer cleanup()
	}
	for {
		select {
		case <-c.done:
			return
		case update, ok := <-updates:
			if !ok {
				return
			}
			if err := c.send(wscore.FrameControl, "chat_command_update", &gatewayv2.WebServerFrame{
				Payload: &gatewayv2.WebServerFrame_ChatCommandUpdate{
					ChatCommandUpdate: chatCommandUpdate(update),
				},
			}); err != nil {
				return
			}
		}
	}
}

// cleanupChatCommandWatchAfter 为去重提交的更新观察流设兜底关闭窗口
// （与 v1 同：AfterFunc 不占 goroutine，cleanup 幂等）。
func cleanupChatCommandWatchAfter(cfg *config.Config, recovering bool, cleanup func()) {
	if cleanup == nil {
		return
	}
	time.AfterFunc(chatCommandWatchTimeout(cfg, recovering), cleanup)
}

func chatCommandWatchTimeout(cfg *config.Config, recovering bool) time.Duration {
	timeout := chatcmd.StartTimeout(cfg) + chatcmd.RenderStartTimeout(cfg)
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	if recovering && timeout < 45*time.Second {
		timeout = 45 * time.Second
	}
	return timeout
}

const chatCancelWatchdogTimeout = 15 * time.Second

// handleChatCancel 对应 v1 "chat.cancel"。
func (c *browserConn) handleChatCancel(requestID string, cancelReq *gatewayv1.CancelChatRequest) {
	conversationID := strings.TrimSpace(cancelReq.GetConversationId())
	if conversationID == "" {
		_ = c.sendLocalError(requestID, "conversation_id is required")
		return
	}
	if !c.sm.IsOnline() {
		_ = c.sendLocalError(requestID, "agent offline")
		return
	}

	// 不终结运行：活动状态翻为 cancelling，以桌面端终态信号为准，超时由看门狗强制收尾。
	runID, active := c.sm.MarkConversationCancelling(conversationID, strings.TrimSpace(cancelReq.GetRunId()))
	if !active {
		_ = c.sendChatCancelResult(requestID, true, "", conversationID)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), c.srv.writeTimeout())
	defer cancel()

	if err := c.sm.SendToAgentContext(ctx, &gatewayv1.GatewayEnvelope{
		RequestId: runID,
		Timestamp: time.Now().Unix(),
		Payload:   chatcmd.BuildCancelCommandPayload(conversationID),
	}); err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}

	go watchChatCancel(c.sm, runID)
	_ = c.sendChatCancelResult(requestID, true, runID, conversationID)
}

func (c *browserConn) sendChatCancelResult(requestID string, ok bool, runID, conversationID string) error {
	return c.send(wscore.FrameResponse, "chat_cancelled", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		Payload: &gatewayv2.WebServerFrame_ChatCancelled{
			ChatCancelled: &gatewayv2.ChatCancelResult{
				Ok:             ok,
				RunId:          runID,
				ConversationId: conversationID,
			},
		},
	})
}

func watchChatCancel(sm *session.Manager, runID string) {
	time.Sleep(chatCancelWatchdogTimeout)
	sm.ForceFinishRun(runID, "cancelled", "cancel_timeout",
		"The desktop runtime did not confirm the cancellation in time.")
}
