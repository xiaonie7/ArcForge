import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ArchiveCandidate,
  ArchiveConversation,
  ArchiveDeleteResult,
  ArchiveFacets,
  ArchiveFilter,
  ArchiveMutation,
  ArchivePage,
  ArchiveQuery,
  ArchiveSnapshot,
  ArchiveState,
  AutoArchivePolicy,
} from "./types";

export function queryConversations(input: ArchiveQuery) {
  return invoke<ArchivePage>("chat_history_query", { input });
}

export function archiveConversation(input: ArchiveMutation) {
  return invoke<ArchiveConversation>("chat_history_archive", { input });
}

export function unarchiveConversation(input: ArchiveMutation) {
  return invoke<ArchiveConversation>("chat_history_unarchive", { input });
}

export function getArchiveFacets(archiveState: ArchiveState = "archived") {
  return invoke<ArchiveFacets>("chat_history_archive_facets", { archiveState });
}

// This backend snapshot covers the whole filtered result, not only the page
// currently rendered. Keep its IDs/versions unchanged until deletion finishes.
export function snapshotArchivedConversations(input: ArchiveFilter) {
  return invoke<ArchiveSnapshot>("chat_history_archive_snapshot", { input });
}

export function deleteArchivedConversations(candidates: readonly ArchiveCandidate[]) {
  return invoke<ArchiveDeleteResult>("chat_history_delete_archived", {
    input: { candidates },
  });
}

export function getAutoArchivePolicy() {
  return invoke<AutoArchivePolicy>("chat_history_archive_policy_get");
}

export function saveAutoArchivePolicy(input: AutoArchivePolicy) {
  return invoke<AutoArchivePolicy>("chat_history_archive_policy_set", { input });
}

export function subscribeArchiveChanges(onChange: () => void) {
  let disposed = false;
  const subscription = listen("chat-history:changed", () => { if (!disposed) onChange(); });
  return () => {
    disposed = true;
    void subscription.then((unlisten) => unlisten()).catch(() => undefined);
  };
}
