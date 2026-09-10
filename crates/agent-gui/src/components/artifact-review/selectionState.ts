import { artifactPathsMatch } from "../../lib/artifactReview/events";
import type {
  ArtifactElement,
  ArtifactElementsResult,
  ArtifactRef,
  ArtifactUnit,
  SelectionContext,
} from "../../lib/artifactReview/types";

export function sameReviewArtifact(a: ArtifactRef, b: ArtifactRef) {
  return (
    a.artifactType === b.artifactType &&
    artifactPathsMatch(a.workdir.replace(/[/\\]+$/, ""), b.workdir.replace(/[/\\]+$/, "")) &&
    artifactPathsMatch(a.path, b.path)
  );
}

export function selectedUnitId(context: SelectionContext | null) {
  if (!context) return null;
  return context.selection.type === "element"
    ? (context.selection.unitId ?? null)
    : context.selection.id;
}

export function unitSelection(
  artifact: ArtifactRef,
  unit: ArtifactUnit,
  total: number,
): SelectionContext {
  return {
    artifact,
    selection: { type: unit.type, id: unit.id, label: unit.label, order: unit.order, total },
  };
}

export function elementSelection(
  artifact: ArtifactRef,
  unit: ArtifactUnit,
  element: ArtifactElement,
  total: number,
): SelectionContext {
  return {
    artifact,
    selection: {
      type: "element",
      id: element.id,
      label: element.label,
      unitId: unit.id,
      unitLabel: unit.label,
      elementType: element.type,
      bbox: element.bbox,
      order: unit.order,
      total,
    },
  };
}

/** Stable ids are authoritative. Never guess a replacement from labels or positions. */
export function reconcileReviewSelection(
  context: SelectionContext | null,
  artifact: ArtifactRef,
  units: ArtifactUnit[],
  elements?: ArtifactElementsResult,
): { selection: SelectionContext | null; removed: "unit" | "element" | null } {
  if (!context || !sameReviewArtifact(context.artifact, artifact)) {
    return { selection: null, removed: null };
  }
  const unit = units.find((candidate) => candidate.id === selectedUnitId(context));
  if (!unit) return { selection: null, removed: "unit" };
  if (context.selection.type !== "element") {
    return { selection: unitSelection(artifact, unit, units.length), removed: null };
  }
  if (!elements || elements.unitId !== unit.id) {
    return {
      selection: {
        ...context,
        selection: {
          ...context.selection,
          unitLabel: unit.label,
          order: unit.order,
          total: units.length,
        },
      },
      removed: null,
    };
  }
  const element = elements.elements.find((candidate) => candidate.id === context.selection.id);
  if (!element) {
    return { selection: unitSelection(artifact, unit, units.length), removed: "element" };
  }
  return { selection: elementSelection(artifact, unit, element, units.length), removed: null };
}

/** The bitmap may be letterboxed in either direction; boxes must share its rendered bounds. */
export function containedImageRect(
  container: { width: number; height: number },
  image: { width: number; height: number },
) {
  const sizes = [container.width, container.height, image.width, image.height];
  if (sizes.some((size) => !Number.isFinite(size) || size <= 0)) return null;
  const scale = Math.min(container.width / image.width, container.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    left: (container.width - width) / 2,
    top: (container.height - height) / 2,
    width,
    height,
  };
}

/** Clamp partly off-canvas boxes and reject unusable geometry before creating hit targets. */
export function elementBoxPercent(
  bbox: ArtifactElement["bbox"],
  canvas: ArtifactElementsResult["canvas"],
) {
  if ([...bbox, ...canvas].some((value) => !Number.isFinite(value))) return null;
  const [x, y, width, height] = bbox;
  const [canvasWidth, canvasHeight] = canvas;
  if (canvasWidth <= 0 || canvasHeight <= 0 || width <= 0 || height <= 0) return null;
  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(canvasWidth, x + width);
  const bottom = Math.min(canvasHeight, y + height);
  if (right <= left || bottom <= top) return null;
  return {
    left: `${(left / canvasWidth) * 100}%`,
    top: `${(top / canvasHeight) * 100}%`,
    width: `${((right - left) / canvasWidth) * 100}%`,
    height: `${((bottom - top) / canvasHeight) * 100}%`,
  };
}
