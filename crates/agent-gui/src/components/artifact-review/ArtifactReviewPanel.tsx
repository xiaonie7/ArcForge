import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useLocale } from "../../i18n";
import {
  type ArtifactChange,
  type ArtifactElementsResult,
  type ArtifactRef,
  type ArtifactUnit,
  artifactBasename,
  getArtifactAdapterForPath,
  type SelectionContext,
  selectionTitle,
  subscribeArtifactChanges,
} from "../../lib/artifactReview";
import { cn } from "../../lib/shared/utils";
import { AlertTriangle, ChevronRight, Loader2, RefreshCw, X } from "../icons";
import type { WorkspaceFilePreviewOpenRequest } from "../workspace-editor/WorkspaceFilePreviewOverlay";
import { ElementOverlay } from "./ElementOverlay";
import {
  elementSelection,
  reconcileReviewSelection,
  sameReviewArtifact,
  selectedUnitId,
  unitSelection,
} from "./selectionState";

const THUMBNAIL_WIDTH = 320;
const PREVIEW_WIDTH = 1600;

type UnitImage = { blobUrl: string; version: number; unitId: string };
type PanelProps = {
  request: WorkspaceFilePreviewOpenRequest;
  selection: SelectionContext | null;
  onSelect: (selection: SelectionContext | null) => void;
  onRequestClose: () => void;
  reviewChat?: ReactNode;
};

function base64ToBlobUrl(data: string, mimeType: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

function toMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback;
}

/** Changing artifacts disposes every image and request, even when both files use the same ids. */
export function ArtifactReviewPanel(props: PanelProps) {
  return (
    <ArtifactReviewView
      key={JSON.stringify([props.request.workdir, props.request.path])}
      {...props}
    />
  );
}

