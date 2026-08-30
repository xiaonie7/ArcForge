// Shared lifecycle contracts. History remains authoritative on the desktop;
// the Web build uses the same API through its Tauri IPC gateway shim.
export type ConversationLifecycle = {
  archivedAt?: number | null;
  archiveReason?: string | null;
  unarchivedAt?: number | null;
  lifecycleVersion?: number;
  lastUserMessageAt?: number | null;
  lastTurnFinishedAt?: number | null;
  activityVersion?: number;
  autoArchiveExempt?: boolean;
  originSourceId?: string | null;
};

export type ArchiveConversation = ConversationLifecycle & {
  id: string;
  title: string;
  providerId: string;
  model: string;
  sessionId?: string;
  cwd?: string;
  messageCount?: number;
  createdAt: number;
  updatedAt: number;
  isPinned?: boolean;
  pinnedAt?: number | null;
  isShared?: boolean;
  selectedModelJson?: string;
};

export type ArchiveState = "active" | "archived" | "all";
export type ArchiveFilter = {
  search?: string;
  sourceId?: string;
  cwd?: string;
  cwdEmpty?: boolean;
};
export type ArchiveQuery = ArchiveFilter & {
  page: number;
  pageSize: number;
  archiveState?: ArchiveState;
};
export type ArchivePage = { items: ArchiveConversation[]; totalCount: number };
export type ArchiveFacets = {
  sources: Array<{ id: string; count: number; displayName?: string }>;
  projects: Array<{ path: string; count: number }>;
};
export type ArchiveMutation = {
  id: string;
  operationId: string;
  expectedLifecycleVersion: number;
};
export type ArchiveCandidate = { id: string; lifecycleVersion: number };
export type ArchiveSnapshot = { candidates: ArchiveCandidate[]; totalCount: number };
export type ArchiveDeleteResult = {
  deletedIds: string[];
  skipped: Array<{ id: string; reason: string }>;
};

export type AutoArchivePolicy = {
  enabled: boolean;
  mode: "idle" | "daily";
  idleMinutes: number;
  dailyTime: string;
  timeZone: string;
  minimumIdleMinutes: number;
  sourceMode: "all" | "selected";
  sourceIds: string[];
  projectMode: "all" | "unassigned" | "selected";
  projectPaths: string[];
  revision: number;
  updatedAt: number;
};
