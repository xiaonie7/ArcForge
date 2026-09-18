import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useLocale } from "../../i18n";
import { createEditId, editScopeFromSelection } from "../../lib/artifactReview/editScope";
import { subscribeArtifactChanges } from "../../lib/artifactReview/events";
import {
  collectScopedEditTurns,
  summarizeScopedEditTurn,
} from "../../lib/artifactReview/inlineEdit";
import type {
  ArtifactAdapter,
  ArtifactEditRecord,
  ArtifactEditResult,
  ArtifactEditScope,
  ArtifactElementsResult,
  ArtifactRef,
  EditScopeKind,
  ScopedEditContext,
  SelectionContext,
} from "../../lib/artifactReview/types";
import type { LiveTranscriptStore } from "../../lib/chat/conversation/liveTranscriptStore";
import type { ConversationRuntimeEntry } from "../../pages/chat/runtime/chatPageRuntime";
import { Loader2, X } from "../icons";
import { containedImageRect, sameReviewArtifact, selectedUnitId } from "./selectionState";

export type InlineEditBridge = {
  threadId: string | null;
  runtime: ConversationRuntimeEntry | null;
  liveTranscriptStore: LiveTranscriptStore;
  hasModels: boolean;
  isAgentMode: boolean;
  loading?: boolean;
  errorMessage?: string | null;
  onRetry?: () => void;
  onSend: (
    instruction: string,
    selection: SelectionContext,
    scope: ArtifactEditScope,
  ) => Promise<boolean>;
  onStop: () => void;
  onReverted: (result: ArtifactEditResult, scope: ArtifactEditScope) => Promise<void>;
};

export type EditPreviewSnapshot = { unitId: string; src: string };
type PendingEdit = {
  scope: ArtifactEditScope;
  selection: SelectionContext;
  instruction: string;
  before: EditPreviewSnapshot | null;
};
const button =
  "rounded-md px-2.5 py-1.5 text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40 disabled:cursor-not-allowed";

