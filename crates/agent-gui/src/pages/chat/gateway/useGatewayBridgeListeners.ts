import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { type ChannelPermissionProfile, channelControl } from "../../../lib/channelControl";
import type { HistoryMessageRef } from "../../../lib/chat/conversation/conversationState";
import {
  derivePrincipalConversationId,
  type PrincipalContext,
  resolvePrincipalContext,
} from "../../../lib/security/principalContext";
import { normalizeChatRuntimeControls, normalizeSystemToolSelection } from "../../../lib/settings";
import { createUuid } from "../../../lib/shared/id";
import {
  type ActiveGatewayBridgeRequest,
  type ChannelPermissionProfileSnapshot,
  freezeChannelPermissionProfile,
  type GatewayBridgeRuntimeRefs,
  type GatewayChatCancelEvent,
  type GatewayChatClaimedRequest,
  type GatewayChatRequestReadyEvent,
  normalizeGatewayExecutionMode,
  normalizeGatewayWorkdir,
} from "./gatewayBridgeTypes";

type UseGatewayBridgeListenersParams = GatewayBridgeRuntimeRefs & {
  /** Group WeCom messages are opt-in and checked before queueing or execution. */
  allowWecomGroupMessages: boolean;
  queueGatewayBridgeEventForRequest: (
    requestId: string,
    event: Record<string, unknown>,
    options?: { workerId?: string },
  ) => Promise<void> | void;
  shouldQueueGatewayChatRequest: (
    conversationId: string,
    queuePolicy: "auto" | "append" | "interrupt",
  ) => boolean;
  enqueueGatewayChatRequest: (
    claimed: GatewayChatClaimedRequest,
    conversationId: string,
    principal: PrincipalContext | undefined,
    permissionProfile: ChannelPermissionProfileSnapshot | undefined,
    workerId: string,
  ) => Promise<boolean>;
  isConversationRunning: (conversationId: string) => boolean;
  getConversationAbortController: (conversationId: string) => AbortController | null;
};

type GatewayBridgeRequestRegistry = {
  activeRequests: Map<string, ActiveGatewayBridgeRequest>;
  pendingRequestIds: Set<string>;
  pendingClientRequestIds: Set<string>;
  pendingConversationIds: Set<string>;
};

type GatewayBridgeClaimResult =
  | "claimed"
  | "duplicate_request"
  | "duplicate_client_request"
  | "conversation_busy";

const GATEWAY_CHAT_RUNTIME_LEASE_MS = 15_000;
const GATEWAY_CHAT_RUNTIME_HEARTBEAT_MS = 2_500;
const GATEWAY_CHAT_RUNTIME_IDLE_POLL_MS = 1_000;
const GATEWAY_CHAT_RUNTIME_STATUS_HEARTBEAT_MS = 2_000;
const GATEWAY_CHAT_CONVERSATION_BUSY_MESSAGE =
  "Another remote gateway chat request is already running.";

const gatewayBridgeRequestRegistry = (() => {
  const root = globalThis as typeof globalThis & {
    __ARCFORGE_GATEWAY_BRIDGE_REQUESTS__?: GatewayBridgeRequestRegistry;
  };
  root.__ARCFORGE_GATEWAY_BRIDGE_REQUESTS__ ??= {
    activeRequests: new Map<string, ActiveGatewayBridgeRequest>(),
    pendingRequestIds: new Set<string>(),
    pendingClientRequestIds: new Set<string>(),
    pendingConversationIds: new Set<string>(),
  };
  root.__ARCFORGE_GATEWAY_BRIDGE_REQUESTS__.pendingConversationIds ??= new Set<string>();
  return root.__ARCFORGE_GATEWAY_BRIDGE_REQUESTS__;
})();

function asErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallback;
}

function isConversationAlreadyRunningError(message: string) {
  return message.trim().startsWith("Conversation is already running:");
}

function normalizeQueuePolicy(value: string | null | undefined): "auto" | "append" | "interrupt" {
  switch (value?.trim()) {
    case "append":
      return "append";
    case "interrupt":
      return "interrupt";
    default:
      return "auto";
  }
}

