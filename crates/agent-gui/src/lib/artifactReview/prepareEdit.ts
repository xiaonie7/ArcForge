import { buildScopedEditInstruction, editScopeFromSelection } from "./editScope";
import { artifactPathsMatch } from "./events";
import type {
  ArtifactAdapter,
  ArtifactEditResult,
  ArtifactEditScope,
  ArtifactUnitPreview,
  SelectionContext,
} from "./types";

/** Resolve the current source at send time; never trust a previously opened popover's context. */
export async function prepareArtifactEdit(params: {
  scope: ArtifactEditScope;
  selection: SelectionContext;
  workdir: string;
  adapter: ArtifactAdapter | null;
  includeImage?: boolean;
}) {
  const { scope, selection, workdir, adapter } = params;
  if (!adapter?.selectionContext || adapter.type !== scope.artifact.artifactType) {
    throw new Error("This artifact does not support scoped editing.");
  }
  if (
    !["element", "unit", "artifact"].includes(scope.kind) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(scope.editId) ||
    !artifactPathsMatch(scope.artifact.workdir, workdir) ||
    !artifactPathsMatch(scope.artifact.workdir, selection.artifact.workdir) ||
    !artifactPathsMatch(scope.artifact.path, selection.artifact.path) ||
    scope.artifact.artifactType !== selection.artifact.artifactType
  ) {
    throw new Error("The edit scope no longer matches the selected artifact.");
  }
  const selectedScope = editScopeFromSelection(selection, scope.kind, scope.editId);
  if (selectedScope.unitId !== scope.unitId || selectedScope.elementId !== scope.elementId) {
    throw new Error("The edit scope no longer matches the selected page or element.");
  }
  const context = await adapter.selectionContext(scope.artifact, {
    unitId: scope.kind === "artifact" ? undefined : scope.unitId,
    elementId: scope.kind === "element" ? scope.elementId : undefined,
  });
  if (
    !context.manifestPath ||
    (scope.kind !== "artifact" && context.slide?.slideId !== scope.unitId) ||
    (scope.kind === "element" && context.element?.id !== scope.elementId)
  ) {
    throw new Error("The runtime returned context for a different edit target.");
  }
  const resolvedScope: ArtifactEditScope = {
    ...scope,
    artifact: { ...scope.artifact },
    manifestPath: context.manifestPath,
    templatePath: context.templatePath,
  };
  let preview: ArtifactUnitPreview | undefined;
  if (params.includeImage && context.slide) {
    try {
      const image = await adapter.previewUnit(
        scope.artifact,
        {
          id: context.slide.slideId,
          order: context.slide.index,
        },
        { width: 960 },
      );
      if (["image/png", "image/jpeg", "image/webp"].includes(image.mimeType)) preview = image;
    } catch {
      // The source context remains sufficient for text-only editing; preview failure is optional.
    }
  }
  return {
    scope: resolvedScope,
    selection: { ...selection, edit: resolvedScope },
    instruction: buildScopedEditInstruction(resolvedScope, context, selection),
    preview,
  };
}

/** A persisted user note keeps follow-up requests grounded after a UI-only undo. */
export function artifactUndoMessage(scope: ArtifactEditScope, result: ArtifactEditResult) {
  return [
    `The user reverted edit ${result.editId} in ${scope.artifact.path}, page ${result.unitId}${result.elementId ? `, element ${result.elementId}` : ""}.`,
    `Current content summary: ${result.afterText || "Restored the content from before this edit."}`,
    "This undo has already been applied. Use the current selection context or read the current source before making any further changes; do not reapply the reverted edit.",
  ].join("\n");
}