function ArtifactReviewView({
  request,
  selection,
  onSelect,
  onRequestClose,
  reviewChat,
}: PanelProps) {
  const { t } = useLocale();
  const adapter = useMemo(() => getArtifactAdapterForPath(request.path), [request.path]);
  const artifact = useMemo<ArtifactRef | null>(
    () =>
      adapter ? { artifactType: adapter.type, workdir: request.workdir, path: request.path } : null,
    [adapter, request.path, request.workdir],
  );
  const [units, setUnits] = useState<ArtifactUnit[]>([]);
  const [unitsLoading, setUnitsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeUnitId, setActiveUnitId] = useState<string | null>(null);
  const [thumbnails, setThumbnails] = useState<Record<string, UnitImage>>({});
  const [preview, setPreview] = useState<UnitImage | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [elements, setElements] = useState<ArtifactElementsResult | null>(null);
  const [versions, setVersions] = useState<Record<string, number>>({});
  const panelRef = useRef<HTMLDivElement>(null);
  const unitsRef = useRef<ArtifactUnit[]>([]);
  const selectionRef = useRef(selection);
  const onSelectRef = useRef(onSelect);
  const activeUnitIdRef = useRef<string | null>(null);
  const thumbnailsRef = useRef<Record<string, UnitImage>>({});
  const previewRef = useRef<UnitImage | null>(null);
  const mountedRef = useRef(false);
  const unitsSequenceRef = useRef(0);
  const detailSequenceRef = useRef(0);
  const initialLoadRef = useRef(true);
  const pendingInvalidationsRef = useRef(new Set<string>());
  const invalidateAllRef = useRef(false);
  selectionRef.current = selection;
  onSelectRef.current = onSelect;
  activeUnitIdRef.current = activeUnitId;

  const publishSelection = useCallback((next: SelectionContext | null) => {
    if (JSON.stringify(selectionRef.current) === JSON.stringify(next)) return;
    selectionRef.current = next;
    onSelectRef.current(next);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      unitsSequenceRef.current += 1;
      detailSequenceRef.current += 1;
      for (const image of Object.values(thumbnailsRef.current)) URL.revokeObjectURL(image.blobUrl);
      thumbnailsRef.current = {};
      if (previewRef.current) URL.revokeObjectURL(previewRef.current.blobUrl);
      previewRef.current = null;
    };
  }, []);

  const reconcile = useCallback(
    (nextUnits: ArtifactUnit[], nextElements?: ArtifactElementsResult) => {
      if (!artifact) return;
      const result = reconcileReviewSelection(
        selectionRef.current,
        artifact,
        nextUnits,
        nextElements,
      );
      publishSelection(result.selection);
      if (result.removed) {
        setNotice(
          t(
            result.removed === "unit"
              ? "artifactReview.slideRemoved"
              : "artifactReview.elementRemoved",
          ),
        );
      }
    },
    [artifact, publishSelection, t],
  );

  const loadUnits = useCallback(
    async (change?: ArtifactChange | "all") => {
      if (!adapter || !artifact) return;
      if (change === "all" || change?.changedUnits === "all") {
        invalidateAllRef.current = true;
      } else if (change) {
        for (const unit of change.changedUnits) pendingInvalidationsRef.current.add(unit.id);
      }
      // A rebuild can complete while an older preview is in flight. Invalidate it immediately.
      if (
        invalidateAllRef.current ||
        pendingInvalidationsRef.current.has(activeUnitIdRef.current ?? "")
      ) {
        detailSequenceRef.current += 1;
        setElements(null);
      }
      const sequence = ++unitsSequenceRef.current;
      setUnitsLoading(true);
      setError(null);
      try {
        const next = await adapter.listUnits(artifact);
        if (!mountedRef.current || sequence !== unitsSequenceRef.current) return;
        const nextIds = new Set(next.map((unit) => unit.id));
        const retainedThumbnails = { ...thumbnailsRef.current };
        for (const [id, image] of Object.entries(retainedThumbnails)) {
          if (!nextIds.has(id)) {
            URL.revokeObjectURL(image.blobUrl);
            delete retainedThumbnails[id];
          }
        }
        thumbnailsRef.current = retainedThumbnails;
        setThumbnails(retainedThumbnails);
        const invalidated = invalidateAllRef.current
          ? new Set(next.map((unit) => unit.id))
          : new Set(pendingInvalidationsRef.current);
        pendingInvalidationsRef.current.clear();
        invalidateAllRef.current = false;
        setVersions((current) =>
          Object.fromEntries(
            next.map((unit) => [
              unit.id,
              (current[unit.id] ?? 0) + (invalidated.has(unit.id) ? 1 : 0),
            ]),
          ),
        );
        unitsRef.current = next;
        setUnits(next);
        const currentSelection = selectionRef.current;
        const selectionBelongs =
          currentSelection && sameReviewArtifact(currentSelection.artifact, artifact);
        const selectedId = selectionBelongs ? selectedUnitId(currentSelection) : null;
        const nextActive =
          next.find((unit) => unit.id === activeUnitIdRef.current) ??
          next.find((unit) => unit.id === selectedId) ??
          next[0];
        activeUnitIdRef.current = nextActive?.id ?? null;
        setActiveUnitId(nextActive?.id ?? null);
        // Only the first open chooses a default. A removed slide must leave selection empty.
        if (initialLoadRef.current && !selectionBelongs && nextActive) {
          publishSelection(unitSelection(artifact, nextActive, next.length));
        } else {
          reconcile(next);
        }
        initialLoadRef.current = false;
      } catch (loadError) {
        if (mountedRef.current && sequence === unitsSequenceRef.current) {
          setError(toMessage(loadError, t("artifactReview.loadFailed")));
          setPreviewLoading(false);
        }
      } finally {
        if (mountedRef.current && sequence === unitsSequenceRef.current) setUnitsLoading(false);
      }
    },
    [adapter, artifact, publishSelection, reconcile, t],
  );

  useEffect(() => {
    void loadUnits();
  }, [loadUnits]);

  useEffect(() => {
    if (!artifact) return;
    return subscribeArtifactChanges((change) => {
      if (sameReviewArtifact(change, artifact)) void loadUnits(change);
    });
  }, [artifact, loadUnits]);

  useEffect(() => {
    const clearOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !panelRef.current?.contains(event.target as Node)) return;
      if (!selectionRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      publishSelection(null);
      setNotice(null);
    };
    window.addEventListener("keydown", clearOnEscape, true);
    return () => window.removeEventListener("keydown", clearOnEscape, true);
  }, [publishSelection]);

  // Progressive cache: metadata reloads do not refetch images for unchanged units.
  useEffect(() => {
    if (!adapter || !artifact) return;
    let cancelled = false;
    void (async () => {
      for (const unit of units) {
        if (cancelled) return;
        const version = versions[unit.id] ?? 0;
        if (thumbnailsRef.current[unit.id]?.version === version) continue;
        try {
          const image = await adapter.previewUnit(artifact, unit, { width: THUMBNAIL_WIDTH });
          if (cancelled || !mountedRef.current) return;
          const previous = thumbnailsRef.current[unit.id];
          const next = {
            blobUrl: base64ToBlobUrl(image.data, image.mimeType),
            version,
            unitId: unit.id,
          };
          if (previous) URL.revokeObjectURL(previous.blobUrl);
          thumbnailsRef.current = { ...thumbnailsRef.current, [unit.id]: next };
          setThumbnails(thumbnailsRef.current);
        } catch {
          // The large preview supplies a readable error; navigation remains available.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adapter, artifact, units, versions]);

  const activeUnit = units.find((unit) => unit.id === activeUnitId) ?? null;
  const activeOrder = activeUnit?.order;
  const activeVersion = activeUnitId ? (versions[activeUnitId] ?? 0) : 0;
  useEffect(() => {
    if (!adapter || !artifact || !activeUnitId || activeOrder === undefined) return;
    const sequence = ++detailSequenceRef.current;
    let cancelled = false;
    const currentRequest = () =>
      !cancelled && mountedRef.current && sequence === detailSequenceRef.current;
    const unit = { id: activeUnitId, order: activeOrder };
    if (previewRef.current?.unitId !== unit.id) {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current.blobUrl);
      previewRef.current = null;
      setPreview(null);
    }
    setElements(null);
    setPreviewLoading(true);
    setError(null);
    void Promise.allSettled([
      adapter.previewUnit(artifact, unit, { width: PREVIEW_WIDTH }),
      adapter.listElements?.(artifact, unit) ?? Promise.resolve(null),
    ]).then(([imageResult, elementsResult]) => {
      if (!currentRequest()) return;
      if (imageResult.status === "fulfilled") {
        const image = imageResult.value;
        const next = {
          blobUrl: base64ToBlobUrl(image.data, image.mimeType),
          version: activeVersion,
          unitId: unit.id,
        };
        if (previewRef.current) URL.revokeObjectURL(previewRef.current.blobUrl);
        previewRef.current = next;
        setPreview(next);
      } else {
        if (previewRef.current) URL.revokeObjectURL(previewRef.current.blobUrl);
        previewRef.current = null;
        setPreview(null);
        setError(toMessage(imageResult.reason, t("artifactReview.loadFailed")));
      }
      if (elementsResult.status === "fulfilled" && elementsResult.value?.unitId === unit.id) {
        setElements(elementsResult.value);
        reconcile(unitsRef.current, elementsResult.value);
      } else if (adapter.listElements) {
        setError(t("artifactReview.elementsLoadFailed"));
      }
      setPreviewLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [adapter, artifact, activeUnitId, activeOrder, activeVersion, reconcile, t]);

  const selectUnit = useCallback(
    (unit: ArtifactUnit) => {
      if (!artifact) return;
      activeUnitIdRef.current = unit.id;
      setActiveUnitId(unit.id);
      setNotice(null);
      publishSelection(unitSelection(artifact, unit, units.length));
    },
    [artifact, publishSelection, units.length],
  );

  if (!adapter || !artifact) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("artifactReview.unsupported")}
      </div>
    );
  }

  const activeIndex = activeUnit ? units.findIndex((unit) => unit.id === activeUnit.id) : -1;
  const ownSelection =
    selection && sameReviewArtifact(selection.artifact, artifact) ? selection : null;
  const selected = ownSelection && selectedUnitId(ownSelection) === activeUnit?.id;
  const currentPreview = preview?.unitId === activeUnitId ? preview : null;
  const currentElements = elements?.unitId === activeUnitId ? elements : null;

  return (
    <div ref={panelRef} className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[13px] font-medium text-foreground/90"
            title={artifact.path}
          >
            {artifactBasename(artifact.path)}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {t("artifactReview.subtitle").replace("{count}", String(units.length))}
          </div>
        </div>
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-45"
          title={t("artifactReview.reload")}
          aria-label={t("artifactReview.reload")}
          disabled={unitsLoading}
          onClick={() => {
            void loadUnits("all");
          }}
        >
          <RefreshCw className={cn("h-4 w-4", unitsLoading && "animate-spin")} />
        </button>
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={t("artifactReview.close")}
          aria-label={t("artifactReview.close")}
          onClick={onRequestClose}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {error || notice ? (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">{error || notice}</div>
          {notice && !error ? (
            <button
              type="button"
              aria-label={t("artifactReview.close")}
              onClick={() => setNotice(null)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}

      <div className={cn("flex min-h-0 flex-1", reviewChat && "basis-1/2")}>
        <div className="artifact-review-navigator flex w-32 shrink-0 flex-col gap-2 overflow-y-auto border-r border-border bg-muted/20 p-2">
          {unitsLoading && units.length === 0 ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : null}
          {units.map((unit) => {
            const thumbnail = thumbnails[unit.id];
            const isActive = unit.id === activeUnit?.id;
            const isSelected = selectedUnitId(ownSelection) === unit.id;
            return (
              <button
                key={unit.id}
                type="button"
                onClick={() => selectUnit(unit)}
                title={unit.label}
                aria-pressed={Boolean(isSelected)}
                className={cn(
                  "group flex flex-col gap-1 rounded-lg border p-1 text-left transition-colors",
                  isActive
                    ? "border-primary/60 bg-primary/5"
                    : "border-transparent hover:border-border hover:bg-muted/60",
                )}
              >
                <div className="relative aspect-video w-full overflow-hidden rounded-md border border-border/60 bg-white">
                  {thumbnail ? (
                    <img
                      src={thumbnail.blobUrl}
                      alt={unit.label}
                      className="h-full w-full object-contain"
                      draggable={false}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground/60" />
                    </div>
                  )}
                  {isSelected ? (
                    <span className="absolute left-1 top-1 rounded bg-primary px-1 text-[10px] font-medium text-primary-foreground">
                      {t("artifactReview.selectedBadge")}
                    </span>
                  ) : null}
                </div>
                <div className="truncate px-0.5 text-[11px] text-muted-foreground">
                  {unit.label}
                </div>
              </button>
            );
          })}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/25 p-3">
            {currentPreview && activeUnit ? (
              <ElementOverlay
                imageSrc={currentPreview.blobUrl}
                label={activeUnit.label}
                elements={currentElements}
                selectedId={
                  selected && ownSelection?.selection.type === "element"
                    ? ownSelection.selection.id
                    : null
                }
                loading={previewLoading}
                onSelectUnit={() => selectUnit(activeUnit)}
                onSelect={(element) => {
                  setNotice(null);
                  publishSelection(elementSelection(artifact, activeUnit, element, units.length));
                }}
              />
            ) : previewLoading ? (
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-t border-border bg-muted/35 px-2 py-1 text-xs text-muted-foreground">
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                disabled={activeIndex <= 0}
                onClick={() => {
                  const unit = units[activeIndex - 1];
                  if (unit) selectUnit(unit);
                }}
                aria-label={t("workspaceFilePreview.prevSlide")}
              >
                <ChevronRight className="h-4 w-4 rotate-180" />
              </button>
              <span className="min-w-[5rem] text-center tabular-nums">
                {activeUnit
                  ? t("workspaceFilePreview.slidePage")
                      .replace("{current}", String(activeUnit.order))
                      .replace("{total}", String(units.length))
                  : ""}
              </span>
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                disabled={activeIndex < 0 || activeIndex >= units.length - 1}
                onClick={() => {
                  const unit = units[activeIndex + 1];
                  if (unit) selectUnit(unit);
                }}
                aria-label={t("workspaceFilePreview.nextSlide")}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <span
                className="truncate"
                title={ownSelection ? selectionTitle(ownSelection) : undefined}
              >
                {selected
                  ? t("artifactReview.selectionActive").replace(
                      "{unit}",
                      ownSelection.selection.label,
                    )
                  : t("artifactReview.selectionHint")}
              </span>
              {ownSelection ? (
                <button
                  type="button"
                  className="shrink-0 rounded px-1.5 py-0.5 text-[11px] hover:bg-muted hover:text-foreground"
                  onClick={() => {
                    publishSelection(null);
                    setNotice(null);
                  }}
                >
                  {t("artifactReview.clearSelection")}
                </button>
              ) : null}
            </div>
            {adapter.listElements && !previewLoading && currentElements ? (
              <div className="w-full px-1 pb-0.5 text-[10px]">
                {t(
                  currentElements.elements.length
                    ? "artifactReview.elementHint"
                    : "artifactReview.noElements",
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {reviewChat ? (
        <div className="flex min-h-0 flex-1 basis-1/2 flex-col border-t border-border">
          {reviewChat}
        </div>
      ) : null}
    </div>
  );
}
