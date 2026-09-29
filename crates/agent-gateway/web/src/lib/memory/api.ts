// Thin, fully-typed invoke bindings over the Rust MemoryStore commands.
// On the gateway web build the same file works unchanged: the Tauri `invoke`
// shim intercepts every `memory_*` command and forwards it over the websocket
// to the connected desktop agent.

import { invoke } from "@tauri-apps/api/core";
import type {
  ApplyDecision,
  MemoryConfidence,
  MemoryEvidenceFields,
  MemoryScope,
  MemoryScopeFilter,
  MemorySearchType,
  MemoryType,
  MemoryUpdateMode,
  OrganizerMode,
  OrganizerScope,
} from "./schema";

/** Routing hint only. Rust resolves the persisted, trusted conversation binding. */
export type MemoryAccessContext = Readonly<{ conversationId: string }>;

export type MemorySpaceInfo = {
  spaceId: string;
  conversationId: string;
  label: string;
  workdir?: string;
};

/** Snapshot once per run; a resumed WeCom conversation stays scoped without a live principal. */
export function resolveMemoryAccessContext(
  conversationId?: string,
  principal?: { channel: string } | null,
  context?: MemoryAccessContext,
): MemoryAccessContext | undefined {
  const id = (context?.conversationId ?? conversationId ?? "").trim();
  if (!context && principal?.channel !== "wecom" && !id.startsWith("wecom:")) return undefined;
  if (!id) throw new Error("Channel memory requires a conversation binding.");
  return Object.freeze({ conversationId: id });
}

function invokeMemory<T>(
  command: string,
  args?: Record<string, unknown>,
  context?: MemoryAccessContext,
): Promise<T> {
  // Audit-bearing mutation payloads also identify resumed channel conversations.
  // Do not let a caller that omitted context write those into the local library.
  const payload = args?.args as { conversationId?: unknown } | undefined;
  const resolved = context ?? (
    typeof payload?.conversationId === "string"
      ? resolveMemoryAccessContext(payload.conversationId)
      : undefined
  );
  if (resolved) {
    const conversationId = resolved.conversationId.trim();
    if (!conversationId) return Promise.reject(new Error("Channel memory requires a conversation binding."));
    return invoke<T>("memory_scoped", {
      context: { conversationId },
      command,
      args: args ?? {},
    });
  }
  return invoke<T>(command, args);
}

export async function memorySpacesList() {
  return invoke<MemorySpaceInfo[]>("memory_spaces_list");
}

export type MemoryHistoryTimeMode = "message" | "updated" | "conversation";

export type MemoryMeta = {
  slug: string;
  scope: MemoryScope;
  workdirHash: string;
  workdirPath?: string | null;
  memoryType: MemorySearchType;
  description: string;
  headline: string;
  dateLocal?: string | null;
  createdAt: number;
  updatedAt: number;
  appendCount: number;
  archived: boolean;
  unreviewed: boolean;
  confidence: MemoryConfidence;
  fileSize: number;
};

export type MemoryScopeQuota = {
  scope: MemoryScope;
  workdirHash: string;
  used: number;
  limit: number;
};

export type MemoryListResponse = {
  entries: MemoryMeta[];
  truncated: boolean;
  quota: {
    used: number;
    limit: number;
    scopeQuotas?: MemoryScopeQuota[];
  };
};

export type MemoryReadResponse = {
  slug: string;
  scope: MemoryScope;
  memoryType: MemorySearchType;
  description: string;
  headline: string;
  body: string;
  totalLines: number;
  window: {
    offset: number;
    length: number;
    truncated: boolean;
  };
  meta: {
    unreviewed: boolean;
    confidence: MemoryConfidence;
    source: unknown;
    createdAt: number;
    updatedAt: number;
    archived: boolean;
  };
};

export type MemorySearchMatch = {
  slug: string;
  scope: MemoryScope;
  memoryType: MemorySearchType;
  description: string;
  headline: string;
  snippet: string;
  score: number;
  rawScore?: number | null;
  ageDays?: number | null;
  unreviewed: boolean;
  confidence: MemoryConfidence;
};

