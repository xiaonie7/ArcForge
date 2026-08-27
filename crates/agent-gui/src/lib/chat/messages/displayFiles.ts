import type { DisplayFileItemDetails, DisplayFileResultDetails } from "../../tools/builtinTypes";
import type { ToolTraceItem } from "./uiMessages";

function isDisplayFileItemDetails(value: unknown): value is DisplayFileItemDetails {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<DisplayFileItemDetails>;
  return (
    typeof item.path === "string" &&
    typeof item.fileName === "string" &&
    typeof item.sizeBytes === "number" &&
    typeof item.mtimeMs === "number" &&
    typeof item.previewSupported === "boolean"
  );
}

export function getDisplayFilesFromToolTrace(item: ToolTraceItem): DisplayFileItemDetails[] | null {
  const result = item.toolResult;
  if (!result || result.isError || !result.details || typeof result.details !== "object") {
    return null;
  }
  const details = result.details as DisplayFileResultDetails;
  if (details.kind !== "display_file" || !Array.isArray(details.files)) {
    return null;
  }
  const files = details.files.filter(isDisplayFileItemDetails);
  return files.length > 0 ? files : null;
}

function normalizedDisplayPath(file: DisplayFileItemDetails): string {
  return (file.relativePath || file.path)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");
}

function artifactVersion(file: DisplayFileItemDetails): number {
  if (!file.artifact) return -1;
  const version = file.artifact.sourceVersion ?? file.artifact.currentVersion;
  return Number.isFinite(version) ? version : -1;
}

export function dedupeDisplayFilesByToolTrace(
  items: ToolTraceItem[],
): Map<ToolTraceItem, DisplayFileItemDetails[]> {
  const result = new Map<ToolTraceItem, DisplayFileItemDetails[]>();
  const winners = new Map<
    string,
    { item: ToolTraceItem; file: DisplayFileItemDetails; order: number }
  >();

  items.forEach((item, itemIndex) => {
    const files = getDisplayFilesFromToolTrace(item);
    if (!files) return;
    result.set(item, []);
    files.forEach((file, fileIndex) => {
      const path = normalizedDisplayPath(file);
      if (!path) return;
      const candidate = { item, file, order: itemIndex * 10_000 + fileIndex };
      const current = winners.get(path);
      const candidateHasArtifact = Boolean(file.artifact);
      const currentHasArtifact = Boolean(current?.file.artifact);
      if (
        !current ||
        (candidateHasArtifact && !currentHasArtifact) ||
        (candidateHasArtifact === currentHasArtifact &&
          (artifactVersion(file) > artifactVersion(current.file) ||
            (artifactVersion(file) === artifactVersion(current.file) &&
              candidate.order > current.order)))
      ) {
        winners.set(path, candidate);
      }
    });
  });

  for (const winner of winners.values()) {
    result.get(winner.item)?.push(winner.file);
  }
  return result;
}