function normalizeGatewayBaseMessageRef(value: unknown): HistoryMessageRef | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as {
    segmentIndex?: unknown;
    messageIndex?: unknown;
    segmentId?: unknown;
    messageId?: unknown;
    role?: unknown;
    contentHash?: unknown;
  };
  const segmentIndex =
    typeof candidate.segmentIndex === "number" && Number.isFinite(candidate.segmentIndex)
      ? Math.trunc(candidate.segmentIndex)
      : -1;
  const messageIndex =
    typeof candidate.messageIndex === "number" && Number.isFinite(candidate.messageIndex)
      ? Math.trunc(candidate.messageIndex)
      : -1;
  const segmentId = typeof candidate.segmentId === "string" ? candidate.segmentId.trim() : "";
  const messageId = typeof candidate.messageId === "string" ? candidate.messageId.trim() : "";
  const role = typeof candidate.role === "string" ? candidate.role.trim() : "";
  const contentHash = typeof candidate.contentHash === "string" ? candidate.contentHash.trim() : "";
  if (
    segmentIndex < 0 ||
    messageIndex < 0 ||
    !segmentId ||
    !messageId ||
    role !== "user" ||
    !contentHash
  ) {
    return undefined;
  }
  return {
    segmentIndex,
    messageIndex,
    segmentId,
    messageId,
    role,
    contentHash,
  };
}

