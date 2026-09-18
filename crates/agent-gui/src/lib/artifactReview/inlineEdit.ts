import type { Message } from "@earendil-works/pi-ai";

import { getUserMessageDisplayText, getUserMessageSelection } from "../chat/messages/uploadedFiles";
import { parseArtifactEditResult, parseScopeTooNarrow } from "./editScope";
import type { ArtifactEditResult, ArtifactEditScope } from "./types";

/** How one scoped edit turn ended, derived from the review thread's messages. */
export type ScopedEditOutcome =
  | { status: "applied"; edits: ArtifactEditResult[]; summary: string }
  | { status: "needs_scope"; reason: string; suggestedKind: "unit" | "artifact"; summary: string }
  | { status: "failed"; message: string; summary: string };

export type ScopedEditTurn = {
  editId: string;
  scope: ArtifactEditScope;
  instruction: string;
  timestamp: number;
  /** Null while the turn is still running (no assistant reply yet). */
  outcome: ScopedEditOutcome | null;
  details: string;
};

const OFFICE_RUNTIME_TOOL = "OfficeRuntime";

function messageText(message: Message): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const item = block as { type?: string; text?: string };
      return item.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .join("");
}

function toolResultPayload(message: Message): unknown {
  const details = (message as { details?: unknown }).details;
  if (details && typeof details === "object") {
    const parsed = (details as { parsedOutput?: unknown }).parsedOutput;
    if (parsed !== undefined) return parsed;
  }
  const text = messageText(message).trim();
  if (!text.startsWith("{")) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function userEditScope(message: Message): ArtifactEditScope | null {
  if (message.role !== "user") return null;
  const selection = getUserMessageSelection(message as Message & Record<string, unknown>);
  return selection?.edit ?? null;
}

/** Summarize the assistant activity after one user message until the next user message. */
function outcomeAfter(messages: Message[], userIndex: number): ScopedEditOutcome | null {
  const edits: ArtifactEditResult[] = [];
  let lastToolError = "";
  let lastAssistantText = "";
  let sawAssistant = false;
  let rebuiltDeck = false;
  for (let index = userIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "user") break;
    if (message.role === "assistant") {
      sawAssistant = true;
      const text = messageText(message).trim();
      if (text) lastAssistantText = text;
      continue;
    }
    if (message.role !== "toolResult") continue;
    const result = message as Message & { toolName?: string; isError?: boolean };
    if (result.toolName !== OFFICE_RUNTIME_TOOL) continue;
    if (result.isError) {
      lastToolError = messageText(message).trim();
      continue;
    }
    const payload = toolResultPayload(message);
    const edit = parseArtifactEditResult(payload);
    if (edit) {
      const previous = edits.findIndex((item) => item.editId === edit.editId);
      if (previous >= 0) edits[previous] = edit;
      else edits.push(edit);
    }
    if (
      userEditScope(messages[userIndex])?.kind === "artifact" &&
      (payload as { action?: string } | undefined)?.action === "created"
    )
      rebuiltDeck = true;
  }
  if (edits.length > 0 || rebuiltDeck)
    return { status: "applied", edits, summary: lastAssistantText };
  if (!sawAssistant && !lastToolError) return null;
  const narrow = parseScopeTooNarrow(lastAssistantText);
  if (narrow) return { status: "needs_scope", ...narrow, summary: lastAssistantText };
  return {
    status: "failed",
    message: lastAssistantText || lastToolError || "",
    summary: lastAssistantText,
  };
}

/** The outcome of the turn started by the user message carrying `editId`. */
export function summarizeScopedEditTurn(
  messages: Message[],
  editId: string,
): ScopedEditOutcome | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (userEditScope(messages[index])?.editId === editId) {
      return outcomeAfter(messages, index);
    }
  }
  return null;
}

/** Every scoped edit turn in a thread, newest first, for the edit history drawer. */
export function collectScopedEditTurns(messages: Message[]): ScopedEditTurn[] {
  const turns: ScopedEditTurn[] = [];
  messages.forEach((message, index) => {
    const scope = userEditScope(message);
    if (!scope) return;
    turns.push({
      editId: scope.editId,
      scope,
      instruction: getUserMessageDisplayText(message as Message & Record<string, unknown>),
      timestamp: typeof message.timestamp === "number" ? message.timestamp : 0,
      outcome: outcomeAfter(messages, index),
      details: messages
        .slice(
          index + 1,
          messages.findIndex((next, i) => i > index && next.role === "user") === -1
            ? undefined
            : messages.findIndex((next, i) => i > index && next.role === "user"),
        )
        .map(
          (next) =>
            `${next.role}${"toolName" in next ? ` (${next.toolName})` : ""}:\n${messageText(next)}`,
        )
        .join("\n\n"),
    });
  });
  return turns.reverse();
}