export type MemoryHistorySearchMatch = {
  source: "message" | "segment" | string;
  conversationId: string;
  title: string;
  cwd?: string | null;
  segmentIndex: number;
  segmentId: string;
  messageIndex?: number | null;
  messageId?: string | null;
  role?: string | null;
  snippet: string;
  score: number;
  rawScore?: number | null;
  updatedAt: number;
};

export type MemorySearchResponse = {
  matches: MemorySearchMatch[];
  historyMatches: MemoryHistorySearchMatch[];
  usedFallback: boolean;
};

export type MemoryMutationResponse = {
  slug: string;
  scope: MemoryScope;
  created: boolean;
  updated: boolean;
  deleted: boolean;
  indexUpdated: boolean;
  warning?: string | null;
  /** Confidence actually stored after the Rust-side contract ran. */
  appliedConfidence?: MemoryConfidence | null;
  autoDowngraded?: boolean | null;
};

export type MemoryDeleteProjectResponse = {
  workdirHash: string;
  deletedCount: number;
  quarantinePath?: string | null;
};

export type MemoryOverviewEntry = {
  slug: string;
  scope: MemoryScope;
  memoryType: MemorySearchType;
  description: string;
  headline: string;
  dateLocal?: string | null;
  updatedAt: number;
  unreviewed: boolean;
  confidence: MemoryConfidence;
};

export type MemoryOverviewResponse = {
  user: MemoryOverviewEntry[];
  project: MemoryOverviewEntry[];
  global: MemoryOverviewEntry[];
  recentDays: MemoryOverviewEntry[];
  root: string;
  workdirHash?: string | null;
};

export type MemoryPathsInfo = {
  root: string;
  isFresh: boolean;
  isInCloud: boolean;
  cloudProvider?: string | null;
};

export type MemoryRejectionEntry = {
  slug: string;
  scope: string;
  workdirHash: string;
  rejectedAt: number;
  actor: string;
  reason?: string | null;
};

export type MemoryRecentRejectionsResponse = {
  entries: MemoryRejectionEntry[];
};

export type MemoryQuotaScopeSummary = {
  scope: MemoryScope;
  workdirHash: string;
  used: number;
  limit: number;
  headroom: number;
  archivedCount: number;
  unreviewedCount: number;
  oldestUnreviewedAgeDays?: number | null;
};

export type MemoryQuotaSummaryResponse = {
  scopes: MemoryQuotaScopeSummary[];
};

export type MemoryBatchResponse = {
  created: string[];
  updated: string[];
  deleted: string[];
  warnings: string[];
  warningDetails?: MemoryBatchWarning[];
};

export type MemoryBatchWarning = {
  code: string;
  message: string;
  slug?: string | null;
  op?: string | null;
  groupId?: string | null;
  decisionIndex?: number | null;
  details?: unknown;
};

export type MemoryOrganizeRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export type MemoryOrganizeTrigger = "manual" | "scheduled";

export type MemoryOrganizeRun = {
  runId: string;
  trigger: MemoryOrganizeTrigger;
  status: MemoryOrganizeRunStatus;
  createdAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  dueAt?: number | null;
  claimedAt?: number | null;
  model: unknown;
  scope: string;
  mode: string;
  inputCount: number;
  clusterCount: number;
  safeApplied: number;
  reviewSkipped: number;
  createdCount: number;
  updatedCount: number;
  deletedCount: number;
  mergedCount: number;
  parseFailures: number;
  error?: string | null;
  finalSummary?: string | null;
  phase?: string | null;
  finalCount: number;
  compressionRatio?: number | null;
  compressionTarget?: number | null;
  dryRun: boolean;
  tokenUsageTotal: number;
  quotaHeadroomAtStart?: number | null;
  overrideReviewed: boolean;
  /** Typed run report; parse only via organizer/runRecord.ts. */
  report: unknown;
};

export type MemoryOrganizeRunCreateResponse = {
  run?: MemoryOrganizeRun | null;
  accepted: boolean;
  alreadyRunning: boolean;
  activeRun?: MemoryOrganizeRun | null;
};

export type MemoryOrganizeDueClaimResponse = {
  run?: MemoryOrganizeRun | null;
  skippedReason?: string | null;
};

export type MemoryOrganizeRunListResponse = {
  runs: MemoryOrganizeRun[];
};

