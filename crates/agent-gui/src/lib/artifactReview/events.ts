import type { ArtifactChange } from "./types";

type Listener = (change: ArtifactChange) => void;

const listeners = new Set<Listener>();

/** Runtime tools publish edits here; review views subscribe to refresh only changed units. */
export function subscribeArtifactChanges(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitArtifactChange(change: ArtifactChange) {
  for (const listener of Array.from(listeners)) {
    try {
      listener(change);
    } catch (error) {
      console.warn("artifact change listener failed", error);
    }
  }
}

export function normalizeArtifactPath(path: string) {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

export function artifactPathsMatch(a: string, b: string) {
  return normalizeArtifactPath(a).toLowerCase() === normalizeArtifactPath(b).toLowerCase();
}
