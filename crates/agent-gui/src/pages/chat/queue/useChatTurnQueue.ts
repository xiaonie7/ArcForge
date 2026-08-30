import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "../../../components/chat/MentionComposer";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";
import type { PendingUploadedFile } from "../../../lib/chat/messages/uploadedFiles";
import {
  admitConversation,
  queueAdmissionToken,
  releaseConversation,
  setConversationEditing,
} from "../../../lib/conversationArchive/admission";
import type { PrincipalContext } from "../../../lib/security/principalContext";
import {
  type AppSettings,
  type ChatRuntimeControls,
  type ExecutionMode,
  isAgentExecutionMode,
  normalizeChatRuntimeControls,
  normalizeSystemToolSelection,
  type SystemToolId,
} from "../../../lib/settings";
import { answerAskUserQuestion } from "../../../lib/tools/askUserQuestionTools";
import type { ChatQueueTurnPreview } from "../components/ChatComposerBar";
import { createTextComposerDraft } from "../composer/composerDraftText";
import type {
  ActiveGatewayBridgeRequest,
  ChannelPermissionProfileSnapshot,
  SendChatAction,
} from "../gateway/gatewayBridgeTypes";
import {
  type GatewayChatClaimedRequest,
  normalizeGatewayExecutionMode,
  normalizeGatewayWorkdir,
} from "../gateway/gatewayBridgeTypes";
import {
  resolveGatewayQueuedTurnWorkdir,
  resolveLocalQueuedTurnWorkdir,
} from "../runtime/agentWorkdirScope";
import type { ConversationRuntimeEntry } from "../runtime/chatPageRuntime";
import {
  appendQueuedChatTurn,
  buildQueuedChatTurnPreview,
  buildQueuedGatewayDisplayMessage,
  type ChatQueueItemDetail,
  type ChatQueueSnapshot,
  createQueuedChatTurn,
  getQueuedConversationIds,
  insertQueuedChatTurnAtSlot,
  isRemoteChatLeaseInactiveError,
  moveQueuedChatTurn,
  promoteQueuedChatTurn,
  type QueuedChatTurn,
  type QueuedChatTurnEditSlot,
  queuedChatTurnHasContent,
  removeQueuedChatTurn,
  resolveQueuedChatTurnSlotIndex,
  takeNextQueuedChatTurn,
} from "./chatTurnQueue";

const REMOTE_QUEUE_EDIT_LEASE_MS = 90_000;
const REMOTE_QUEUE_EDIT_RESTORE_AHEAD_MS = 10_000;
const REMOTE_QUEUE_EDIT_WATCHDOG_MS = 2_000;

type UseChatTurnQueueParams = {
  settings: AppSettings;
  currentConversationId: string;
  currentConversationIdRef: MutableRefObject<string>;
  conversationRuntimeCacheRef: MutableRefObject<Map<string, ConversationRuntimeEntry>>;
  buildRuntimeEntryFromVisibleState: () => ConversationRuntimeEntry;
  isConversationRunning: (conversationId: string) => boolean;
  runningConversationIds: ReadonlySet<string>;
  getConversationAbortController: (conversationId: string) => AbortController | null;
  getConversationLiveTranscriptStore: (conversationId: string) => LiveTranscriptStore;
  captureAbortSnapshot: (store: LiveTranscriptStore) => void;
  updateToolStatus: (status: string | null, store: LiveTranscriptStore) => void;
  composerRef: MutableRefObject<MentionComposerHandle | null>;
  pendingUploadedFiles: PendingUploadedFile[];
  setPendingUploadsForConversation: (
    conversationId: string,
    uploads: PendingUploadedFile[],
  ) => void;
  clearCachedComposerDraft: (conversationId?: string) => void;
  displayedConversationWorkdir: string;
  /** The visible Agent scope is the explicit cwd-empty "Recent" scope. */
  allowEmptyAgentWorkdir: boolean;
  sendActionRef: MutableRefObject<SendChatAction>;
};

/**
 * The chat turn queue: local queued turns (enqueue while a run is active,
 * FIFO drain on run end, in-composer editing with slot restore), the WebUI
 * remote queue protocol (gateway:chat-queue-request actions incl. remote
 * edit sessions and AskUserQuestion answers), and queue snapshot publishing
 * back to the gateway.
 */
