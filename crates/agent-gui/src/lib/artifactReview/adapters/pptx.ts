import { invoke } from "@tauri-apps/api/core";

import { parseArtifactEditResult } from "../editScope";
import { emitArtifactChange } from "../events";
import {
  ARTIFACT_ELEMENT_TYPES,
  type ArtifactAdapter,
  type ArtifactEditRecord,
  type ArtifactEditResult,
  type ArtifactElementsResult,
  type ArtifactElementType,
  type ArtifactRef,
  type ArtifactUnit,
  type ArtifactUnitPreview,
  type ReplacementKind,
  type ScopedEditContext,
} from "../types";

type PresentationUnitsResponse = {
  path: string;
  slideCount: number;
  units: { index: number; id: string; name: string; title: string }[];
};

type PresentationElementsResponse = {
  path: string;
  page: number;
  slideId: string;
  canvas: [number, number];
  elements: {
    id: string;
    elementType: string;
    label: string;
    bbox: [number, number, number, number];
    kind: string;
  }[];
};

type PresentationPreviewPageResponse = {
  path: string;
  slideCount: number;
  page: number;
  mimeType: string;
  data: string;
  sizeBytes: number;
  cached: boolean;
};

type PresentationSelectionContextResponse = {
  path: string;
  manifestPath: string;
  manifestDir: string;
  templatePath?: string | null;
  svgPath?: string | null;
  context: Record<string, unknown>;
};

type PresentationEditHistoryResponse = {
  path: string;
  manifestPath: string;
  edits: {
    editId: string;
    slideId: string;
    elementId?: string | null;
    scope: string;
    kind: string;
    target: string;
    createdAt: string;
    reverted: boolean;
    revertedAt?: string | null;
    beforeText: string;
    afterText: string;
  }[];
};

type OfficeRuntimeExecuteResponse = {
  success: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
};

const PRESENTATION_EXTENSIONS = /\.(pptx|pptm|potx)$/i;
const REPLACEMENT_KINDS: readonly ReplacementKind[] = [
  "svg_element",
  "svg_page",
  "template_text",
  "template_table",
  "template_page",
  "deck",
];

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeSelectionContext(
  response: PresentationSelectionContextResponse,
): ScopedEditContext {
  const raw = response.context ?? {};
  const kind = raw.replacement_kind;
  const replacementKind = (REPLACEMENT_KINDS as readonly string[]).includes(String(kind))
    ? (kind as ReplacementKind)
    : "deck";
  const slide = raw.slide as Record<string, unknown> | undefined;
  const element = raw.element as Record<string, unknown> | undefined;
  const page = raw.page as Record<string, unknown> | undefined;
  return {
    manifestPath: response.manifestPath,
    templatePath: optionalString(response.templatePath),
    mode: optionalString(raw.mode),
    stage: optionalString(raw.stage),
    slideCount: optionalNumber(raw.slide_count),
    slideIds: Array.isArray(raw.slide_ids)
      ? raw.slide_ids.filter((id): id is string => typeof id === "string")
      : undefined,
    replacementKind,
    slide: slide
      ? {
          slideId: String(slide.slide_id ?? ""),
          index: optionalNumber(slide.index) ?? 0,
          svgPath: optionalString(response.svgPath),
          sourceSlide: optionalNumber(slide.source_slide),
          textEdits: Array.isArray(slide.text_edits) ? slide.text_edits : undefined,
          tableEdits: Array.isArray(slide.table_edits) ? slide.table_edits : undefined,
          notes: optionalString(slide.notes),
        }
      : undefined,
    element: element
      ? {
          id: String(element.id ?? ""),
          role: optionalString(element.role),
          snippet: typeof element.snippet === "string" ? element.snippet : undefined,
          truncated: element.truncated === true,
          text: optionalString(element.text),
          sizeBytes: optionalNumber(element.size_bytes),
          shapeId: optionalNumber(element.shape_id),
          shapePath: Array.isArray(element.shape_path)
            ? element.shape_path.filter((part): part is number => typeof part === "number")
            : undefined,
          name: optionalString(element.name),
          templateValue: element.template_value,
          currentEdit: element.current_edit,
        }
      : undefined,
    page: page
      ? {
          snippet: typeof page.snippet === "string" ? page.snippet : "",
          truncated: page.truncated === true,
          sizeBytes: optionalNumber(page.size_bytes) ?? 0,
        }
      : undefined,
  };
}

function createRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `review-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export const pptxAdapter: ArtifactAdapter = {
  type: "pptx",
  matches: (path) => PRESENTATION_EXTENSIONS.test(path.trim()),
  async listUnits(artifact: ArtifactRef): Promise<ArtifactUnit[]> {
    const response = await invoke<PresentationUnitsResponse>("presentation_units", {
      workdir: artifact.workdir,
      path: artifact.path,
    });
    return response.units.map((unit) => ({
      id: unit.id,
      type: "slide",
      label: unit.title ? `${unit.index} · ${unit.title}` : `${unit.index}`,
      order: unit.index,
    }));
  },
  async previewUnit(artifact, unit, options): Promise<ArtifactUnitPreview> {
    const response = await invoke<PresentationPreviewPageResponse>("presentation_preview_page", {
      workdir: artifact.workdir,
      path: artifact.path,
      page: unit.order,
      width: options?.width,
    });
    return { mimeType: response.mimeType, data: response.data, sizeBytes: response.sizeBytes };
  },
  async listElements(artifact, unit): Promise<ArtifactElementsResult> {
    const response = await invoke<PresentationElementsResponse>("presentation_elements", {
      workdir: artifact.workdir,
      path: artifact.path,
      page: unit.order,
    });
    return {
      unitId: response.slideId,
      canvas: response.canvas,
      elements: response.elements
        .filter((element) =>
          (ARTIFACT_ELEMENT_TYPES as readonly string[]).includes(element.elementType),
        )
        .map((element) => ({
          id: element.id,
          type: element.elementType as ArtifactElementType,
          label: element.label,
          bbox: element.bbox,
        })),
    };
  },
  async selectionContext(artifact, target): Promise<ScopedEditContext> {
    const response = await invoke<PresentationSelectionContextResponse>(
      "presentation_selection_context",
      {
        workdir: artifact.workdir,
        path: artifact.path,
        unitId: target.unitId,
        elementId: target.elementId,
      },
    );
    return normalizeSelectionContext(response);
  },
  async editHistory(artifact): Promise<ArtifactEditRecord[]> {
    const response = await invoke<PresentationEditHistoryResponse>("presentation_edit_history", {
      workdir: artifact.workdir,
      path: artifact.path,
    });
    return response.edits.map((edit) => ({
      editId: edit.editId,
      unitId: edit.slideId,
      elementId: optionalString(edit.elementId),
      scope: edit.scope === "element" ? "element" : "unit",
      kind: edit.kind,
      target: edit.target,
      createdAt: edit.createdAt,
      reverted: edit.reverted,
      revertedAt: optionalString(edit.revertedAt),
      beforeText: edit.beforeText,
      afterText: edit.afterText,
    }));
  },
  async revertEdit(artifact, request): Promise<ArtifactEditResult> {
    const response = await invoke<OfficeRuntimeExecuteResponse>("office_runtime_execute", {
      input: {
        requestId: createRequestId(),
        workdir: artifact.workdir,
        documentType: "presentation",
        action: "patch",
        specPath: request.manifestPath,
        inputPath: request.templatePath,
        outputPath: artifact.path,
        edit: { revert: request.editId },
      },
    });
    if (!response.success) {
      const detail = (response.stderr || response.stdout).trim().replace(/^error:\s*/i, "");
      throw new Error(
        response.timedOut
          ? "Reverting the edit timed out."
          : response.cancelled
            ? "Reverting the edit was cancelled."
            : detail || "The runtime could not revert the edit.",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.stdout);
    } catch {
      parsed = undefined;
    }
    const result = parseArtifactEditResult(parsed);
    if (!result) throw new Error("The runtime returned an unexpected revert report.");
    emitArtifactChange({
      workdir: artifact.workdir,
      path: artifact.path,
      artifactType: "pptx",
      changedUnits: result.sharedInputsChanged
        ? "all"
        : result.changedUnitIds.map((id) => ({ type: "slide", id })),
      edit: result,
    });
    return result;
  },
};
