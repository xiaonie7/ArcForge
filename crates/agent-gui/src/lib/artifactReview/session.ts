import { isReviewThreadBinding, type ReviewThreadBinding, type SelectionContext } from "./types";

/**
 * Review threads are ordinary conversations. This map remembers which conversation reviews
 * which artifact so reopening the artifact returns to the same thread. Persisted per browser
 * profile; the binding is also stored inside the conversation meta for the transcript itself.
 */
const STORAGE_KEY = "arcforge.artifactReview.threads";

type StoredBinding = ReviewThreadBinding & { conversationId: string; updatedAt: number };

function bindingKey(workdir: string, artifactPath: string) {
  return `${workdir.trim().replace(/\\/g, "/").toLowerCase()}::${artifactPath
    .trim()
    .replace(/\\/g, "/")
    .toLowerCase()}`;
}

function readAll(): Record<string, StoredBinding> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, StoredBinding>) : {};
  } catch {
    return {};
  }
}

function writeAll(value: Record<string, StoredBinding>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage may be unavailable (private mode, quota); the meta inside the conversation still holds the binding.
  }
}

export function getReviewThreadBinding(workdir: string, artifactPath: string) {
  const entry = readAll()[bindingKey(workdir, artifactPath)];
  return isReviewThreadBinding(entry) &&
    typeof entry.conversationId === "string" &&
    entry.conversationId.trim()
    ? entry
    : null;
}

export function setReviewThreadBinding(binding: ReviewThreadBinding & { conversationId: string }) {
  const all = readAll();
  all[bindingKey(binding.workdir, binding.artifactPath)] = { ...binding, updatedAt: Date.now() };
  writeAll(all);
}

export function clearReviewThreadBinding(workdir: string, artifactPath: string) {
  const all = readAll();
  delete all[bindingKey(workdir, artifactPath)];
  writeAll(all);
}

/** Shared by the preview and Review composer; independent of the main chat draft. */
export function createReviewSessionStore() {
  let selection: SelectionContext | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => selection,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setSelection(next: SelectionContext | null) {
      if (selection === next) return;
      selection = next;
      listeners.forEach((listener) => listener());
    },
  };
}
