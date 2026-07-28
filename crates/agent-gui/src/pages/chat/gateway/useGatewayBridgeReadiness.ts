import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import {
  type ConversationViewState,
  createConversationStateFromContext,
  type HistoryMessageRef,
  truncateConversationFromMessage,
} from "../../../lib/chat/conversation/conversationState";
import { type ChatHistorySummary, getChatHistory } from "../../../lib/chat/history/chatHistory";
import { createConversationIdentity } from "../../../lib/chat/page/chatPageHelpers";
import {
  type AppSettings,
  normalizeSelectedModelForProviders,
  parseSelectedModelJson,
} from "../../../lib/settings";
import type { SidebarStore } from "../../../lib/sidebar/store";
import {
  collectRetainedSubagentParentToolCallIds,
  pruneSubagentRunsForConversation,
} from "../../../lib/subagents";
import {
  type ConversationRuntimeEntry,
  createConversationRuntimeEntry,
  setConversationRuntimeCacheEntry,
} from "../runtime/chatPageRuntime";
import type { EnsureGatewayBridgeConversationReadyOptions } from "./gatewayBridgeTypes";

type SubagentStoreManagerLike = {
  invalidate: (conversationId: string) => void;
};

type UseGatewayBridgeReadinessParams = {
  settings: AppSettings;
  conversationState: ConversationViewState;
  currentConversationIdRef: MutableRefObject<string>;
  conversationRuntimeCacheRef: MutableRefObject<Map<string, ConversationRuntimeEntry>>;
  persistedConversationStateRef: MutableRefObject<Map<string, ConversationViewState>>;
  buildRuntimeEntryFromVisibleState: () => ConversationRuntimeEntry;
  syncVisibleConversationRuntime: (conversationId: string, entry: ConversationRuntimeEntry) => void;
  isConversationRunning: (conversationId: string) => boolean;
  sidebarStore: SidebarStore;
  gatewayBridgeHistorySummaryRef: MutableRefObject<Map<string, ChatHistorySummary>>;
  hydratingConversationIdRef: MutableRefObject<string | null>;
  hydrationFailedConversationIdRef: MutableRefObject<string | null>;
  setHydratingConversationId: Dispatch<SetStateAction<string | null>>;
  setHydrationFailedConversationId: Dispatch<SetStateAction<string | null>>;
  subagentStoresRef: MutableRefObject<SubagentStoreManagerLike>;
};

/**
 * Prepares a conversation for a gateway (WebUI) chat request: hydrates the
 * runtime cache from history when needed, allocates fresh identities for
 * blank requests, and applies edit_resend rebases (history truncation +
 * subagent prune) before the run starts.
 */
