import { GeneratedFilesCard } from "../../../../components/chat/GeneratedFilesCard";
import { getDisplayFilesFromToolTrace } from "../../../../lib/chat/messages/displayFiles";
import type { ToolTraceItem } from "../../../../lib/chat/messages/uiMessages";

export function getNativeDisplayFilePayload(item: ToolTraceItem) {
  return getDisplayFilesFromToolTrace(item);
}

export function NativeDisplayFileBlock({
  files,
}: {
  files: NonNullable<ReturnType<typeof getNativeDisplayFilePayload>>;
}) {
  return <GeneratedFilesCard files={files} />;
}
