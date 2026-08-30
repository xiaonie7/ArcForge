import { invoke } from "@tauri-apps/api/core";

export type ConversationAdmissionInput = {
  conversationId: string;
  token: string;
  phase: "queued" | "running" | "cancelling" | "waiting_approval" | "waiting_input" | "editing";
  originSourceId?: string;
};

export function admitConversation(input: ConversationAdmissionInput): Promise<void> {
  return invoke("conversation_lifecycle_admit", { input });
}

export function releaseConversation(token: string, finished = false): Promise<void> {
  return invoke("conversation_lifecycle_release", { input: { token, finished } });
}

export const queueAdmissionToken = (itemId: string) => `queue:${itemId}`;

type AdmissionApi = {
  admit: typeof admitConversation;
  release: typeof releaseConversation;
  onReleaseError: (error: unknown) => void;
};

/** Transfer a queued admission in place; never leave an archiveable dequeue gap. */
export async function withConversationAdmission(
  input: { conversationId: string; token: string; originSourceId: string; queued: boolean },
  run: () => Promise<boolean>,
  api: AdmissionApi = {
    admit: admitConversation,
    release: releaseConversation,
    onReleaseError: (error) => console.error("Conversation admission settlement failed", error),
  },
): Promise<boolean> {
  await api.admit({ ...input, phase: "running" });
  let accepted = false;
  try {
    accepted = await run();
    return accepted;
  } finally {
    try {
      if (input.queued && !accepted) {
        // Failed validation/start keeps the original queue admission. The
        // caller may retry or explicitly release it when abandoning the item.
        await api.admit({ ...input, phase: "queued" });
      } else {
        await api.release(input.token, accepted);
      }
    } catch (error) {
      // Keep the durable gate closed on uncertain settlement, but never replay
      // an already executed turn solely because an IPC acknowledgement failed.
      api.onReleaseError(error);
    }
  }
}

const editingRuntimeId = globalThis.crypto.randomUUID();
const editingWrites = new Map<string, Promise<void>>();
const activeEditingConversations = new Set<string>();
const EDITING_HEARTBEAT_MS = 30_000;
let editingHeartbeat: ReturnType<typeof globalThis.setInterval> | undefined;

function queueEditingWrite(id: string, editing: boolean) {
  const token = `editing:${editingRuntimeId}:${id}`;
  const previous = editingWrites.get(id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() =>
    invoke<void>("conversation_lifecycle_editing", { input: { conversationId: id, token, editing } }),
  );
  editingWrites.set(id, next);
  void next.finally(() => {
    if (editingWrites.get(id) === next) editingWrites.delete(id);
  }).catch(() => {});
  return next;
}

function refreshEditingHeartbeat() {
  if (activeEditingConversations.size > 0 && editingHeartbeat === undefined) {
    editingHeartbeat = globalThis.setInterval(() => {
      for (const id of activeEditingConversations) {
        if (!activeEditingConversations.has(id)) continue;
        void queueEditingWrite(id, true).catch((error) => {
          console.warn("Conversation editing lease refresh failed", error);
        });
      }
    }, EDITING_HEARTBEAT_MS);
  } else if (activeEditingConversations.size === 0 && editingHeartbeat !== undefined) {
    globalThis.clearInterval(editingHeartbeat);
    editingHeartbeat = undefined;
  }
}

/** Serialize draft transitions so a slow acquire cannot outlive a later clear. */
export function setConversationEditing(conversationId: string, editing: boolean) {
  const id = conversationId.trim();
  if (!id) return Promise.resolve();
  if (editing) activeEditingConversations.add(id);
  else activeEditingConversations.delete(id);
  refreshEditingHeartbeat();
  return queueEditingWrite(id, editing);
}
