import { pptxAdapter } from "./adapters/pptx";
import type { ArtifactAdapter, ArtifactType } from "./types";

const ADAPTERS: readonly ArtifactAdapter[] = [pptxAdapter];

export function getArtifactAdapterForPath(path: string): ArtifactAdapter | null {
  return ADAPTERS.find((adapter) => adapter.matches(path)) ?? null;
}

export function getArtifactAdapter(type: ArtifactType): ArtifactAdapter | null {
  return ADAPTERS.find((adapter) => adapter.type === type) ?? null;
}

export function isReviewableArtifactPath(path: string) {
  return getArtifactAdapterForPath(path) !== null;
}

export * from "./editScope";
export * from "./events";
export * from "./inlineEdit";
export * from "./session";
export * from "./types";
