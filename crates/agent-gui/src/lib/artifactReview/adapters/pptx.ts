import { invoke } from "@tauri-apps/api/core";

import {
  ARTIFACT_ELEMENT_TYPES,
  type ArtifactAdapter,
  type ArtifactElementsResult,
  type ArtifactElementType,
  type ArtifactRef,
  type ArtifactUnit,
  type ArtifactUnitPreview,
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

const PRESENTATION_EXTENSIONS = /\.(pptx|pptm|potx)$/i;

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
};
