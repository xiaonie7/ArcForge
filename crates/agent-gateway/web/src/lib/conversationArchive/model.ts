import { workspaceProjectPathKey } from "../settings";
import type { ArchiveCandidate, ArchiveConversation, ArchiveFilter, AutoArchivePolicy } from "./types";

export const MAX_ARCHIVE_IDLE_MINUTES = 525_600;

export function isConversationArchived(conversation: { archivedAt?: number | null }) {
  return typeof conversation.archivedAt === "number" && conversation.archivedAt > 0;
}

export function archiveFilterFromControls(search: string, sourceId: string, project: string): ArchiveFilter {
  return {
    search: search.trim() || undefined,
    sourceId: sourceId || undefined,
    cwd: project.startsWith("path:") ? project.slice(5) : undefined,
    cwdEmpty: project === "unassigned" ? true : undefined,
  };
}

export function hasArchiveFilter(filter: ArchiveFilter) {
  return Boolean(filter.search || filter.sourceId || filter.cwd || filter.cwdEmpty);
}

export function freezeArchiveCandidates(candidates: readonly ArchiveCandidate[]): ArchiveCandidate[] {
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const id = candidate.id.trim();
    if (!id || seen.has(id) || !Number.isSafeInteger(candidate.lifecycleVersion) || candidate.lifecycleVersion < 0) {
      return [];
    }
    seen.add(id);
    return [{ id, lifecycleVersion: candidate.lifecycleVersion }];
  });
}

export function groupArchivedConversations(conversations: readonly ArchiveConversation[]) {
  const groups = new Map<string, { key: string; path: string; items: ArchiveConversation[] }>();
  for (const conversation of conversations) {
    const path = conversation.cwd?.trim() ?? "";
    const key = workspaceProjectPathKey(path);
    const group = groups.get(key) ?? { key, path, items: [] };
    group.items.push(conversation);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function archiveProjectLabel(path: string) {
  const normalized = path.trim().replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || path;
}

// Keys are translated by the view. The server repeats all validation and is
// the authority on timezone support and compare-and-swap revisions.
export function validateAutoArchivePolicy(policy: AutoArchivePolicy): string | null {
  const validMinutes = (value: number) => Number.isInteger(value) && value > 0 && value <= MAX_ARCHIVE_IDLE_MINUTES;
  if (!validMinutes(policy.idleMinutes) || !validMinutes(policy.minimumIdleMinutes)) {
    return "archive.policy.invalidDuration";
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(policy.dailyTime)) return "archive.policy.invalidTime";
  try {
    if (!policy.timeZone.trim()) return "archive.policy.invalidTimeZone";
    new Intl.DateTimeFormat("en", { timeZone: policy.timeZone.trim() }).format(0);
  } catch {
    return "archive.policy.invalidTimeZone";
  }
  if (policy.enabled && policy.sourceMode === "selected" && policy.sourceIds.length === 0) {
    return "archive.policy.selectSource";
  }
  if (policy.enabled && policy.projectMode === "selected" && policy.projectPaths.length === 0) {
    return "archive.policy.selectProject";
  }
  return null;
}