/** The review thread stores context and history; the canvas hosts all editing controls. */
export function InlineEditPopover({
  artifact,
  adapter,
  selection,
  elements,
  bridge,
  capturePreview,
  onCompare,
  onActivity,
  historyOpen,
  onHistoryClose,
}: {
  artifact: ArtifactRef;
  adapter: ArtifactAdapter;
  selection: SelectionContext | null;
  elements: ArtifactElementsResult | null;
  bridge: InlineEditBridge;
  capturePreview: () => EditPreviewSnapshot | null;
  onCompare: (snapshot: EditPreviewSnapshot | null) => void;
  onActivity: (scope: ArtifactEditScope | null) => void;
  historyOpen: boolean;
  onHistoryClose: () => void;
}) {
  const { locale } = useLocale();
  const en = locale === "en-US";
  const label = (zh: string, english: string) => (en ? english : zh);
  const live = useSyncExternalStore(
    bridge.liveTranscriptStore.subscribe,
    bridge.liveTranscriptStore.getSnapshot,
  );
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<EditScopeKind>(
    selection?.selection.type === "element" ? "element" : "unit",
  );
  const [open, setOpen] = useState(Boolean(selection));
  const [pending, setPending] = useState<PendingEdit | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [records, setRecords] = useState<ArtifactEditRecord[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [capability, setCapability] = useState<{
    key: string;
    context?: ScopedEditContext;
    error?: string;
  } | null>(null);
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [cardHeight, setCardHeight] = useState(190);
  const frameRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const historySequence = useRef(0);
  const selectionKey = selection
    ? `${selection.selection.type}:${selection.selection.unitId ?? ""}:${selection.selection.id}`
    : "";
  const running = submitting || Boolean(bridge.runtime?.isSending);
  const busy = running || undoing;
  const contextKey = `${selectionKey}:${kind}`;
  const context = capability?.key === contextKey ? capability.context : undefined;
  const contextError = capability?.key === contextKey ? capability.error : undefined;
  const ready = Boolean(
    bridge.threadId &&
      bridge.runtime &&
      bridge.hasModels &&
      bridge.isAgentMode &&
      !bridge.loading &&
      context,
  );
  const messages = useMemo(
    () => bridge.runtime?.state.segments.flatMap((segment) => segment.messages) ?? [],
    [bridge.runtime?.state],
  );
  const turns = useMemo(() => collectScopedEditTurns(messages), [messages]);
  const outcome =
    pending && !running ? summarizeScopedEditTurn(messages, pending.scope.editId) : null;
  const targetRecords = pending
    ? records.filter(
        (record) =>
          record.editId === pending.scope.editId ||
          (outcome?.status === "applied" &&
            outcome.edits.some((edit) => edit.editId === record.editId)),
      )
    : [];
  const applied =
    !running && (outcome?.status === "applied" || targetRecords.some((record) => !record.reverted));
  const reverted = targetRecords.length > 0 && targetRecords.every((record) => record.reverted);
  const latestSelection = useRef(selection);
  latestSelection.current = selection;

  useEffect(() => {
    if (!selection || !adapter.selectionContext || running) return;
    let disposed = false;
    const scope = {
      unitId: kind === "artifact" ? undefined : (selectedUnitId(selection) ?? undefined),
      elementId:
        kind === "element" && selection.selection.type === "element"
          ? selection.selection.id
          : undefined,
    };
    void adapter.selectionContext(artifact, scope).then(
      (value) => {
        if (!disposed) setCapability({ key: contextKey, context: value });
      },
      (error) => {
        if (!disposed) setCapability({ key: contextKey, error: String(error) });
      },
    );
    return () => {
      disposed = true;
    };
  }, [adapter, artifact, contextKey, kind, running, selection]);
  useEffect(() => {
    onActivity(running ? (pending?.scope ?? null) : null);
  }, [running, pending, onActivity]);
  useEffect(() => {
    if (
      !running &&
      pending &&
      (pending.selection.selection.id !== selection?.selection.id ||
        selectedUnitId(pending.selection) !== selectedUnitId(selection))
    )
      setPending(null);
  }, [running, pending, selection]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      historySequence.current++;
      onCompare(null);
    };
  }, [onCompare]);
  useEffect(() => {
    setOpen(Boolean(selectionKey));
    setKind(latestSelection.current?.selection.type === "element" ? "element" : "unit");
    setDraft("");
    if (!busyRef.current) {
      setPending(null);
      setFailure(null);
    }
    onCompare(null);
  }, [selectionKey, onCompare]);
  useEffect(() => {
    if (open && !busy && !historyOpen) inputRef.current?.focus();
  }, [open, selectionKey, busy, historyOpen]);
  useLayoutEffect(() => {
    const node = frameRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() =>
      setFrame({ width: node.clientWidth, height: node.clientHeight }),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const node = cardRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setCardHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, [open, running, historyOpen]);
  const refreshHistory = useCallback(async () => {
    if (!adapter.editHistory) return;
    const sequence = ++historySequence.current;
    try {
      const next = await adapter.editHistory(artifact);
      if (mountedRef.current && sequence === historySequence.current) {
        setRecords(next);
        setHistoryError(null);
      }
    } catch (error) {
      if (mountedRef.current && sequence === historySequence.current)
        setHistoryError(String(error));
    }
  }, [adapter, artifact]);
  useEffect(() => {
    if (!running) void refreshHistory();
  }, [running, refreshHistory, historyOpen]);
  useEffect(
    () =>
      subscribeArtifactChanges((change) => {
        if (sameReviewArtifact(change, artifact)) void refreshHistory();
      }),
    [artifact, refreshHistory],
  );

  // Escape closes the card first; the panel handles a second Escape to clear selection.
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        !frameRef.current?.parentElement?.contains(event.target as Node)
      )
        return;
      if (historyOpen) {
        event.preventDefault();
        event.stopPropagation();
        onHistoryClose();
        return;
      }
      if (open && !running) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        onCompare(null);
      }
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [open, running, historyOpen, onHistoryClose, onCompare]);

  async function send(nextKind = kind, instruction = draft, target = selection) {
    if (busyRef.current || busy || !ready || !target || !instruction.trim()) return;
    busyRef.current = true;
    setKind(nextKind);
    setOpen(true);
    setFailure(null);
    setSubmitting(true);
    onCompare(null);
    try {
      const scope = editScopeFromSelection(target, nextKind, createEditId());
      setPending({ scope, selection: target, instruction, before: capturePreview() });
      const sent = await bridge.onSend(instruction.trim(), target, scope);
      if (mountedRef.current) {
        if (sent) setDraft("");
        else
          setFailure(
            label(
              "修改未完成，可查看记录后重试。",
              "The edit did not complete. Check its details and retry.",
            ),
          );
      }
    } catch (error) {
      if (mountedRef.current) setFailure(String(error));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setSubmitting(false);
        void refreshHistory();
      }
    }
  }

  async function undo(record: ArtifactEditRecord) {
    if (
      busyRef.current ||
      busy ||
      !adapter.revertEdit ||
      !adapter.selectionContext ||
      record.reverted
    )
      return;
    busyRef.current = true;
    setUndoing(true);
    setFailure(null);
    onCompare(null);
    let restored = false;
    try {
      const context = await adapter.selectionContext(artifact, {});
      const scope: ArtifactEditScope = {
        editId: record.editId,
        kind: record.scope,
        artifact,
        unitId: record.unitId,
        elementId: record.elementId,
        manifestPath: context.manifestPath,
        templatePath: context.templatePath,
      };
      const result = await adapter.revertEdit(artifact, {
        editId: record.editId,
        manifestPath: context.manifestPath,
        templatePath: context.templatePath,
      });
      restored = true;
      if (mountedRef.current)
        setRecords((current) =>
          current.map((item) =>
            item.editId === record.editId ? { ...item, reverted: true } : item,
          ),
        );
      await bridge.onReverted(result, scope);
    } catch (error) {
      if (mountedRef.current)
        setFailure(
          `${restored ? label("文件已撤销，但上下文记录保存失败：", "The file was restored, but the context note could not be saved: ") : ""}${String(error)}`,
        );
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setUndoing(false);
        void refreshHistory();
      }
    }
  }

  const displaySelection = running && pending ? pending.selection : selection;
  const displayKind = running && pending ? pending.scope.kind : kind;
  const canvas = elements?.canvas ?? [1280, 720];
  const rect = containedImageRect(frame, { width: canvas[0], height: canvas[1] });
  const box =
    displayKind === "element" && selectedUnitId(displaySelection) === elements?.unitId
      ? displaySelection?.selection.bbox
      : undefined;
  const width = Math.min(380, Math.max(0, frame.width - 16));
  const anchorLeft =
    rect && box ? rect.left + (box[0] / canvas[0]) * rect.width : (frame.width - width) / 2;
  const anchorBottom =
    rect && box
      ? rect.top + ((box[1] + box[3]) / canvas[1]) * rect.height
      : frame.height - cardHeight - 16;
  const anchorTop = rect && box ? rect.top + (box[1] / canvas[1]) * rect.height : anchorBottom;
  const top = Math.max(
    8,
    Math.min(
      frame.height - cardHeight - 8,
      anchorBottom + cardHeight + 8 <= frame.height ? anchorBottom + 8 : anchorTop - cardHeight - 8,
    ),
  );
  const left = Math.max(8, Math.min(frame.width - width - 8, anchorLeft));
  const alert =
    failure ||
    contextError ||
    bridge.errorMessage ||
    (!running ? bridge.runtime?.errorMessage : null);
  const historyEntries = [
    ...turns.map((turn) => ({
      id: turn.editId,
      title: turn.instruction,
      scope: turn.scope,
      outcome: turn.outcome,
      timestamp: turn.timestamp,
      details: turn.details,
      records: records.filter(
        (record) =>
          record.editId === turn.editId ||
          (turn.outcome?.status === "applied" &&
            turn.outcome.edits.some((edit) => edit.editId === record.editId)),
      ),
    })),
    ...records
      .filter(
        (record) =>
          !turns.some(
            (turn) =>
              turn.editId === record.editId ||
              (turn.outcome?.status === "applied" &&
                turn.outcome.edits.some((edit) => edit.editId === record.editId)),
          ),
      )
      .map((record) => ({
        id: record.editId,
        title: record.afterText,
        scope: { kind: record.scope, unitId: record.unitId, elementId: record.elementId },
        outcome: null,
        timestamp: Date.parse(record.createdAt),
        details: `${record.beforeText}\n→\n${record.afterText}`,
        records: [record],
      })),
  ].sort((a, b) => b.timestamp - a.timestamp);

  return (
    <div ref={frameRef} className="pointer-events-none absolute inset-3 z-20" data-inline-edit-root>
      {historyOpen ? (
        <section
          aria-label={label("编辑记录", "Edit history")}
          className="pointer-events-auto absolute inset-y-0 right-0 flex w-full max-w-md flex-col rounded-xl border border-border bg-background shadow-xl"
        >
          <header className="flex items-center justify-between border-b border-border p-3">
            <h3 className="text-sm font-medium">
              {label("编辑记录", "Edit history")} · {historyEntries.length}
            </h3>
            <button
              type="button"
              className={button}
              onClick={onHistoryClose}
              aria-label={label("关闭记录", "Close history")}
            >
              <X className="h-4 w-4" />
            </button>
          </header>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {historyError ? (
              <p className="break-words text-xs text-muted-foreground">{historyError}</p>
            ) : null}
            {alert ? (
              <p role="alert" className="break-words text-xs text-destructive">
                {alert}
              </p>
            ) : null}
            {!historyEntries.length ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                {label("编辑后，记录会显示在这里。", "Your edits will appear here.")}
              </p>
            ) : null}
            {historyEntries.map((entry) => {
              const allReverted =
                entry.records.length > 0 && entry.records.every((record) => record.reverted);
              const active = running && (pending?.scope.editId ?? turns[0]?.editId) === entry.id;
              const status = active
                ? label("修改中", "Editing")
                : allReverted
                  ? label("已撤销", "Reverted")
                  : entry.records.length || entry.outcome?.status === "applied"
                    ? label("已保留", "Kept")
                    : entry.outcome?.status === "needs_scope"
                      ? label("需扩大范围", "Needs wider scope")
                      : label("未完成", "Incomplete");
              return (
                <article key={entry.id} className="rounded-lg border border-border p-3 text-xs">
                  <div className="flex justify-between gap-2 text-muted-foreground">
                    <span>
                      {Number.isFinite(entry.timestamp)
                        ? new Date(entry.timestamp).toLocaleTimeString(locale, {
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : ""}{" "}
                      · {entry.scope.elementId ? `#${entry.scope.elementId} · ` : ""}
                      {entry.scope.unitId ?? label("整个演示文稿", "Whole deck")}
                    </span>
                    <span className="shrink-0">{status}</span>
                  </div>
                  <p className="my-2 whitespace-pre-wrap break-words">{entry.title}</p>
                  {entry.records
                    .filter((record) => !record.reverted)
                    .map((record) => (
                      <button
                        type="button"
                        key={record.editId}
                        className={button}
                        disabled={busy || !ready}
                        onClick={() => void undo(record)}
                      >
                        {label("撤销", "Undo")}
                        {entry.records.length > 1 ? ` · ${record.unitId}` : ""}
                      </button>
                    ))}
                  <details>
                    <summary className="cursor-pointer py-1 text-muted-foreground">
                      {label("详情", "Details")}
                    </summary>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 font-sans text-[11px]">
                      {entry.details || entry.outcome?.summary || status}
                    </pre>
                  </details>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {!historyOpen && (open || running) && (displaySelection || running) ? (
        <div
          ref={cardRef}
          role="region"
          aria-label={label("修改选区", "Edit selection")}
          className="pointer-events-auto absolute max-h-full overflow-y-auto rounded-xl border border-border bg-background/95 p-3 shadow-xl backdrop-blur"
          style={{ top, left, width }}
        >
          <div className="mb-2 flex items-center gap-2">
            <select
              aria-label={label("修改范围", "Edit scope")}
              value={displayKind}
              disabled={busy}
              onChange={(event) => {
                setKind(event.target.value as EditScopeKind);
                setPending(null);
              }}
              className={`min-w-0 max-w-[65%] rounded-md border border-border px-2 py-1 text-xs ${displayKind === "artifact" ? "bg-amber-500/15" : "bg-muted/60"}`}
            >
              {displaySelection?.selection.type === "element" ? (
                <option value="element">
                  {label("这个元素", "This element")} · #{displaySelection.selection.id}
                </option>
              ) : null}
              <option value="unit">
                {label("整页", "Whole page")} · {selectedUnitId(displaySelection)}
              </option>
              <option value="artifact">{label("整个演示文稿", "Whole deck")}</option>
            </select>
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
              {displaySelection?.selection.unitLabel ?? displaySelection?.selection.label}
            </span>
            {!running ? (
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:bg-muted"
                aria-label={label("关闭编辑框", "Close editor")}
                onClick={() => {
                  setOpen(false);
                  onCompare(null);
                }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          {running ? (
            <div className="flex items-center gap-2 text-xs" role="status">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              <span className="min-w-0 flex-1 truncate">
                {live.toolStatus || label("正在修改选区…", "Editing selection…")}
              </span>
              <button type="button" className={button} onClick={bridge.onStop}>
                {label("停止", "Stop")}
              </button>
            </div>
          ) : (
            <>
              {displayKind === "artifact" ? (
                <p className="mb-2 text-[11px] text-amber-700 dark:text-amber-300">
                  {label(
                    "将允许修改所有页；整份重建的结果不支持单条撤销。",
                    "Allows changes across pages. A full rebuild cannot be undone as one edit.",
                  )}
                </p>
              ) : null}
              {context?.replacementKind.startsWith("template_") ? (
                <p className="mb-2 text-[11px] text-muted-foreground">
                  {context.replacementKind === "template_table"
                    ? label(
                        "模板表格：可修改单元格内容，保留行列与样式。",
                        "Template table: edit cell content while keeping its structure and style.",
                      )
                    : label(
                        "模板元素：可修改文字和表格内容，保留原始布局。",
                        "Template content: edit text and tables while preserving the original layout.",
                      )}
                </p>
              ) : null}
              {applied ? (
                <div className="mb-2 text-xs" role="status">
                  <p className="max-h-24 overflow-auto whitespace-pre-wrap break-words">
                    {reverted
                      ? label("已撤销这次修改。", "This edit was reverted.")
                      : outcome?.summary || label("修改已应用。", "Edit applied.")}
                  </p>
                  {!reverted ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {pending?.before ? (
                        <button
                          type="button"
                          className={button}
                          onPointerDown={(event) => {
                            event.currentTarget.setPointerCapture(event.pointerId);
                            onCompare(pending.before);
                          }}
                          onPointerUp={() => onCompare(null)}
                          onPointerCancel={() => onCompare(null)}
                          onLostPointerCapture={() => onCompare(null)}
                          onKeyDown={(event) => {
                            if (event.key === " " || event.key === "Enter") {
                              event.preventDefault();
                              onCompare(pending.before);
                            }
                          }}
                          onKeyUp={() => onCompare(null)}
                          onBlur={() => onCompare(null)}
                        >
                          {label("按住对比", "Hold to compare")}
                        </button>
                      ) : null}
                      {targetRecords
                        .filter((record) => !record.reverted)
                        .map((record) => (
                          <button
                            type="button"
                            key={record.editId}
                            className={button}
                            disabled={busy}
                            onClick={() => void undo(record)}
                          >
                            {label("撤销", "Undo")}
                            {targetRecords.length > 1 ? ` · ${record.unitId}` : ""}
                          </button>
                        ))}
                      <button
                        type="button"
                        className={button}
                        disabled={busy}
                        onClick={() => {
                          setPending(null);
                          setOpen(false);
                          onCompare(null);
                        }}
                      >
                        {label("保留", "Keep")}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {!applied && outcome?.status === "needs_scope" && pending ? (
                <div className="mb-2 text-xs">
                  <p className="mb-2 whitespace-pre-wrap break-words">{outcome.reason}</p>
                  <div className="flex flex-wrap gap-1">
                    {pending.scope.kind === "element" ? (
                      <button
                        type="button"
                        className={button}
                        disabled={busy}
                        onClick={() => void send("unit", pending.instruction, pending.selection)}
                      >
                        {label("扩大到整页并重试", "Retry on the whole page")}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={button}
                      disabled={busy}
                      onClick={() => void send("artifact", pending.instruction, pending.selection)}
                    >
                      {label("扩大到全部页并重试", "Retry on the whole deck")}
                    </button>
                  </div>
                </div>
              ) : null}
              {alert || (!applied && outcome?.status === "failed") ? (
                <p
                  role="alert"
                  className="mb-2 max-h-24 overflow-auto whitespace-pre-wrap break-words text-xs text-destructive"
                >
                  {alert ||
                    (outcome?.status === "failed"
                      ? outcome.message ||
                        label("没有已确认的修改。", "No confirmed edit was returned.")
                      : "")}
                </p>
              ) : null}
              {!ready ? (
                <div className="mb-2 text-xs text-muted-foreground">
                  {bridge.loading || !capability || capability.key !== contextKey
                    ? label("正在加载编辑上下文…", "Loading edit context…")
                    : !bridge.hasModels
                      ? label("请先配置模型。", "Configure a model to edit.")
                      : !bridge.isAgentMode
                        ? label("请切换到 Agent 模式后修改。", "Switch to Agent mode to edit.")
                        : label("编辑上下文暂不可用。", "Edit context is unavailable.")}
                  {bridge.onRetry ? (
                    <button type="button" className={button} onClick={bridge.onRetry}>
                      {label("重试", "Retry")}
                    </button>
                  ) : null}
                </div>
              ) : null}
              <textarea
                ref={inputRef}
                value={draft}
                disabled={busy || !ready}
                rows={2}
                aria-label={label("修改指令", "Edit instruction")}
                placeholder={
                  applied
                    ? label("继续修改…", "Continue editing…")
                    : label("描述如何修改选区…", "Describe how to edit this selection…")
                }
                className="max-h-28 min-h-12 w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
                onChange={(event) => {
                  setDraft(event.target.value);
                  event.target.style.height = "auto";
                  event.target.style.height = `${Math.min(112, event.target.scrollHeight)}px`;
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted-foreground">
                  {label(
                    "Enter 修改 · Shift+Enter 换行",
                    "Enter to edit · Shift+Enter for a new line",
                  )}
                </span>
                <button
                  type="button"
                  className={`${button} bg-foreground text-background hover:opacity-85 hover:bg-foreground`}
                  disabled={busy || !ready || !draft.trim() || !selection}
                  onClick={() => void send()}
                >
                  {undoing ? label("撤销中…", "Undoing…") : label("修改", "Edit")}
                </button>
              </div>
              {!applied && pending && (failure || outcome?.status === "failed") ? (
                <button
                  type="button"
                  className={`${button} mt-1`}
                  disabled={busy || !ready}
                  onClick={() =>
                    void send(pending.scope.kind, pending.instruction, pending.selection)
                  }
                >
                  {label("重试上次修改", "Retry last edit")}
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {!open && selection && !historyOpen && !running ? (
        <button
          type="button"
          className={`${button} pointer-events-auto absolute bottom-2 left-1/2 -translate-x-1/2 border border-border bg-background shadow`}
          onClick={() => setOpen(true)}
        >
          {label("修改选区", "Edit selection")}
        </button>
      ) : null}
    </div>
  );
}