export function useGatewayBridgeListeners(params: UseGatewayBridgeListenersParams) {
  const latestParamsRef = useRef(params);
  latestParamsRef.current = params;
  const workerIdRef = useRef("");
  if (!workerIdRef.current) {
    workerIdRef.current = `gateway-chat-runtime-${createUuid()}`;
  }

  useEffect(() => {
    let disposed = false;
    let unlistenChatRequestReady: (() => void) | null = null;
    let unlistenChatRuntimeWake: (() => void) | null = null;
    let unlistenChatCancel: (() => void) | null = null;
    let unlistenGatewayStatus: (() => void) | null = null;
    let drainInFlight = false;
    const workerId = workerIdRef.current;
    const heartbeatTimers = new Map<string, number>();

    const activeRuntimeRequestCount = () =>
      gatewayBridgeRequestRegistry.activeRequests.size +
      gatewayBridgeRequestRegistry.pendingRequestIds.size;

    const runtimeVisible = () =>
      typeof document === "undefined" ? true : document.visibilityState !== "hidden";

    const publishRuntimeHeartbeat = (state?: "ready" | "draining" | "busy" | "suspended") => {
      const activeRunCount = activeRuntimeRequestCount();
      const nextState = state ?? (activeRunCount > 0 ? "busy" : "ready");
      void invoke("gateway_chat_runtime_heartbeat", {
        worker_id: workerId,
        state: nextState,
        visible: runtimeVisible(),
        active_run_count: activeRunCount,
      } as any).catch((error) => {
        console.warn("gateway_chat_runtime_heartbeat failed", error);
      });
    };

    const setActiveGatewayBridgeRequest = (request: ActiveGatewayBridgeRequest) => {
      gatewayBridgeRequestRegistry.pendingRequestIds.delete(request.requestId);
      if (request.clientRequestId) {
        gatewayBridgeRequestRegistry.pendingClientRequestIds.delete(request.clientRequestId);
      }
      gatewayBridgeRequestRegistry.pendingConversationIds.delete(request.conversationId);
      gatewayBridgeRequestRegistry.activeRequests.set(request.requestId, request);
      publishRuntimeHeartbeat("busy");
      return request;
    };

    const clearActiveGatewayBridgeRequest = (requestId: string) => {
      gatewayBridgeRequestRegistry.activeRequests.delete(requestId.trim());
      publishRuntimeHeartbeat();
    };

    const getActiveGatewayBridgeRequestByRequestId = (requestId: string) => {
      return gatewayBridgeRequestRegistry.activeRequests.get(requestId.trim()) ?? null;
    };

    const getActiveGatewayBridgeRequestByConversationId = (conversationId: string) => {
      const targetConversationId = conversationId.trim();
      if (!targetConversationId) {
        return null;
      }

      for (const request of gatewayBridgeRequestRegistry.activeRequests.values()) {
        if (request.conversationId === targetConversationId) {
          return request;
        }
      }
      return null;
    };

    const getActiveGatewayBridgeRequestByClientRequestId = (clientRequestId: string) => {
      const targetClientRequestId = clientRequestId.trim();
      if (!targetClientRequestId) {
        return null;
      }

      for (const request of gatewayBridgeRequestRegistry.activeRequests.values()) {
        if (request.clientRequestId === targetClientRequestId) {
          return request;
        }
      }
      return null;
    };

    const claimGatewayBridgeRequest = (
      requestId: string,
      clientRequestId: string,
      conversationId: string,
    ): GatewayBridgeClaimResult => {
      const targetConversationId = conversationId.trim();
      if (
        gatewayBridgeRequestRegistry.pendingRequestIds.has(requestId) ||
        gatewayBridgeRequestRegistry.activeRequests.has(requestId)
      ) {
        return "duplicate_request";
      }
      if (
        clientRequestId &&
        (gatewayBridgeRequestRegistry.pendingClientRequestIds.has(clientRequestId) ||
          getActiveGatewayBridgeRequestByClientRequestId(clientRequestId))
      ) {
        return "duplicate_client_request";
      }
      if (
        targetConversationId &&
        (gatewayBridgeRequestRegistry.pendingConversationIds.has(targetConversationId) ||
          getActiveGatewayBridgeRequestByConversationId(targetConversationId))
      ) {
        return "conversation_busy";
      }
      gatewayBridgeRequestRegistry.pendingRequestIds.add(requestId);
      if (clientRequestId) {
        gatewayBridgeRequestRegistry.pendingClientRequestIds.add(clientRequestId);
      }
      if (targetConversationId) {
        gatewayBridgeRequestRegistry.pendingConversationIds.add(targetConversationId);
      }
      publishRuntimeHeartbeat("busy");
      return "claimed";
    };

    const releaseGatewayBridgeRequestClaim = (
      requestId: string,
      clientRequestId: string,
      conversationId: string,
      request: ActiveGatewayBridgeRequest | null,
    ) => {
      gatewayBridgeRequestRegistry.pendingRequestIds.delete(requestId);
      if (clientRequestId) {
        gatewayBridgeRequestRegistry.pendingClientRequestIds.delete(clientRequestId);
      }
      if (conversationId) {
        gatewayBridgeRequestRegistry.pendingConversationIds.delete(conversationId);
      }
      if (request) {
        clearActiveGatewayBridgeRequest(request.requestId);
      }
      publishRuntimeHeartbeat();
    };

    const stopHeartbeat = (requestId: string) => {
      const timer = heartbeatTimers.get(requestId);
      if (timer !== undefined) {
        window.clearInterval(timer);
        heartbeatTimers.delete(requestId);
      }
    };

    const startHeartbeat = (requestId: string) => {
      stopHeartbeat(requestId);
      publishRuntimeHeartbeat("busy");
      void invoke("gateway_chat_heartbeat", {
        request_id: requestId,
        worker_id: workerId,
      } as any).catch((error) => {
        console.warn("gateway_chat_heartbeat failed", error);
      });
      heartbeatTimers.set(
        requestId,
        window.setInterval(() => {
          void invoke("gateway_chat_heartbeat", {
            request_id: requestId,
            worker_id: workerId,
          } as any).catch((error) => {
            console.warn("gateway_chat_heartbeat failed", error);
          });
        }, GATEWAY_CHAT_RUNTIME_HEARTBEAT_MS),
      );
    };

    const failClaimedRequest = (
      requestId: string,
      conversationId: string,
      errorCode: string,
      message: string,
    ) => {
      void invoke("gateway_chat_fail", {
        request_id: requestId,
        conversation_id: conversationId || undefined,
        error_code: errorCode,
        message,
        terminal: true,
        worker_id: workerId,
      } as any).catch((error) => {
        console.warn("gateway_chat_fail failed", error);
      });
    };

    const markQueuedInGui = async (
      claimed: GatewayChatClaimedRequest,
      conversationId: string,
      principal?: PrincipalContext,
      permissionProfile?: ChannelPermissionProfileSnapshot,
    ) => {
      const requestId = claimed.requestId.trim();
      if (!requestId) return false;
      const queued = await latestParamsRef.current.enqueueGatewayChatRequest(
        claimed,
        conversationId,
        principal,
        permissionProfile,
        workerId,
      );
      if (!queued) return false;
      await invoke("gateway_chat_mark_queued_in_gui", {
        request_id: requestId,
        conversation_id: conversationId,
        worker_id: workerId,
      } as any);
      stopHeartbeat(requestId);
      return true;
    };

    const handleGatewayChatRequest = async (claimed: GatewayChatClaimedRequest) => {
      const payload = claimed.request;
      const requestId = payload.requestId.trim();
      const clientRequestId = payload.clientRequestId?.trim() ?? "";
      const message = payload.message.trim();
      const uploadedFiles = Array.isArray(payload.uploadedFiles) ? payload.uploadedFiles : [];
      let targetConversationId = payload.conversationId.trim();
      const queuePolicy = normalizeQueuePolicy(payload.queuePolicy);
      let resolvedConversationId = targetConversationId;
      let gatewayBridgeRequest: ActiveGatewayBridgeRequest | null = null;
      let principal: PrincipalContext | undefined;
      let permissionProfile: ChannelPermissionProfileSnapshot | undefined;
      let claimedRequest = false;

      if (!requestId) {
        return;
      }
      // The claimed lease starts before trusted-origin and permission
      // resolution. Renew it immediately so slow policy reads cannot let the
      // 15-second startup lease expire before the request reaches the runtime.
      startHeartbeat(requestId);
      if (payload.origin) {
        try {
          principal = await resolvePrincipalContext(payload.origin, requestId);
          // The connector cannot select or reuse a conversation id. Derive the
          // owner-scoped id from the authenticated principal instead.
          targetConversationId = await derivePrincipalConversationId(principal);
          resolvedConversationId = targetConversationId;
        } catch (error) {
          const message = asErrorMessage(error, "Invalid trusted channel identity.");
          failClaimedRequest(requestId, targetConversationId, "invalid_channel_identity", message);
          stopHeartbeat(requestId);
          return;
        }
        let resolvedPermissionProfile: ChannelPermissionProfile | null;
        try {
          resolvedPermissionProfile = await channelControl.resolveEffectiveProfile({
            installationId: principal.installationId,
            userId: principal.externalUserId,
            conversationId: principal.chatType === "group" ? principal.chatId : undefined,
          });
        } catch (error) {
          const message = asErrorMessage(
            error,
            "Failed to resolve the trusted channel permission profile.",
          );
          failClaimedRequest(
            requestId,
            targetConversationId,
            "channel_permission_resolution_failed",
            message,
          );
          stopHeartbeat(requestId);
          return;
        }
        if (!resolvedPermissionProfile) {
          failClaimedRequest(
            requestId,
            targetConversationId,
            "channel_permission_denied",
            "No enabled permission profile is bound to this channel identity.",
          );
          stopHeartbeat(requestId);
          return;
        }
        try {
          permissionProfile = freezeChannelPermissionProfile(resolvedPermissionProfile);
        } catch (error) {
          const message = asErrorMessage(
            error,
            "The trusted channel permission profile is invalid.",
          );
          failClaimedRequest(
            requestId,
            targetConversationId,
            "channel_permission_invalid",
            message,
          );
          stopHeartbeat(requestId);
          return;
        }
      }
      if (principal?.chatType === "group" && !latestParamsRef.current.allowWecomGroupMessages) {
        const message = "WeCom group messages are disabled in this desktop app.";
        latestParamsRef.current.queueGatewayBridgeEventForRequest(
          requestId,
          { type: "error", message, conversation_id: targetConversationId },
          { workerId },
        );
        failClaimedRequest(requestId, targetConversationId, "group_messages_disabled", message);
        stopHeartbeat(requestId);
        return;
      }
      if (principal?.channelCommand === "help") {
        const message = "WeCom /help is handled by the authenticated connector.";
        latestParamsRef.current.queueGatewayBridgeEventForRequest(
          requestId,
          { type: "error", message, conversation_id: targetConversationId },
          { workerId },
        );
        failClaimedRequest(requestId, targetConversationId, "unsupported_channel_command", message);
        stopHeartbeat(requestId);
        return;
      }
      if (!message && uploadedFiles.length === 0 && !principal?.channelCommand) {
        latestParamsRef.current.queueGatewayBridgeEventForRequest(
          requestId,
          {
            type: "error",
            message: "Remote chat message cannot be empty.",
            conversation_id: targetConversationId,
          },
          {
            workerId,
          },
        );
        failClaimedRequest(
          requestId,
          targetConversationId,
          "empty_remote_message",
          "Remote chat message cannot be empty.",
        );
        stopHeartbeat(requestId);
        return;
      }
      const claimResult = claimGatewayBridgeRequest(
        requestId,
        clientRequestId,
        targetConversationId,
      );
      if (claimResult !== "claimed") {
        if (principal?.channelCommand === "new" && claimResult === "conversation_busy") {
          latestParamsRef.current.queueGatewayBridgeEventForRequest(
            requestId,
            {
              type: "error",
              message: GATEWAY_CHAT_CONVERSATION_BUSY_MESSAGE,
              conversation_id: targetConversationId,
            },
            { workerId },
          );
          failClaimedRequest(
            requestId,
            targetConversationId,
            "conversation_busy",
            GATEWAY_CHAT_CONVERSATION_BUSY_MESSAGE,
          );
          stopHeartbeat(requestId);
          return;
        }
        if (claimResult === "conversation_busy") {
          if (targetConversationId) {
            try {
              if (
                await markQueuedInGui(claimed, targetConversationId, principal, permissionProfile)
              ) {
                return;
              }
            } catch (error) {
              console.warn("queue remote gateway chat request failed", error);
            }
          }
        }
        void invoke("gateway_chat_release_lease", {
          request_id: requestId,
          worker_id: workerId,
        } as any).catch((error) => {
          console.warn("gateway_chat_release_lease failed", error);
        });
        stopHeartbeat(requestId);
        return;
      }
      claimedRequest = true;

      try {
        const duplicateRequest =
          getActiveGatewayBridgeRequestByRequestId(requestId) ||
          (clientRequestId
            ? getActiveGatewayBridgeRequestByClientRequestId(clientRequestId)
            : null);
        if (duplicateRequest) {
          void invoke("gateway_chat_release_lease", {
            request_id: requestId,
            worker_id: workerId,
          } as any).catch((error) => {
            console.warn("gateway_chat_release_lease failed", error);
          });
          return;
        }
        const baseMessageRef =
          payload.rebased === true
            ? normalizeGatewayBaseMessageRef(payload.baseMessageRef)
            : undefined;
        if (payload.rebased === true && !baseMessageRef) {
          const message = "Remote edit_resend command is missing base_message_ref.";
          latestParamsRef.current.queueGatewayBridgeEventForRequest(
            requestId,
            {
              type: "error",
              message,
              conversation_id: targetConversationId,
            },
            {
              workerId,
            },
          );
          failClaimedRequest(requestId, targetConversationId, "invalid_chat_command", message);
          return;
        }

        if (
          targetConversationId &&
          payload.rebased !== true &&
          (latestParamsRef.current.shouldQueueGatewayChatRequest(
            targetConversationId,
            queuePolicy,
          ) ||
            latestParamsRef.current.isConversationRunning(targetConversationId) ||
            latestParamsRef.current.getConversationAbortController(targetConversationId))
        ) {
          if (principal?.channelCommand === "new") {
            throw new Error(`Conversation is already running: ${targetConversationId}`);
          }
          if (await markQueuedInGui(claimed, targetConversationId, principal, permissionProfile)) {
            return;
          }
          return;
        }

        resolvedConversationId =
          await latestParamsRef.current.ensureGatewayBridgeConversationReadyRef.current(
            targetConversationId,
            {
              rebased: payload.rebased === true,
              baseMessageRef,
              createIfMissing: Boolean(principal),
            },
          );

        const runningRequest =
          getActiveGatewayBridgeRequestByConversationId(resolvedConversationId) ||
          (clientRequestId
            ? getActiveGatewayBridgeRequestByClientRequestId(clientRequestId)
            : null);
        if (
          latestParamsRef.current.shouldQueueGatewayChatRequest(
            resolvedConversationId,
            queuePolicy,
          ) ||
          runningRequest ||
          latestParamsRef.current.isConversationRunning(resolvedConversationId) ||
          latestParamsRef.current.getConversationAbortController(resolvedConversationId)
        ) {
          if (principal?.channelCommand === "new") {
            throw new Error(`Conversation is already running: ${resolvedConversationId}`);
          }
          if (
            await markQueuedInGui(
              claimed,
              runningRequest?.conversationId || resolvedConversationId,
              principal,
              permissionProfile,
            )
          ) {
            return;
          }
          return;
        }

        if (principal?.channelCommand === "new") {
          await invoke("gateway_chat_mark_started", {
            request_id: requestId,
            conversation_id: resolvedConversationId,
            worker_id: workerId,
          } as any);
          await latestParamsRef.current.queueGatewayBridgeEventForRequest(
            requestId,
            {
              type: "done",
              final_text: "已开启新会话。",
              conversation_id: resolvedConversationId,
            },
            { workerId },
          );
          await invoke("gateway_chat_complete", {
            request_id: requestId,
            conversation_id: resolvedConversationId,
            worker_id: workerId,
          } as any);
          return;
        }

        gatewayBridgeRequest = setActiveGatewayBridgeRequest({
          requestId,
          conversationId: resolvedConversationId,
          clientRequestId: clientRequestId || undefined,
          workerId,
          startedAt: Date.now(),
          selectedModelOverride: principal ? undefined : payload.selectedModel,
          runtimeControlsOverride:
            !principal && payload.runtimeControls
              ? normalizeChatRuntimeControls(payload.runtimeControls)
              : undefined,
          executionModeOverride: principal
            ? undefined
            : normalizeGatewayExecutionMode(payload.executionMode),
          workdirOverride: principal ? undefined : normalizeGatewayWorkdir(payload.workdir),
          selectedSystemToolIdsOverride: principal
            ? undefined
            : normalizeSystemToolSelection(payload.selectedSystemTools),
          principal,
          permissionProfile,
        });
        const markRuntimeStarted = async () => {
          await invoke("gateway_chat_mark_started", {
            request_id: requestId,
            conversation_id: resolvedConversationId,
            worker_id: workerId,
          } as any);
        };
        const accepted = await latestParamsRef.current.sendActionRef.current({
          textOverride: message,
          uploadedFilesOverride: uploadedFiles,
          conversationIdOverride: resolvedConversationId,
          executionModeOverride: gatewayBridgeRequest.executionModeOverride,
          workdirOverride: gatewayBridgeRequest.workdirOverride,
          selectedSystemToolIdsOverride: gatewayBridgeRequest.selectedSystemToolIdsOverride,
          runtimeControlsOverride: gatewayBridgeRequest.runtimeControlsOverride,
          gatewayBridgeRequestOverride: gatewayBridgeRequest,
          beforeRuntimeStart: markRuntimeStarted,
          afterInitialHistoryPersist: markRuntimeStarted,
        });
        if (!accepted) {
          failClaimedRequest(
            requestId,
            resolvedConversationId,
            "desktop_runtime_rejected",
            "Desktop app rejected the remote gateway chat request.",
          );
          return;
        }
        await invoke("gateway_chat_complete", {
          request_id: requestId,
          conversation_id: resolvedConversationId,
          worker_id: workerId,
        } as any);
      } catch (error) {
        const rawMessage = asErrorMessage(
          error,
          "Failed to execute the remote gateway chat request.",
        );
        const conversationBusy = isConversationAlreadyRunningError(rawMessage);
        const message = conversationBusy ? GATEWAY_CHAT_CONVERSATION_BUSY_MESSAGE : rawMessage;
        latestParamsRef.current.queueGatewayBridgeEventForRequest(
          requestId,
          {
            type: "error",
            message,
            conversation_id:
              resolvedConversationId ||
              targetConversationId ||
              latestParamsRef.current.currentConversationIdRef.current,
          },
          {
            workerId,
          },
        );
        failClaimedRequest(
          requestId,
          resolvedConversationId ||
            targetConversationId ||
            latestParamsRef.current.currentConversationIdRef.current,
          conversationBusy ? "conversation_busy" : "desktop_runtime_error",
          message,
        );
      } finally {
        stopHeartbeat(requestId);
        if (claimedRequest) {
          releaseGatewayBridgeRequestClaim(
            requestId,
            clientRequestId,
            resolvedConversationId || targetConversationId,
            gatewayBridgeRequest,
          );
        }
      }
    };

    const drainGatewayChatInbox = async () => {
      if (drainInFlight || disposed) {
        return;
      }
      drainInFlight = true;
      publishRuntimeHeartbeat("draining");
      try {
        for (;;) {
          if (disposed) {
            return;
          }
          const claimed = await invoke<GatewayChatClaimedRequest | null>(
            "gateway_chat_claim_next",
            {
              worker_id: workerId,
              lease_ms: GATEWAY_CHAT_RUNTIME_LEASE_MS,
            } as any,
          );
          if (!claimed || disposed) {
            return;
          }
          void handleGatewayChatRequest(claimed);
        }
      } catch (error) {
        console.warn("gateway_chat_claim_next failed", error);
      } finally {
        drainInFlight = false;
        publishRuntimeHeartbeat();
      }
    };

    const handleRuntimeWake = () => {
      publishRuntimeHeartbeat("draining");
      void drainGatewayChatInbox();
    };

    const nudgeGatewayConnection = (reason: string, forceReconnect = false) => {
      void invoke("gateway_nudge_connection", {
        reason,
        force_reconnect: forceReconnect,
      }).catch((error) => {
        console.warn("gateway_nudge_connection failed", error);
      });
    };

    const handleNetworkOnline = () => {
      // Not forced: browsers fire spurious `online` events (VPN toggle,
      // interface re-priority) while the gRPC stream is healthy and possibly
      // mid-run — force-aborting the runner would discard every queued
      // outbound envelope. If the network really dropped, the offline/stale-
      // heartbeat check inside the nudge (or the transport keepalive)
      // restarts the runner anyway.
      nudgeGatewayConnection("network_online");
      handleRuntimeWake();
    };

    const handleLifecycleWake = () => {
      nudgeGatewayConnection("webview_wake");
      handleRuntimeWake();
    };

    const handleVisibilityWake = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      handleLifecycleWake();
    };

    void listen<GatewayChatRequestReadyEvent>("gateway:chat-request-ready", handleRuntimeWake).then(
      (dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlistenChatRequestReady = dispose;
        publishRuntimeHeartbeat("ready");
        void drainGatewayChatInbox();
      },
    );

    void listen<Record<string, unknown>>("gateway:chat-runtime-wake", handleRuntimeWake).then(
      (dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlistenChatRuntimeWake = dispose;
      },
    );

    // Listener registration is asynchronous. Drain immediately as well so a
    // request queued during startup/remount cannot wait for the listen promise.
    publishRuntimeHeartbeat("draining");
    void drainGatewayChatInbox();

    const idlePollId = window.setInterval(() => {
      publishRuntimeHeartbeat();
      void drainGatewayChatInbox();
    }, GATEWAY_CHAT_RUNTIME_IDLE_POLL_MS);

    const runtimeHeartbeatId = window.setInterval(() => {
      publishRuntimeHeartbeat();
    }, GATEWAY_CHAT_RUNTIME_STATUS_HEARTBEAT_MS);

    window.addEventListener("online", handleNetworkOnline);
    window.addEventListener("focus", handleLifecycleWake);
    window.addEventListener("pageshow", handleLifecycleWake);
    document.addEventListener("visibilitychange", handleVisibilityWake);
    document.addEventListener("resume", handleLifecycleWake);

    void listen<Record<string, unknown>>("gateway:status", (event) => {
      if (event.payload?.online === true) {
        handleRuntimeWake();
      }
    }).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlistenGatewayStatus = dispose;
    });

    void listen<GatewayChatCancelEvent>("gateway:chat-cancel", (event) => {
      const requestId = event.payload.requestId.trim();
      // A request id is the authenticated binding for channel requests. Local
      // desktop requests may still use the conversation id supplied by the
      // Rust transport when no active bridge entry exists yet.
      const conversationId =
        getActiveGatewayBridgeRequestByRequestId(requestId)?.conversationId ??
        event.payload.conversationId.trim();
      if (!conversationId) {
        return;
      }
      const controller = latestParamsRef.current.getConversationAbortController(conversationId);
      controller?.abort();
    }).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlistenChatCancel = dispose;
    });

    return () => {
      disposed = true;
      window.clearInterval(idlePollId);
      window.clearInterval(runtimeHeartbeatId);
      window.removeEventListener("online", handleNetworkOnline);
      window.removeEventListener("focus", handleLifecycleWake);
      window.removeEventListener("pageshow", handleLifecycleWake);
      document.removeEventListener("visibilitychange", handleVisibilityWake);
      document.removeEventListener("resume", handleLifecycleWake);
      publishRuntimeHeartbeat("suspended");
      for (const requestId of heartbeatTimers.keys()) {
        stopHeartbeat(requestId);
      }
      unlistenChatRequestReady?.();
      unlistenChatRuntimeWake?.();
      unlistenChatCancel?.();
      unlistenGatewayStatus?.();
    };
  }, []);
}