export function useChatTurnQueue(params: UseChatTurnQueueParams) {
  const {
    settings,
    currentConversationId,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    buildRuntimeEntryFromVisibleState,
    isConversationRunning,
    runningConversationIds,
    getConversationAbortController,
    getConversationLiveTranscriptStore,
    captureAbortSnapshot,
    updateToolStatus,
    composerRef,
    pendingUploadedFiles,
    setPendingUploadsForConversation,
    clearCachedComposerDraft,
    displayedConversationWorkdir,
    allowEmptyAgentWorkdir,
    sendActionRef,
  } = params;

  const [queuedChatTurns, setQueuedChatTurns] = useState<QueuedChatTurn[]>([]);
  const queuedChatTurnsRef = useRef<QueuedChatTurn[]>([]);
  const queuedChatProcessingConversationIdsRef = useRef(new Set<string>());
  const queuedChatTurnEditSlotRef = useRef<
    | (QueuedChatTurnEditSlot & {
        originalId: string;
        createdAt: number;
        executionMode: ExecutionMode;
        workdir: string;
        allowEmptyWorkdir: boolean;
        selectedSystemToolIds: SystemToolId[];
        runtimeControls: ChatRuntimeControls;
        gatewayRequest?: QueuedChatTurn["gatewayRequest"];
      })
    | null
  >(null);
  const chatQueueRevisionRef = useRef(0);
  const chatQueueKnownConversationIdsRef = useRef(new Set<string>());
  const remoteQueuedChatTurnEditSlotsRef = useRef<
    Map<
      string,
      {
        item: QueuedChatTurn;
        slot: QueuedChatTurnEditSlot;
        revision: number;
        expiresAt: number;
        settling: boolean;
      }
    >
  >(new Map());
  const previousRunningConversationIdsRef = useRef<ReadonlySet<string>>(new Set());

  const queueAdmissionInput = (
    item: QueuedChatTurn,
    phase: "queued" | "editing",
  ) => ({
    conversationId: item.conversationId,
    token: queueAdmissionToken(item.id),
    phase,
    originSourceId:
      item.gatewayRequest?.principal?.channel ?? (item.gatewayRequest ? "web" : "desktop"),
  }) as const;

  useEffect(() => {
    const timer = globalThis.setInterval(() => {
      const now = Date.now();
      for (const [itemId, session] of remoteQueuedChatTurnEditSlotsRef.current) {
        if (session.settling || session.expiresAt - now > REMOTE_QUEUE_EDIT_RESTORE_AHEAD_MS) {
          continue;
        }
        session.settling = true;
        void admitConversation(queueAdmissionInput(session.item, "queued"))
          .then(() => {
            if (remoteQueuedChatTurnEditSlotsRef.current.get(itemId) !== session) return;
            remoteQueuedChatTurnEditSlotsRef.current.delete(itemId);
            setQueuedChatTurnsState((current) =>
              insertQueuedChatTurnAtSlot(current, session.item, session.slot),
            );
          })
          .catch((error) => {
            if (String(error).includes("conversation_archived")) {
              if (remoteQueuedChatTurnEditSlotsRef.current.get(itemId) === session) {
                remoteQueuedChatTurnEditSlotsRef.current.delete(itemId);
              }
              void releaseConversation(queueAdmissionToken(session.item.id)).catch((releaseError) => {
                console.warn("Failed to release an archived remote queued edit", releaseError);
              });
              return;
            }
            session.settling = false;
            session.expiresAt = Date.now() + REMOTE_QUEUE_EDIT_WATCHDOG_MS;
            console.warn("Failed to restore an expired remote queued edit", error);
          });
      }
    }, REMOTE_QUEUE_EDIT_WATCHDOG_MS);
    return () => globalThis.clearInterval(timer);
  }, []);

  function buildChatQueueSnapshot(
    conversationId: string,
    queue: readonly QueuedChatTurn[] = queuedChatTurnsRef.current,
  ): ChatQueueSnapshot {
    const key = conversationId.trim();
    return {
      conversationId: key,
      revision: chatQueueRevisionRef.current,
      items: queue
        .filter((item) => item.conversationId === key)
        .map((item) => ({
          id: item.id,
          previewText: buildQueuedChatTurnPreview(item.draft),
          fileCount: item.uploadedFiles.length,
          createdAt: item.createdAt,
          source: item.gatewayRequest ? "webui" : "gui",
          editable: true,
        })),
    };
  }

  function buildChatQueueItemDetail(item: QueuedChatTurn): ChatQueueItemDetail {
    const summary = {
      id: item.id,
      previewText: buildQueuedChatTurnPreview(item.draft),
      fileCount: item.uploadedFiles.length,
      createdAt: item.createdAt,
      source: item.gatewayRequest ? ("webui" as const) : ("gui" as const),
      editable: true,
    };
    return {
      ...summary,
      draftJson: JSON.stringify(item.draft),
      uploadedFilesJson: JSON.stringify(item.uploadedFiles),
    };
  }

  function rememberChatQueueConversationId(conversationId: string) {
    const key = conversationId.trim();
    if (key) {
      chatQueueKnownConversationIdsRef.current.add(key);
    }
    return key;
  }

  function collectChatQueueSnapshotConversationIds(
    queue: readonly QueuedChatTurn[] = queuedChatTurnsRef.current,
    extraConversationIds: readonly string[] = [],
  ) {
    const conversationIds = new Set(chatQueueKnownConversationIdsRef.current);
    for (const item of queue) {
      const key = rememberChatQueueConversationId(item.conversationId);
      if (key) conversationIds.add(key);
    }
    for (const conversationId of extraConversationIds) {
      const key = rememberChatQueueConversationId(conversationId);
      if (key) conversationIds.add(key);
    }
    return conversationIds;
  }

  function publishChatQueueSnapshot(
    conversationId: string,
    queue: readonly QueuedChatTurn[] = queuedChatTurnsRef.current,
  ) {
    const targetConversationId = rememberChatQueueConversationId(conversationId);
    if (!targetConversationId) {
      return;
    }
    const snapshot = buildChatQueueSnapshot(targetConversationId, queue);
    void invoke("gateway_publish_chat_queue_event", {
      input: {
        conversationId: snapshot.conversationId,
        snapshotJson: JSON.stringify(snapshot),
        revision: snapshot.revision,
      },
    } as any).catch((error) => {
      console.warn("gateway_publish_chat_queue_event failed", error);
    });
  }

  function publishChatQueueSnapshots(
    conversationIds: Iterable<string>,
    queue: readonly QueuedChatTurn[] = queuedChatTurnsRef.current,
  ) {
    for (const conversationId of conversationIds) {
      publishChatQueueSnapshot(conversationId, queue);
    }
  }

  const setQueuedChatTurnsState = useCallback(
    (updater: (current: QueuedChatTurn[]) => QueuedChatTurn[]) => {
      const previous = queuedChatTurnsRef.current;
      const next = updater(previous).slice();
      queuedChatTurnsRef.current = next;
      setQueuedChatTurns(next);
      chatQueueRevisionRef.current += 1;
      const conversationIds = new Set<string>();
      for (const item of previous) conversationIds.add(item.conversationId);
      for (const item of next) conversationIds.add(item.conversationId);
      const currentId = currentConversationIdRef.current.trim();
      if (currentId) conversationIds.add(currentId);
      publishChatQueueSnapshots(conversationIds, next);
      return next;
    },
    [],
  );

  const queuedChatTurnsForCurrentConversation = useMemo<ChatQueueTurnPreview[]>(
    () =>
      queuedChatTurns
        .filter((item) => item.conversationId === currentConversationId)
        .map((item) => ({
          id: item.id,
          previewText: buildQueuedChatTurnPreview(item.draft),
          fileCount: item.uploadedFiles.length,
        })),
    [currentConversationId, queuedChatTurns],
  );

  function stopConversation(conversationId: string) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId) return false;
    const controller = getConversationAbortController(targetConversationId);
    if (!controller) return false;
    const transcriptStore = getConversationLiveTranscriptStore(targetConversationId);
    captureAbortSnapshot(transcriptStore);
    updateToolStatus("正在停止当前任务...", transcriptStore);
    controller.abort();
    return true;
  }

  function stopSending() {
    const conversationId = currentConversationIdRef.current.trim();
    if (!conversationId) return;
    if (!stopConversation(conversationId)) {
      requestQueuedChatTurnProcessing(conversationId);
    }
  }

  function clearCurrentComposerDraftForQueuedTurn(conversationId: string) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId || currentConversationIdRef.current !== targetConversationId) {
      return;
    }
    composerRef.current?.clear();
    setPendingUploadsForConversation(targetConversationId, []);
    clearCachedComposerDraft(targetConversationId);
  }

  async function enqueueCurrentComposerTurn(position: "end" | "edit") {
    const conversationId = currentConversationIdRef.current.trim();
    const draft = composerRef.current?.getDraft() ?? null;
    const uploadedFiles = pendingUploadedFiles.slice();
    if (!conversationId || !queuedChatTurnHasContent(draft, uploadedFiles)) {
      return false;
    }

    const runtimeEntry =
      conversationRuntimeCacheRef.current.get(conversationId) ??
      buildRuntimeEntryFromVisibleState();
    const editSlot =
      position === "edit" && queuedChatTurnEditSlotRef.current?.conversationId === conversationId
        ? queuedChatTurnEditSlotRef.current
        : null;
    const executionMode = editSlot?.executionMode ?? settings.system.executionMode;
    const allowEmptyWorkdir =
      editSlot?.allowEmptyWorkdir ??
      (isAgentExecutionMode(executionMode) && allowEmptyAgentWorkdir);
    const workdirForTurn = resolveLocalQueuedTurnWorkdir({
      isAgentMode: isAgentExecutionMode(executionMode),
      editedWorkdir: editSlot?.workdir,
      unscopedAgent: allowEmptyAgentWorkdir,
      conversationWorkdir: runtimeEntry.workdir,
      displayedWorkdir: displayedConversationWorkdir,
      defaultWorkdir: settings.system.workdir,
    });
    const queuedTurn = createQueuedChatTurn({
      id: editSlot?.originalId,
      conversationId,
      draft,
      uploadedFiles,
      executionMode,
      workdir: workdirForTurn,
      allowEmptyWorkdir,
      selectedSystemToolIds: editSlot?.selectedSystemToolIds ?? settings.system.selectedSystemTools,
      runtimeControls: editSlot?.runtimeControls ?? settings.chatRuntimeControls,
      createdAt: editSlot?.createdAt,
      gatewayRequest: editSlot?.gatewayRequest,
    });

    await admitConversation({
      conversationId,
      token: queueAdmissionToken(queuedTurn.id),
      phase: "queued",
      originSourceId: queuedTurn.gatewayRequest?.principal?.channel ?? (queuedTurn.gatewayRequest ? "web" : "desktop"),
    });
    setQueuedChatTurnsState((current) => {
      if (editSlot) {
        return insertQueuedChatTurnAtSlot(current, queuedTurn, editSlot);
      }
      return appendQueuedChatTurn(current, queuedTurn);
    });
    if (editSlot) {
      queuedChatTurnEditSlotRef.current = null;
    }
    clearCurrentComposerDraftForQueuedTurn(conversationId);
    return true;
  }

  function isQueuedChatTurnEditBlockingProcessing(conversationId: string) {
    const slot = queuedChatTurnEditSlotRef.current;
    if (!slot || slot.conversationId !== conversationId.trim()) return false;
    const queue = queuedChatTurnsRef.current;
    const firstQueuedIndex = queue.findIndex((item) => item.conversationId === slot.conversationId);
    if (firstQueuedIndex < 0) return false;
    return resolveQueuedChatTurnSlotIndex(queue, slot) <= firstQueuedIndex;
  }

  function requestQueuedChatTurnProcessing(conversationId: string) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId) return;
    if (queuedChatProcessingConversationIdsRef.current.has(targetConversationId)) return;
    if (isConversationRunning(targetConversationId)) return;
    if (isQueuedChatTurnEditBlockingProcessing(targetConversationId)) return;
    if (!queuedChatTurnsRef.current.some((item) => item.conversationId === targetConversationId)) {
      return;
    }

    queuedChatProcessingConversationIdsRef.current.add(targetConversationId);
    let inFlightQueuedTurn: QueuedChatTurn | null = null;
    void Promise.resolve()
      .then(async () => {
        if (isConversationRunning(targetConversationId)) return;
        const taken = takeNextQueuedChatTurn(queuedChatTurnsRef.current, targetConversationId);
        if (!taken.item) return false;
        const queuedTurn = taken.item;
        inFlightQueuedTurn = queuedTurn;
        setQueuedChatTurnsState(() => taken.queue);
        const gatewayRequest = queuedTurn.gatewayRequest;
        const gatewayWorkerId = gatewayRequest?.workerId.trim() ?? "";
        let gatewayLeaseInactive = false;
        const gatewayBridgeRequest: ActiveGatewayBridgeRequest | null = gatewayRequest
          ? {
              requestId: gatewayRequest.requestId,
              conversationId: targetConversationId,
              clientRequestId: gatewayRequest.clientRequestId,
              workerId: gatewayWorkerId,
              startedAt: Date.now(),
              selectedModelOverride: gatewayRequest.selectedModel,
              runtimeControlsOverride: gatewayRequest.runtimeControls
                ? normalizeChatRuntimeControls(gatewayRequest.runtimeControls)
                : queuedTurn.runtimeControls,
              executionModeOverride: queuedTurn.executionMode,
              workdirOverride: queuedTurn.workdir,
              selectedSystemToolIdsOverride: queuedTurn.selectedSystemToolIds,
              principal: gatewayRequest.principal,
              permissionProfile: gatewayRequest.permissionProfile,
            }
          : null;
        const markGatewayStarted =
          gatewayRequest && gatewayBridgeRequest
            ? async () => {
                try {
                  await invoke("gateway_chat_mark_started", {
                    request_id: gatewayRequest.requestId,
                    conversation_id: targetConversationId,
                    worker_id: gatewayWorkerId,
                  } as any);
                } catch (error) {
                  gatewayLeaseInactive = isRemoteChatLeaseInactiveError(error);
                  throw error;
                }
              }
            : undefined;
        const accepted = await sendActionRef.current({
          lifecycleToken: queueAdmissionToken(queuedTurn.id),
          textOverride: gatewayRequest?.principal?.channelCommand ? "" : undefined,
          composerDraftOverride: queuedTurn.draft,
          uploadedFilesOverride: queuedTurn.uploadedFiles,
          conversationIdOverride: targetConversationId,
          executionModeOverride: queuedTurn.executionMode,
          workdirOverride: queuedTurn.workdir,
          allowEmptyWorkdirOverride: queuedTurn.allowEmptyWorkdir,
          selectedSystemToolIdsOverride: queuedTurn.selectedSystemToolIds,
          runtimeControlsOverride: queuedTurn.runtimeControls,
          gatewayBridgeRequestOverride: gatewayBridgeRequest,
          preserveComposerOnStart: true,
          beforeRuntimeStart: markGatewayStarted,
          afterInitialHistoryPersist: markGatewayStarted,
        });
        if (!accepted) {
          // A stale remote lease is ownership fencing, not a transient send
          // failure. Requeueing it can never succeed and creates an endless
          // retry/toast loop while another worker may already own the request.
          if (!gatewayLeaseInactive) {
            setQueuedChatTurnsState((current) =>
              promoteQueuedChatTurn(appendQueuedChatTurn(current, queuedTurn), queuedTurn.id),
            );
          } else {
            await releaseConversation(queueAdmissionToken(queuedTurn.id));
          }
          inFlightQueuedTurn = null;
        } else if (gatewayRequest) {
          void invoke("gateway_chat_complete", {
            request_id: gatewayRequest.requestId,
            conversation_id: targetConversationId,
            worker_id: gatewayWorkerId,
          } as any).catch((error) => {
            console.warn("gateway_chat_complete failed", error);
          });
        }
        return accepted;
      })
      .then((accepted) => {
        queuedChatProcessingConversationIdsRef.current.delete(targetConversationId);
        if (
          accepted &&
          !isConversationRunning(targetConversationId) &&
          queuedChatTurnsRef.current.some((item) => item.conversationId === targetConversationId)
        ) {
          requestQueuedChatTurnProcessing(targetConversationId);
        }
      })
      .catch(() => {
        const failedQueuedTurn = inFlightQueuedTurn;
        if (failedQueuedTurn) {
          setQueuedChatTurnsState((current) =>
            promoteQueuedChatTurn(
              appendQueuedChatTurn(current, failedQueuedTurn),
              failedQueuedTurn.id,
            ),
          );
          inFlightQueuedTurn = null;
        }
        queuedChatProcessingConversationIdsRef.current.delete(targetConversationId);
      });
  }

  useEffect(() => {
    const previousRunningConversationIds = previousRunningConversationIdsRef.current;
    previousRunningConversationIdsRef.current = runningConversationIds;
    for (const conversationId of getQueuedConversationIds(queuedChatTurnsRef.current)) {
      if (
        previousRunningConversationIds.has(conversationId) &&
        !runningConversationIds.has(conversationId)
      ) {
        requestQueuedChatTurnProcessing(conversationId);
      }
    }
  }, [runningConversationIds, queuedChatTurns]);

  function runQueuedTurnNow(id: string) {
    const queuedTurn = queuedChatTurnsRef.current.find((item) => item.id === id.trim());
    if (!queuedTurn) return;
    setQueuedChatTurnsState((current) => promoteQueuedChatTurn(current, queuedTurn.id));
    if (isConversationRunning(queuedTurn.conversationId)) {
      stopConversation(queuedTurn.conversationId);
      return;
    }
    requestQueuedChatTurnProcessing(queuedTurn.conversationId);
  }

  function moveQueuedTurnUp(id: string) {
    setQueuedChatTurnsState((current) => moveQueuedChatTurn(current, id, "up"));
  }

  async function editQueuedTurn(id: string) {
    const key = id.trim();
    const queuedTurnIndex = queuedChatTurnsRef.current.findIndex((item) => item.id === key);
    const queuedTurn = queuedTurnIndex >= 0 ? queuedChatTurnsRef.current[queuedTurnIndex] : null;
    if (!queuedTurn) return;
    const targetConversationId = queuedTurn.conversationId.trim();
    if (!targetConversationId || currentConversationIdRef.current.trim() !== targetConversationId) {
      return;
    }

    const currentDraft = composerRef.current?.getDraft() ?? null;
    const currentUploads = pendingUploadedFiles.slice();
    if (queuedChatTurnHasContent(currentDraft, currentUploads)) {
      await enqueueCurrentComposerTurn(queuedChatTurnEditSlotRef.current ? "edit" : "end");
    }

    const sameConversationQueue = queuedChatTurnsRef.current.filter(
      (item) => item.conversationId === targetConversationId,
    );
    const sameConversationIndex = sameConversationQueue.findIndex((item) => item.id === key);
    const previousId =
      sameConversationIndex > 0
        ? (sameConversationQueue[sameConversationIndex - 1]?.id ?? null)
        : null;
    const nextId =
      sameConversationIndex >= 0
        ? (sameConversationQueue[sameConversationIndex + 1]?.id ?? null)
        : null;
    const editSlot = {
      conversationId: targetConversationId,
      previousId,
      nextId,
      index: sameConversationIndex >= 0 ? sameConversationIndex : undefined,
      originalId: queuedTurn.id,
      createdAt: queuedTurn.createdAt,
      executionMode: queuedTurn.executionMode,
      workdir: queuedTurn.workdir,
      allowEmptyWorkdir: queuedTurn.allowEmptyWorkdir,
      selectedSystemToolIds: queuedTurn.selectedSystemToolIds.slice(),
      runtimeControls: { ...queuedTurn.runtimeControls },
      gatewayRequest: queuedTurn.gatewayRequest ? { ...queuedTurn.gatewayRequest } : undefined,
    };
    // Transfer protection before removing the visible queue item. If either
    // durable write fails, keep the item in the queue and let the caller retry;
    // there is never a moment where automatic archive sees neither guard.
    await setConversationEditing(targetConversationId, true);
    try {
      await releaseConversation(queueAdmissionToken(queuedTurn.id));
    } catch (error) {
      await setConversationEditing(targetConversationId, false).catch(() => undefined);
      throw error;
    }
    queuedChatTurnEditSlotRef.current = editSlot;
    setQueuedChatTurnsState((current) => removeQueuedChatTurn(current, key));
    composerRef.current?.setDraft(queuedTurn.draft);
    setPendingUploadsForConversation(targetConversationId, queuedTurn.uploadedFiles);
    clearCachedComposerDraft(targetConversationId);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function removeQueuedTurn(id: string) {
    const queuedTurn = queuedChatTurnsRef.current.find((item) => item.id === id.trim());
    setQueuedChatTurnsState((current) => removeQueuedChatTurn(current, id));
    if (queuedTurn) {
      void releaseConversation(queueAdmissionToken(queuedTurn.id)).catch((error) => {
        console.error("Failed to release removed queued conversation admission", error);
      });
    }
    const gatewayRequest = queuedTurn?.gatewayRequest;
    if (gatewayRequest) {
      void invoke("gateway_chat_cancel_request", {
        request_id: gatewayRequest.requestId,
        conversation_id: queuedTurn?.conversationId,
        worker_id: gatewayRequest.workerId,
      } as any).catch((error) => {
        console.warn("gateway_chat_cancel_request failed", error);
      });
    }
  }

  function shouldQueueGatewayChatRequest(
    conversationId: string,
    queuePolicy: "auto" | "append" | "interrupt",
  ) {
    const key = conversationId.trim();
    if (!key) return false;
    return (
      queuePolicy === "append" ||
      queuePolicy === "interrupt" ||
      queuedChatTurnsRef.current.some((item) => item.conversationId === key) ||
      isQueuedChatTurnEditBlockingProcessing(key)
    );
  }

  async function enqueueGatewayChatRequest(
    claimed: GatewayChatClaimedRequest,
    conversationId: string,
    principal: PrincipalContext | undefined,
    permissionProfile: ChannelPermissionProfileSnapshot | undefined,
    workerId: string,
  ) {
    const payload = claimed.request;
    const requestId = payload.requestId.trim();
    const targetConversationId = conversationId.trim();
    const message = payload.message ?? "";
    const uploadedFiles = Array.isArray(payload.uploadedFiles) ? payload.uploadedFiles : [];
    const gatewayWorkerId = workerId.trim();
    const trustedPolicy = principal ? permissionProfile?.policy : undefined;
    const queueDisplayMessage = buildQueuedGatewayDisplayMessage(
      message,
      principal?.channelCommand,
    );
    if (
      !requestId ||
      !targetConversationId ||
      !gatewayWorkerId ||
      (principal && !trustedPolicy) ||
      (!queueDisplayMessage && uploadedFiles.length === 0)
    ) {
      return false;
    }

    const executionMode = trustedPolicy
      ? trustedPolicy.executionMode
      : (normalizeGatewayExecutionMode(payload.executionMode) ?? settings.system.executionMode);
    const workdir = trustedPolicy
      ? trustedPolicy.workdir
      : resolveGatewayQueuedTurnWorkdir({
          requestedWorkdir: normalizeGatewayWorkdir(payload.workdir),
          conversationWorkdir:
            conversationRuntimeCacheRef.current.get(targetConversationId)?.workdir,
          displayedWorkdir: displayedConversationWorkdir,
          defaultWorkdir: settings.system.workdir,
        });
    const runtimeControls =
      !principal && payload.runtimeControls
        ? normalizeChatRuntimeControls(payload.runtimeControls)
        : settings.chatRuntimeControls;
    const selectedSystemToolIds = trustedPolicy
      ? normalizeSystemToolSelection(trustedPolicy.allowedSystemTools)
      : Array.isArray(payload.selectedSystemTools)
        ? normalizeSystemToolSelection(payload.selectedSystemTools)
        : settings.system.selectedSystemTools;
    const queuedTurn = createQueuedChatTurn({
      id: `gateway-${requestId}`,
      conversationId: targetConversationId,
      // The label makes a queued control command visible in the prompt queue.
      // The trusted command branch executes before composer text is consumed,
      // so this value is never appended to conversation history.
      draft: createTextComposerDraft(queueDisplayMessage),
      uploadedFiles,
      executionMode,
      workdir: isAgentExecutionMode(executionMode) ? workdir : "",
      allowEmptyWorkdir:
        isAgentExecutionMode(executionMode) &&
        workdir.length === 0 &&
        (trustedPolicy ? trustedPolicy.allowEmptyWorkdir : allowEmptyAgentWorkdir),
      selectedSystemToolIds,
      runtimeControls,
      gatewayRequest: {
        requestId,
        clientRequestId:
          payload.clientRequestId?.trim() || claimed.clientRequestId?.trim() || undefined,
        // Rust retains the claiming WebView worker as the queued request's
        // ownership marker. Start/complete/cancel must use that same id.
        workerId: gatewayWorkerId,
        queuePolicy:
          payload.queuePolicy === "append" || payload.queuePolicy === "interrupt"
            ? payload.queuePolicy
            : "auto",
        selectedModel: principal ? undefined : payload.selectedModel,
        runtimeControls: principal ? undefined : payload.runtimeControls,
        principal,
        permissionProfile,
      },
    });

    await admitConversation({
      conversationId: targetConversationId,
      token: queueAdmissionToken(queuedTurn.id),
      phase: "queued",
      originSourceId: principal?.channel ?? "web",
    });
    setQueuedChatTurnsState((current) => {
      const appended = appendQueuedChatTurn(current, queuedTurn);
      return payload.queuePolicy === "interrupt"
        ? promoteQueuedChatTurn(appended, queuedTurn.id)
        : appended;
    });
    if (payload.queuePolicy === "interrupt") {
      stopConversation(targetConversationId);
    }
    return true;
  }

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    type GatewayChatQueueRequestEvent = {
      requestId: string;
      action: string;
      conversationId?: string;
      itemId?: string;
      direction?: "up" | "down" | string;
      revision?: number;
      draftJson?: string;
      uploadedFilesJson?: string;
      requestJson?: string;
    };

    const respond = (requestId: string, response: Record<string, unknown>) => {
      if (!requestId.trim()) return;
      void invoke("gateway_chat_queue_respond", {
        input: {
          requestId,
          accepted: response.accepted === true,
          message: typeof response.message === "string" ? response.message : "",
          snapshotJson: typeof response.snapshotJson === "string" ? response.snapshotJson : "",
          itemJson: typeof response.itemJson === "string" ? response.itemJson : "",
          errorCode: typeof response.errorCode === "string" ? response.errorCode : "",
          revision: chatQueueRevisionRef.current,
        },
      } as any).catch((error) => {
        console.warn("gateway_chat_queue_respond failed", error);
      });
    };

    const snapshotJson = (conversationId: string) =>
      JSON.stringify(buildChatQueueSnapshot(conversationId));

    void listen<GatewayChatQueueRequestEvent>("gateway:chat-queue-request", (event) => {
      if (disposed) return;
      const request = event.payload;
      const requestId = request.requestId?.trim() ?? "";
      const action = request.action?.trim() ?? "";
      const conversationId =
        request.conversationId?.trim() || currentConversationIdRef.current.trim();
      const itemId = request.itemId?.trim() ?? "";

      const fail = (message: string, errorCode = "invalid_request") => {
        respond(requestId, {
          accepted: false,
          message,
          errorCode,
          snapshotJson: conversationId ? snapshotJson(conversationId) : "",
        });
      };

      if (!requestId) return;
      if (!conversationId && action !== "get") {
        fail("conversation_id is required");
        return;
      }

      if (action === "get") {
        respond(requestId, {
          accepted: true,
          snapshotJson: snapshotJson(conversationId),
        });
        return;
      }

      // WebUI 对 AskUserQuestion 卡片的应答：itemId 即 toolCallId，request_json
      // 携带 {questionId, selectedLabel}[]，直接落到工具挂起表。
      if (action === "tool_answer") {
        if (!itemId) {
          fail("tool_answer requires item_id", "invalid_request");
          return;
        }
        let rawAnswers: unknown;
        try {
          rawAnswers = JSON.parse(request.requestJson || "[]");
        } catch {
          fail("invalid tool answer payload", "invalid_payload");
          return;
        }
        const outcome = answerAskUserQuestion(itemId, rawAnswers, { conversationId });
        if (!outcome.ok) {
          fail(outcome.message || "question not pending", "not_found");
          return;
        }
        respond(requestId, { accepted: true });
        return;
      }

      const item = queuedChatTurnsRef.current.find(
        (candidate) => candidate.id === itemId && candidate.conversationId === conversationId,
      );

      if (action === "get_item") {
        if (!item) {
          fail("queued item not found", "not_found");
          return;
        }
        respond(requestId, {
          accepted: true,
          itemJson: JSON.stringify(buildChatQueueItemDetail(item)),
          snapshotJson: snapshotJson(conversationId),
        });
        return;
      }

      if (action === "run_now") {
        if (!item) {
          fail("queued item not found", "not_found");
          return;
        }
        runQueuedTurnNow(item.id);
        respond(requestId, { accepted: true, snapshotJson: snapshotJson(conversationId) });
        return;
      }

      if (action === "move") {
        if (!item) {
          fail("queued item not found", "not_found");
          return;
        }
        const direction = request.direction === "down" ? "down" : "up";
        setQueuedChatTurnsState((current) => moveQueuedChatTurn(current, item.id, direction));
        respond(requestId, { accepted: true, snapshotJson: snapshotJson(conversationId) });
        return;
      }

      if (action === "remove") {
        if (!item) {
          fail("queued item not found", "not_found");
          return;
        }
        removeQueuedTurn(item.id);
        respond(requestId, { accepted: true, snapshotJson: snapshotJson(conversationId) });
        return;
      }

      if (action === "edit_begin") {
        if (!item) {
          fail("queued item not found", "not_found");
          return;
        }
        const sameConversationQueue = queuedChatTurnsRef.current.filter(
          (candidate) => candidate.conversationId === conversationId,
        );
        const sameConversationIndex = sameConversationQueue.findIndex(
          (candidate) => candidate.id === item.id,
        );
        const slot: QueuedChatTurnEditSlot = {
          conversationId,
          previousId:
            sameConversationIndex > 0
              ? (sameConversationQueue[sameConversationIndex - 1]?.id ?? null)
              : null,
          nextId:
            sameConversationIndex >= 0
              ? (sameConversationQueue[sameConversationIndex + 1]?.id ?? null)
              : null,
          index: sameConversationIndex >= 0 ? sameConversationIndex : undefined,
        };
        void admitConversation(queueAdmissionInput(item, "editing"))
          .then(() => {
            remoteQueuedChatTurnEditSlotsRef.current.set(item.id, {
              item,
              slot,
              revision: chatQueueRevisionRef.current,
              expiresAt: Date.now() + REMOTE_QUEUE_EDIT_LEASE_MS,
              settling: false,
            });
            const detail = buildChatQueueItemDetail(item);
            setQueuedChatTurnsState((current) => removeQueuedChatTurn(current, item.id));
            respond(requestId, {
              accepted: true,
              itemJson: JSON.stringify(detail),
              snapshotJson: snapshotJson(conversationId),
            });
          })
          .catch((error) => fail(String(error), "lifecycle_conflict"));
        return;
      }

      if (action === "edit_heartbeat") {
        const session = remoteQueuedChatTurnEditSlotsRef.current.get(itemId);
        if (!session || session.slot.conversationId !== conversationId || session.settling) {
          fail("queued edit session not found", "not_found");
          return;
        }
        void admitConversation(queueAdmissionInput(session.item, "editing"))
          .then(() => {
            if (remoteQueuedChatTurnEditSlotsRef.current.get(itemId) !== session) {
              fail("queued edit session not found", "not_found");
              return;
            }
            session.expiresAt = Date.now() + REMOTE_QUEUE_EDIT_LEASE_MS;
            respond(requestId, { accepted: true });
          })
          .catch((error) => fail(String(error), "lifecycle_conflict"));
        return;
      }

      if (action === "edit_cancel") {
        const session = remoteQueuedChatTurnEditSlotsRef.current.get(itemId);
        if (!session) {
          fail("queued edit session not found", "not_found");
          return;
        }
        if (session.slot.conversationId !== conversationId) {
          fail("queued edit session conversation mismatch", "not_found");
          return;
        }
        if (session.settling) {
          fail("queued edit session is settling", "conflict");
          return;
        }
        session.settling = true;
        void admitConversation(queueAdmissionInput(session.item, "queued"))
          .then(() => {
            if (remoteQueuedChatTurnEditSlotsRef.current.get(itemId) !== session) {
              fail("queued edit session not found", "not_found");
              return;
            }
            remoteQueuedChatTurnEditSlotsRef.current.delete(itemId);
            setQueuedChatTurnsState((current) =>
              insertQueuedChatTurnAtSlot(current, session.item, session.slot),
            );
            respond(requestId, { accepted: true, snapshotJson: snapshotJson(conversationId) });
          })
          .catch((error) => {
            session.settling = false;
            fail(String(error), "lifecycle_conflict");
          });
        return;
      }

      if (action === "edit_commit") {
        const session = remoteQueuedChatTurnEditSlotsRef.current.get(itemId);
        if (!session) {
          fail("queued edit session not found", "not_found");
          return;
        }
        if (session.slot.conversationId !== conversationId) {
          fail("queued edit session conversation mismatch", "not_found");
          return;
        }
        if (session.settling) {
          fail("queued edit session is settling", "conflict");
          return;
        }
        if (
          typeof request.revision === "number" &&
          request.revision > 0 &&
          request.revision < chatQueueRevisionRef.current
        ) {
          fail("queued edit revision conflict", "conflict");
          return;
        }
        let draft: MentionComposerDraft;
        let uploadedFiles: PendingUploadedFile[];
        try {
          draft = JSON.parse(request.draftJson || "") as MentionComposerDraft;
          uploadedFiles = JSON.parse(request.uploadedFilesJson || "[]") as PendingUploadedFile[];
        } catch {
          fail("invalid queued edit payload", "invalid_payload");
          return;
        }
        const nextItem = createQueuedChatTurn({
          ...session.item,
          draft,
          uploadedFiles: Array.isArray(uploadedFiles) ? uploadedFiles : [],
          id: session.item.id,
          createdAt: session.item.createdAt,
        });
        session.settling = true;
        void admitConversation(queueAdmissionInput(nextItem, "queued"))
          .then(() => {
            if (remoteQueuedChatTurnEditSlotsRef.current.get(itemId) !== session) {
              fail("queued edit session not found", "not_found");
              return;
            }
            remoteQueuedChatTurnEditSlotsRef.current.delete(itemId);
            setQueuedChatTurnsState((current) =>
              insertQueuedChatTurnAtSlot(current, nextItem, session.slot),
            );
            respond(requestId, { accepted: true, snapshotJson: snapshotJson(conversationId) });
          })
          .catch((error) => {
            session.settling = false;
            fail(String(error), "lifecycle_conflict");
          });
        return;
      }

      fail(`unsupported chat queue action: ${action}`, "unsupported_action");
    }).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlisten = dispose;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return {
    queuedChatTurnsRef,
    queuedChatTurnEditSlotRef,
    setQueuedChatTurnsState,
    queuedChatTurnsForCurrentConversation,
    publishChatQueueSnapshots,
    collectChatQueueSnapshotConversationIds,
    stopConversation,
    stopSending,
    enqueueCurrentComposerTurn,
    requestQueuedChatTurnProcessing,
    runQueuedTurnNow,
    moveQueuedTurnUp,
    editQueuedTurn,
    removeQueuedTurn,
    shouldQueueGatewayChatRequest,
    enqueueGatewayChatRequest,
  };
}
