/**
 * Artifact Review Framework — shared model.
 *
 * An artifact is a reviewable file (deck, document, sheet, page, source file, image). Every
 * artifact type exposes its own *units* through an adapter (slides, pages, sections, ranges,
 * symbols, regions) and, optionally, *elements* inside a unit (title, chart, image…). The
 * frontend keeps one {@link SelectionContext}; the chat turn carries it to the runtime and the
 * Skill decides how to edit. Nothing in this module knows how to edit.
 */

export type ArtifactType =
  | "pptx"
  | "pdf"
  | "docx"
  | "markdown"
  | "xlsx"
  | "html"
  | "code"
  | "image";

export type ArtifactRef = {
  /** document_artifacts id when the file was produced by ArcForge; absent for plain files. */
  artifactId?: string;
  artifactType: ArtifactType;
  workdir: string;
  /** Workspace-relative path with forward slashes. */
  path: string;
};

/** One selectable unit inside an artifact. `type` is adapter-defined (slide, page, section…). */
export type ArtifactUnit = {
  id: string;
  type: string;
  label: string;
  /** 1-based position in the adapter's navigation order. */
  order: number;
  parentId?: string;
};

/** Semantic block types every adapter maps its elements onto. */
export type ArtifactElementType =
  | "title"
  | "subtitle"
  | "text_block"
  | "image"
  | "chart"
  | "table"
  | "footer";

export const ARTIFACT_ELEMENT_TYPES: readonly ArtifactElementType[] = [
  "title",
  "subtitle",
  "text_block",
  "image",
  "chart",
  "table",
  "footer",
];

/** A semantic block inside a unit, with its box in the adapter's canvas coordinates. */
export type ArtifactElement = {
  id: string;
  type: ArtifactElementType;
  label: string;
  /** x, y, width, height */
  bbox: [number, number, number, number];
};

export type ArtifactSelection = {
  /** `slide`, `page`, `section`… for whole units; `element` for a block inside a unit. */
  type: string;
  id: string;
  label: string;
  order?: number;
  total?: number;
  /** Set for element selections: the unit that contains the element. */
  unitId?: string;
  unitLabel?: string;
  elementType?: ArtifactElementType;
  bbox?: [number, number, number, number];
};

export type SelectionContext = {
  artifact: ArtifactRef;
  selection: ArtifactSelection;
};

/** Emitted by runtimes/tools after an edit so views refresh only what changed. */
export type ArtifactChange = {
  workdir: string;
  path: string;
  artifactType: ArtifactType;
  /** `"all"` when the producer cannot tell which units changed. */
  changedUnits: { type: string; id: string }[] | "all";
  removedUnits?: { type: string; id: string }[];
};

export type ArtifactUnitPreview = {
  mimeType: string;
  /** base64 payload */
  data: string;
  sizeBytes: number;
};

export type ArtifactElementsResult = {
  unitId: string;
  /** width, height of the coordinate space the element boxes use */
  canvas: [number, number];
  elements: ArtifactElement[];
};

export type ArtifactAdapter = {
  type: ArtifactType;
  matches: (path: string) => boolean;
  listUnits: (artifact: ArtifactRef) => Promise<ArtifactUnit[]>;
  previewUnit: (
    artifact: ArtifactRef,
    unit: Pick<ArtifactUnit, "id" | "order">,
    options?: { width?: number },
  ) => Promise<ArtifactUnitPreview>;
  /** Semantic blocks of one unit; adapters without block support leave this undefined. */
  listElements?: (
    artifact: ArtifactRef,
    unit: Pick<ArtifactUnit, "id" | "order">,
  ) => Promise<ArtifactElementsResult>;
};

/** Binding between a review thread (a normal conversation) and the artifact it reviews. */
export type ReviewThreadBinding = {
  artifactPath: string;
  workdir: string;
  parentConversationId?: string;
};

export const SELECTION_FIELD = "arcForgeSelection";

export function artifactBasename(path: string) {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

export function isElementSelection(context: SelectionContext) {
  return context.selection.type === "element" && typeof context.selection.unitId === "string";
}

export function selectionTitle(context: SelectionContext) {
  const { selection } = context;
  const file = artifactBasename(context.artifact.path);
  if (selection.type === "artifact") {
    return file;
  } else if (isElementSelection(context)) {
    return `${file} › ${selection.unitLabel ?? selection.unitId} › ${selection.elementType ?? "element"} ${selection.id}`;
  }
  return `${file} › ${selection.label}`;
}

/** Text appended to the user message so the model knows the review scope. */
export function buildSelectionInstruction(context: SelectionContext) {
  const { artifact, selection } = context;
  const lines = [
    "Artifact review selection: the user is looking at this unit and the request refers to it.",
    `- artifact: ${artifact.path} (${artifact.artifactType})`,
  ];
  if (selection.type === "artifact") {
    lines.push(
      "The request refers to this artifact. Preserve unrelated pages and elements, and report which unit ids changed.",
    );
  } else if (isElementSelection(context)) {
    lines.push(`- unit: slide ${selection.unitId}`);
    lines.push(
      `- element: ${selection.elementType ?? "element"} ${selection.id}${selection.label && selection.label !== selection.id ? ` ("${selection.label}")` : ""}`,
    );
    lines.push(
      "Change only this element (the SVG node with that id and its children) inside that page unless the message clearly asks for more; keep the element id, then re-run create and report which unit ids changed.",
    );
  } else {
    const position =
      typeof selection.order === "number" && typeof selection.total === "number"
        ? ` (${selection.type} ${selection.order} of ${selection.total})`
        : "";
    lines.push(`- unit: ${selection.type} ${selection.id}${position}`);
    lines.push(
      "Change only this unit unless the message clearly asks for more. Use the exact unit id when editing (for a deck: edit that page's SVG and re-run create), and report which unit ids changed.",
    );
  }
  return lines.join("\n");
}

export function isSelectionContext(value: unknown): value is SelectionContext {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const artifact = record.artifact as Record<string, unknown> | undefined;
  const selection = record.selection as Record<string, unknown> | undefined;
  return (
    !!artifact &&
    typeof artifact.path === "string" &&
    typeof artifact.artifactType === "string" &&
    typeof artifact.workdir === "string" &&
    !!selection &&
    typeof selection.type === "string" &&
    typeof selection.id === "string" &&
    typeof selection.label === "string" &&
    (selection.type !== "element" ||
      (typeof selection.unitId === "string" &&
        selection.unitId.length > 0 &&
        typeof selection.elementType === "string" &&
        (ARTIFACT_ELEMENT_TYPES as readonly string[]).includes(selection.elementType)))
  );
}

export function isReviewThreadBinding(value: unknown): value is ReviewThreadBinding {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.artifactPath === "string" && typeof record.workdir === "string";
}

export function selectionsEqual(a: SelectionContext | null, b: SelectionContext | null) {
  if (!a || !b) return a === b;
  return (
    a.artifact.path === b.artifact.path &&
    a.artifact.workdir === b.artifact.workdir &&
    a.selection.type === b.selection.type &&
    a.selection.id === b.selection.id &&
    (a.selection.unitId ?? "") === (b.selection.unitId ?? "")
  );
}