export function useGatewayBridgeReadiness(params: UseGatewayBridgeReadinessParams) {
  const {
    settings,
    conversationState,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    persistedConversationStateRef,
    buildRuntimeEntryFromVisibleState,
    syncVisibleConversationRuntime,
    isConversationRunning,
    sidebarStore,
    gatewayBridgeHistorySummaryRef,
    hydratingConversationIdRef,
    hydrationFailedConversationIdRef,
    setHydratingConversationId,
    setHydrationFailedConversationId,
    subagentStoresRef,
  } = params;

  function applyGatewayBridgeRebase(conversationId: string, baseMessageRef: HistoryMessageRef) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId) {
      throw new Error("Remote edit_resend requires conversation_id.");
    }
    const sourceEntry =
      conversationRuntimeCacheRef.current.get(targetConversationId) ??
      (targetConversationId === currentConversationIdRef.current
        ? buildRuntimeEntryFromVisibleState()
        : null);
    if (!sourceEntry) {
      throw new Error(`Conversation is not available for edit_resend: ${targetConversationId}`);
    }
    const nextState = truncateConversationFromMessage(sourceEntry.state, baseMessageRef);
    const nextEntry = createConversationRuntimeEntry({
      ...sourceEntry,
      state: nextState,
    });
    setConversationRuntimeCacheEntry(
      conversationRuntimeCacheRef.current,
      targetConversationId,
      nextEntry,
    );
    persistedConversationStateRef.current.delete(targetConversationId);
    if (currentConversationIdRef.current === targetConversationId) {
      syncVisibleConversationRuntime(targetConversationId, nextEntry);
    }

    const keepParentToolCallIds = collectRetainedSubagentParentToolCallIds(nextState);
    subagentStoresRef.current.invalidate(targetConversationId);
    void pruneSubagentRunsForConversation({
      parentConversationId: targetConversationId,
      keepParentToolCallIds,
    }).catch((error) => {
      console.warn("gateway edit_resend subagent prune failed", error);
    });
  }

  async function ensureGatewayBridgeConversationReady(
    targetConversationId: string,
    options?: EnsureGatewayBridgeConversationReadyOptions,
  ) {
    const requestedConversationId = targetConversationId.trim();
    const baseMessageRef = options?.baseMessageRef;
    const rebased = options?.rebased === true || Boolean(baseMessageRef);
    const createIfMissing = options?.createIfMissing === true;
    if (!requestedConversationId) {
      const nextIdentity = createConversationIdentity();
      setConversationRuntimeCacheEntry(
        conversationRuntimeCacheRef.current,
        nextIdentity.conversationId,
        createConversationRuntimeEntry({
          state: createConversationStateFromContext({
            tools: conversationState.meta.tools,
            messages: [],
          }),
          sessionId: nextIdentity.sessionId,
          createdAt: nextIdentity.createdAt,
        }),
      );
      return nextIdentity.conversationId;
    }

    const knownConversation =
      requestedConversationId === currentConversationIdRef.current ||
      conversationRuntimeCacheRef.current.has(requestedConversationId) ||
      Boolean(sidebarStore.peek(requestedConversationId)) ||
      gatewayBridgeHistorySummaryRef.current.has(requestedConversationId);
    if (isConversationRunning(requestedConversationId)) {
      throw new Error(`Conversation is already running: ${requestedConversationId}`);
    }

    if (!knownConversation && createIfMissing) {
      const identity = createConversationIdentity();
      setConversationRuntimeCacheEntry(
        conversationRuntimeCacheRef.current,
        requestedConversationId,
        createConversationRuntimeEntry({
          state: createConversationStateFromContext({
            tools: conversationState.meta.tools,
            messages: [],
          }),
          sessionId: identity.sessionId,
          createdAt: identity.createdAt,
        }),
      );
      return requestedConversationId;
    }

    const cached = conversationRuntimeCacheRef.current.get(requestedConversationId);
    if (
      rebased &&
      baseMessageRef &&
      (cached || requestedConversationId === currentConversationIdRef.current) &&
      cached?.isSending !== true &&
      hydratingConversationIdRef.current !== requestedConversationId &&
      hydrationFailedConversationIdRef.current !== requestedConversationId
    ) {
      try {
        applyGatewayBridgeRebase(requestedConversationId, baseMessageRef);
        return requestedConversationId;
      } catch (error) {
        console.warn("gateway edit_resend cached rebase failed; hydrating history", error);
      }
    }
    if (rebased) {
      persistedConversationStateRef.current.delete(requestedConversationId);
    }
    const isPendingHistoryItem = sidebarStore.peek(requestedConversationId)?.isPending === true;
    const shouldHydrateFromHistory =
      !knownConversation ||
      rebased ||
      hydratingConversationIdRef.current === requestedConversationId ||
      hydrationFailedConversationIdRef.current === requestedConversationId ||
      !cached ||
      (!persistedConversationStateRef.current.has(requestedConversationId) &&
        !cached.isSending &&
        !isPendingHistoryItem);

    if (!shouldHydrateFromHistory) {
      if (rebased && baseMessageRef) {
        applyGatewayBridgeRebase(requestedConversationId, baseMessageRef);
      }
      return requestedConversationId;
    }

    const record = await getChatHistory(requestedConversationId);
    const nextEntry = createConversationRuntimeEntry({
      state: record.state,
      sessionId: record.sessionId ?? record.id,
      createdAt: record.createdAt,
      compactionStatus: cached?.compactionStatus,
      isSending: cached?.isSending,
      workdir: record.cwd,
      selectedModel: normalizeSelectedModelForProviders(
        parseSelectedModelJson(record.selectedModelJson),
        settings.customProviders,
      ),
    });
    const historySummary: ChatHistorySummary = {
      id: record.id,
      title: record.title,
      providerId: record.providerId,
      model: record.model,
      sessionId: record.sessionId,
      cwd: record.cwd,
      selectedModelJson: record.selectedModelJson,
      messageCount: record.state.meta.totalMessageCount,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      isPinned: record.isPinned,
      pinnedAt: record.pinnedAt,
    };
    setConversationRuntimeCacheEntry(conversationRuntimeCacheRef.current, record.id, nextEntry);
    persistedConversationStateRef.current.set(record.id, record.state);
    gatewayBridgeHistorySummaryRef.current.set(record.id, historySummary);
    sidebarStore.upsertLocal(historySummary);
    if (currentConversationIdRef.current === record.id) {
      syncVisibleConversationRuntime(record.id, nextEntry);
    }
    if (hydratingConversationIdRef.current === record.id) {
      setHydratingConversationId(null);
    }
    if (hydrationFailedConversationIdRef.current === record.id) {
      setHydrationFailedConversationId(null);
    }
    if (rebased && baseMessageRef) {
      applyGatewayBridgeRebase(record.id, baseMessageRef);
    }
    return record.id;
  }

  return { ensureGatewayBridgeConversationReady, applyGatewayBridgeRebase };
}