export type MemoryOrganizeRunClearHistoryResponse = {
  deletedCount: number;
  retainedActiveCount: number;
};

export type MemoryErrorPayload = {
  error: string;
  message: string;
  suggested_next_call?: unknown;
  candidates?: unknown[];
};

export function parseMemoryError(error: unknown): MemoryErrorPayload | null {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
      return parsed as MemoryErrorPayload;
    }
  } catch {
    // Tauri may wrap the string; fall through to null.
  }
  return null;
}

export function formatMemoryError(error: unknown) {
  const parsed = parseMemoryError(error);
  if (parsed) {
    const extras = [
      parsed.suggested_next_call
        ? `suggested_next_call=${JSON.stringify(parsed.suggested_next_call)}`
        : "",
      parsed.candidates ? `candidates=${JSON.stringify(parsed.candidates)}` : "",
    ].filter(Boolean);
    return [parsed.message, ...extras].join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}

export async function memoryList(args: {
  scope?: MemoryScopeFilter;
  workdir?: string;
  includeAllProjects?: boolean;
  memoryType?: MemorySearchType;
  includeDaily?: boolean;
  limit?: number;
  offset?: number;
}, context?: MemoryAccessContext) {
  return invokeMemory<MemoryListResponse>("memory_list", { args }, context);
}

export async function memoryRead(args: {
  slug: string;
  scope?: MemoryScopeFilter;
  workdir?: string;
  workdirHash?: string;
  offset?: number;
  length?: number;
}, context?: MemoryAccessContext) {
  return invokeMemory<MemoryReadResponse>("memory_read", { args }, context);
}

export async function memorySearch(args: {
  query: string;
  scope?: MemoryScopeFilter;
  workdir?: string;
  memoryType?: MemorySearchType;
  limit?: number;
  includeHistory?: boolean;
  historySince?: number;
  historyUntil?: number;
  historyDateLocal?: string;
  historyTimeMode?: MemoryHistoryTimeMode;
}, context?: MemoryAccessContext) {
  return invokeMemory<MemorySearchResponse>("memory_search", { args }, context);
}

export async function memoryWrite(args: {
  slug: string;
  scope: MemoryScope;
  workdir?: string;
  memoryType: MemoryType;
  description: string;
  body: string;
  actor?: string;
  conversationId?: string;
  model?: string;
  evidence?: MemoryEvidenceFields;
}, context?: MemoryAccessContext) {
  return invokeMemory<MemoryMutationResponse>("memory_write", { args }, context);
}

export async function memoryUpdate(args: {
  slug: string;
  scope?: MemoryScopeFilter;
  workdir?: string;
  workdirHash?: string;
  memoryType?: MemoryType;
  description?: string;
  body?: string;
  mode?: MemoryUpdateMode;
  actor?: string;
  conversationId?: string;
  model?: string;
  evidence?: MemoryEvidenceFields;
}, context?: MemoryAccessContext) {
  return invokeMemory<MemoryMutationResponse>("memory_update", { args }, context);
}

export async function memoryDelete(args: {
  slug: string;
  scope: MemoryScope;
  workdir?: string;
  workdirHash?: string;
  actor?: string;
  reason?: string;
  conversationId?: string;
  model?: string;
}, context?: MemoryAccessContext) {
  return invokeMemory<MemoryMutationResponse>("memory_delete", { args }, context);
}

export async function memoryDeleteProject(args: {
  workdir: string;
  actor?: "user" | "tool" | "extractor" | "reconcile";
  reason?: string;
}, context?: MemoryAccessContext) {
  return invokeMemory<MemoryDeleteProjectResponse>("memory_delete_project", { args }, context);
}

export async function memoryAccept(args: {
  slug: string;
  scope: MemoryScope;
  workdir?: string;
  workdirHash?: string;
}, context?: MemoryAccessContext) {
  return invokeMemory<MemoryMutationResponse>("memory_accept", { args }, context);
}

export async function memoryApplyBatch(args: {
  workdir?: string;
  conversationId?: string;
  trigger?: "memory-extraction" | "memory-organize" | "end" | "compaction";
  model?: string;
  localDate?: string;
  dailyAppend?: {
    bullet: string;
  };
  decisions?: ApplyDecision[];
}, context?: MemoryAccessContext) {
  return invokeMemory<MemoryBatchResponse>("memory_apply_batch", { args }, context);
}

export async function memoryOrganizeRunCreate(args: {
  trigger: MemoryOrganizeTrigger;
  dueAt?: number;
  model?: unknown;
  scope?: OrganizerScope;
  mode?: OrganizerMode;
}, context?: MemoryAccessContext) {
  return invokeMemory<MemoryOrganizeRunCreateResponse>("memory_organize_run_create", { args }, context);
}

export async function memoryOrganizeRunUpdate(args: {
  runId: string;
  status?: MemoryOrganizeRunStatus;
  startedAt?: number;
  finishedAt?: number;
  inputCount?: number;
  clusterCount?: number;
  safeApplied?: number;
  reviewSkipped?: number;
  createdCount?: number;
  updatedCount?: number;
  deletedCount?: number;
  mergedCount?: number;
  parseFailures?: number;
  error?: string;
  finalSummary?: string;
  phase?: string;
  finalCount?: number;
  compressionRatio?: number;
  compressionTarget?: number;
  dryRun?: boolean;
  tokenUsageTotal?: number;
  quotaHeadroomAtStart?: number;
  overrideReviewed?: boolean;
  report?: unknown;
}, context?: MemoryAccessContext) {
  return invokeMemory<MemoryOrganizeRun | null>("memory_organize_run_update", { args }, context);
}

export async function memoryOrganizeRunList(args?: {
  status?: MemoryOrganizeRunStatus;
  limit?: number;
}, context?: MemoryAccessContext) {
  return invokeMemory<MemoryOrganizeRunListResponse>("memory_organize_run_list", {
    args: args ?? {},
  }, context);
}

export async function memoryOrganizeRunRead(args: { runId: string }, context?: MemoryAccessContext) {
  return invokeMemory<MemoryOrganizeRun | null>("memory_organize_run_read", { args }, context);
}

export async function memoryOrganizeRunClearHistory(context?: MemoryAccessContext) {
  return invokeMemory<MemoryOrganizeRunClearHistoryResponse>("memory_organize_run_clear_history", undefined, context);
}

export async function memoryOrganizeDueClaim(args: {
  enabled?: boolean;
  dueAt?: number;
  now?: number;
  model?: unknown;
  scope?: OrganizerScope;
  mode?: OrganizerMode;
}, context?: MemoryAccessContext) {
  return invokeMemory<MemoryOrganizeDueClaimResponse>("memory_organize_due_claim", { args }, context);
}

export async function memoryOrganizeDueComplete(
  args: Parameters<typeof memoryOrganizeRunUpdate>[0], context?: MemoryAccessContext) {
  return invokeMemory<MemoryOrganizeRun | null>("memory_organize_due_complete", { args }, context);
}

export async function memoryIndexOverview(workdir?: string, context?: MemoryAccessContext) {
  return invokeMemory<MemoryOverviewResponse>("memory_index_overview", { workdir }, context);
}

export async function memoryRecentRejections(args?: {
  sinceDays?: number;
  limit?: number;
  workdir?: string;
}, context?: MemoryAccessContext) {
  return invokeMemory<MemoryRecentRejectionsResponse>("memory_recent_rejections", {
    args: args ?? {},
  }, context);
}

export async function memoryQuotaSummary(args?: { workdir?: string }, context?: MemoryAccessContext) {
  return invokeMemory<MemoryQuotaSummaryResponse>("memory_quota_summary", {
    args: args ?? {},
  }, context);
}

export async function memoryPathsInfo(context?: MemoryAccessContext) {
  return invokeMemory<MemoryPathsInfo>("memory_paths_info", undefined, context);
}

export async function memoryTodayLocalDate(rolloverHour?: number, context?: MemoryAccessContext) {
  return invokeMemory<string>("memory_today_local_date", { rolloverHour }, context);
}

export async function memoryTodayDaily(rolloverHour?: number, context?: MemoryAccessContext) {
  return invokeMemory<MemoryReadResponse | null>("memory_today_daily", { rolloverHour }, context);
}

export async function memoryWipeAll(context?: MemoryAccessContext) {
  return invokeMemory<MemoryPathsInfo>("memory_wipe_all", undefined, context);
}
