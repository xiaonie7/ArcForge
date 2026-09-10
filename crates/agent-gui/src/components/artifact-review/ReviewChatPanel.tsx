import { useCallback, useEffect, useRef, useState } from "react";

import { useLocale } from "../../i18n";
import {
  type ArtifactRef,
  artifactBasename,
  type SelectionContext,
  selectionTitle,
} from "../../lib/artifactReview/types";
import type { LiveTranscriptStore } from "../../lib/chat/conversation/liveTranscriptStore";
import type { ScrollFollowHandle } from "../../lib/chat-scroll/useScrollFollow";
import type { ConversationRuntimeEntry } from "../../pages/chat/runtime/chatPageRuntime";
import { ChatTranscript } from "../../pages/chat/transcript/ChatTranscript";
import type { SectionId } from "../../pages/settings/types";
import {
  MentionComposer,
  type MentionComposerDraft,
  type MentionComposerHandle,
  type MentionComposerSkill,
} from "../chat/MentionComposer";

export type ReviewChatPanelProps = {
  threadId: string | null;
  artifact: ArtifactRef;
  selection: SelectionContext | null;
  runtime: ConversationRuntimeEntry | null;
  liveTranscriptStore: LiveTranscriptStore;
  hasModels: boolean;
  isAgentMode: boolean;
  enabledSkills?: MentionComposerSkill[];
  onSend: (draft: MentionComposerDraft) => Promise<boolean>;
  onStop: () => void;
  onOpenSettings: (section?: SectionId) => void;
  loading?: boolean;
  errorMessage?: string | null;
  onRetry?: () => void;
};

/** A review conversation uses the same transcript and editor as the main chat. */
export function ReviewChatPanel({
  threadId,
  artifact,
  selection,
  runtime,
  liveTranscriptStore,
  hasModels,
  isAgentMode,
  enabledSkills,
  onSend,
  onStop,
  onOpenSettings,
  loading = false,
  errorMessage,
  onRetry,
}: ReviewChatPanelProps) {
  const { locale } = useLocale();
  const english = locale === "en-US";
  const composerRef = useRef<MentionComposerHandle | null>(null);
  const followRef = useRef<ScrollFollowHandle | null>(null);
  const mountedRef = useRef(true);
  const submittingRef = useRef(false);
  const [isEmpty, setIsEmpty] = useState(true);
  const [composerBusy, setComposerBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const isSending = runtime?.isSending ?? false;
  const isCompactionRunning = runtime?.compactionStatus.phase === "running";
  const ready = Boolean(threadId && runtime) && !loading && hasModels;
  const composerDisabled = !ready || isSending || isCompactionRunning || submitting;
  const failure = errorMessage || sendError || runtime?.errorMessage;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const send = useCallback(async () => {
    if (composerDisabled || composerBusy || submittingRef.current) return;
    const draft = composerRef.current?.getDraft();
    if (!draft || draft.isEmpty) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSendError(null);
    followRef.current?.stickToBottom();
    try {
      const sent = await onSend(draft);
      if (sent && mountedRef.current) {
        composerRef.current?.clear();
        setIsEmpty(true);
      }
    } catch (error) {
      if (mountedRef.current) {
        setSendError(
          error instanceof Error && error.message
            ? error.message
            : english
              ? "Could not send the review message. Your draft is kept."
              : "评审消息发送失败，草稿已保留。",
        );
      }
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }, [composerBusy, composerDisabled, english, onSend]);

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
      aria-label={english ? "Review chat" : "评审对话"}
    >
      <header className="shrink-0 border-b border-border/60 px-3 py-2.5">
        <h3 className="text-sm font-medium">{english ? "Review chat" : "评审对话"}</h3>
        <p className="mt-0.5 truncate text-xs text-muted-foreground" title={artifact.path}>
          {artifactBasename(artifact.path)}
        </p>
      </header>

      {threadId && runtime ? (
        <ChatTranscript
          conversationId={threadId}
          workspaceRoot={artifact.workdir}
          followRef={followRef}
          hasModels={hasModels}
          historyItems={runtime.state.historyRenderItems}
          isHistorySwitching={loading}
          isSending={isSending}
          isAgentMode={isAgentMode}
          showUsage={false}
          liveTranscriptStore={liveTranscriptStore}
          isCompactionRunning={isCompactionRunning}
          compact
          onOpenSettings={onOpenSettings}
        />
      ) : (
        <div role="status" className="flex min-h-0 flex-1 items-center justify-center px-4 py-6">
          <p className="text-center text-sm text-muted-foreground">
            {loading
              ? english
                ? "Opening review chat…"
                : "正在打开评审对话…"
              : english
                ? "Review chat is unavailable."
                : "评审对话暂不可用。"}
          </p>
        </div>
      )}

      {failure ? (
        <div role="alert" className="shrink-0 border-t border-border/60 px-3 py-2 text-xs">
          <p className="max-h-24 overflow-auto break-words text-destructive">{failure}</p>
          {onRetry && !loading && !isSending ? (
            <button
              type="button"
              className="mt-1.5 rounded px-2 py-1 text-foreground hover:bg-accent"
              onClick={onRetry}
            >
              {english ? "Retry" : "重试"}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="shrink-0 border-t border-border/60 p-3">
        <div className="mb-2 rounded-md bg-muted/60 px-2.5 py-2 text-xs" aria-live="polite">
          <p className="text-muted-foreground">{english ? "Current context" : "当前上下文"}</p>
          <p
            className="mt-1 break-words text-foreground"
            title={selection ? selectionTitle(selection) : artifact.path}
          >
            {selection ? selectionTitle(selection) : artifactBasename(artifact.path)}
          </p>
        </div>
        <div className="rounded-lg border border-border/70 bg-background p-2.5">
          <MentionComposer
            ref={composerRef}
            workdir={artifact.workdir}
            enabledSkills={enabledSkills}
            disabled={composerDisabled}
            onEmptyChange={setIsEmpty}
            onBusyChange={setComposerBusy}
            onSend={() => void send()}
            placeholder={english ? "Discuss or edit the current selection…" : "讨论或修改当前选区…"}
            className="min-h-[60px] max-h-[140px]"
          />
          <div className="mt-2 flex justify-end">
            {isSending ? (
              <button
                type="button"
                className="rounded-md bg-foreground px-3 py-1.5 text-xs text-background hover:opacity-85"
                onClick={onStop}
              >
                {english ? "Stop" : "停止"}
              </button>
            ) : (
              <button
                type="button"
                className="rounded-md bg-foreground px-3 py-1.5 text-xs text-background hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={composerDisabled || composerBusy || isEmpty}
                onClick={() => void send()}
              >
                {english ? "Send" : "发送"}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
