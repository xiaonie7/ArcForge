import { invoke } from "@tauri-apps/api/core";
import {
  type ConversationRuntimeEntry,
  createConversationRuntimeEntry,
  setConversationRuntimeCacheEntry,
} from "../../pages/chat/runtime/chatPageRuntime";
import {
  type ConversationViewState,
  createConversationStateFromContext,
} from "../chat/conversation/conversationState";
import {
  type ChatHistorySummary,
  getChatHistory,
  persistConversationState,
} from "../chat/history/chatHistory";
import { createConversationIdentity } from "../chat/page/chatPageHelpers";
import {
  parseSelectedModelJson,
  type SelectedModel,
  serializeSelectedModelJson,
} from "../settings";
import { artifactPathsMatch } from "./events";
import { getReviewThreadBinding, setReviewThreadBinding } from "./session";
import { type ArtifactRef, artifactBasename } from "./types";

export type ReviewThreadOptions = {
  artifact: ArtifactRef;
  parentConversationId: string;
  systemPrompt?: string;
  selectedModel?: SelectedModel;
  titlePrefix: string;
  runtimeCache: Map<string, ConversationRuntimeEntry>;
  persistedStateCache: Map<string, ConversationViewState>;
  onHistory: (summary: ChatHistorySummary) => void;
};

const pending = new WeakMap<ReviewThreadOptions["runtimeCache"], Map<string, Promise<string>>>();

/** Deduplicate opens, including StrictMode effects. Database metadata is the source of truth. */
export function ensureReviewThread(options: ReviewThreadOptions): Promise<string> {
  const { artifact, runtimeCache } = options;
  const key = `${artifact.workdir.replace(/\\/g, "/").toLowerCase()}::${artifact.path.replace(/\\/g, "/").toLowerCase()}`;
  let requests = pending.get(runtimeCache);
  if (!requests) {
    requests = new Map();
    pending.set(runtimeCache, requests);
  }
  const existing = requests.get(key);
  if (existing) return existing;
  const request = openReviewThread(options).finally(() => requests.delete(key));
  requests.set(key, request);
  return request;
}

async function openReviewThread(options: ReviewThreadOptions): Promise<string> {
  const { artifact, runtimeCache, persistedStateCache, onHistory } = options;
  // A live review must never be overwritten with an older disk snapshot.
  const binding = getReviewThreadBinding(artifact.workdir, artifact.path);
  const live = binding ? runtimeCache.get(binding.conversationId) : undefined;
  if (
    binding &&
    live?.isSending &&
    live.state.meta.review &&
    artifactPathsMatch(live.state.meta.review.workdir, artifact.workdir) &&
    artifactPathsMatch(live.state.meta.review.artifactPath, artifact.path)
  )
    return binding.conversationId;

  const id = await invoke<string | null>("chat_history_find_review", {
    workdir: artifact.workdir,
    artifactPath: artifact.path,
  });
  if (id) {
    const cached = runtimeCache.get(id);
    const record = cached ? null : await getChatHistory(id, options.systemPrompt);
    const state = cached?.state ?? record?.state;
    if (!state) throw new Error("Review thread could not be loaded.");
    const review = state.meta.review;
    if (
      !review ||
      !artifactPathsMatch(review.workdir, artifact.workdir) ||
      !artifactPathsMatch(review.artifactPath, artifact.path)
    )
      throw new Error("Review thread binding does not match the artifact.");
    if (record) {
      const newer = runtimeCache.get(id);
      if (!newer) {
        setConversationRuntimeCacheEntry(
          runtimeCache,
          id,
          createConversationRuntimeEntry({
            state,
            sessionId: record.sessionId || id,
            createdAt: record.createdAt,
            workdir: artifact.workdir,
            archivedAt: record.archivedAt,
            selectedModel: parseSelectedModelJson(record.selectedModelJson),
          }),
        );
        persistedStateCache.set(id, state);
      }
      onHistory(record);
    }
    setReviewThreadBinding({ ...review, conversationId: id });
    return id;
  }

  const identity = createConversationIdentity();
  const state = createConversationStateFromContext({
    systemPrompt: options.systemPrompt,
    messages: [],
  });
  const review = {
    artifactPath: artifact.path,
    workdir: artifact.workdir,
    parentConversationId: options.parentConversationId,
  };
  state.meta = { ...state.meta, review };
  const summary = await persistConversationState({
    conversationId: identity.conversationId,
    sessionId: identity.sessionId,
    createdAt: identity.createdAt,
    updatedAt: Date.now(),
    cwd: artifact.workdir,
    providerId: options.selectedModel?.customProviderId ?? "",
    model: options.selectedModel?.model ?? "",
    selectedModelJson: serializeSelectedModelJson(options.selectedModel),
    title: `${options.titlePrefix}${artifactBasename(artifact.path)}`,
    state,
    getPreviousState: () => null,
    commitPersistedState: (saved) => persistedStateCache.set(identity.conversationId, saved),
  });
  setConversationRuntimeCacheEntry(
    runtimeCache,
    identity.conversationId,
    createConversationRuntimeEntry({
      state,
      sessionId: identity.sessionId,
      createdAt: identity.createdAt,
      workdir: artifact.workdir,
      selectedModel: options.selectedModel,
    }),
  );
  setReviewThreadBinding({ ...review, conversationId: identity.conversationId });
  onHistory(summary);
  return identity.conversationId;
}
