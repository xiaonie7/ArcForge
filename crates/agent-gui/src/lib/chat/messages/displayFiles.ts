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
