import type { ChannelPermissionPolicy } from "./channelControl";
import type { AppSettings, McpSettings } from "./settings";
import { BUILTIN_TOOL_CATALOG } from "./tools/builtinToolCatalog";

export const DEFAULT_CHANNEL_MAX_DURATION_SECONDS = 3_600;
export const DEFAULT_CHANNEL_MAX_OUTPUT_CHARS = 1_000_000;
export const CHANNEL_SKILL_MANAGEMENT_NAMES = Object.freeze(["skills-creator", "skills-installer"]);
const channelSkillManagementNames = new Set(CHANNEL_SKILL_MANAGEMENT_NAMES);
export const DEFAULT_CHANNEL_BUILTIN_SYSTEM_TOOLS = Object.freeze([
  ...BUILTIN_TOOL_CATALOG.map((entry) => entry.id),
  // These two runtime tools predate their settings-catalog presentation entries.
  "OfficeRuntime",
  "SpreadsheetCode",
]);

/**
 * Convert a persisted channel policy into the complete run-time shape.
 * Missing capability lists are intentionally deny-all: an old or partially
 * populated profile must never inherit the desktop's current settings.
 */
export function normalizeChannelPermissionPolicy(
  policy: ChannelPermissionPolicy,
): Required<ChannelPermissionPolicy> {
  const boundedInteger = (value: number | undefined, fallback: number, maximum: number) => {
    if (!Number.isFinite(value) || !Number.isInteger(value) || (value as number) < 1) {
      return fallback;
    }
    return Math.min(value as number, maximum);
  };

  return {
    executionMode: policy.executionMode,
    workdir: policy.workdir?.trim() ?? "",
    allowEmptyWorkdir: policy.allowEmptyWorkdir === true,
    allowedSkills: channelRuntimeSkillNames(policy.allowedSkills ?? []),
    allowedSystemTools: uniqueIds(policy.allowedSystemTools ?? []),
    allowedMcpServers: uniqueIds(policy.allowedMcpServers ?? []),
    memoryEnabled: policy.memoryEnabled === true,
    nativeWebSearchEnabled: policy.nativeWebSearchEnabled === true,
    maxDurationSeconds: boundedInteger(
      policy.maxDurationSeconds,
      DEFAULT_CHANNEL_MAX_DURATION_SECONDS,
      DEFAULT_CHANNEL_MAX_DURATION_SECONDS,
    ),
    maxOutputChars: boundedInteger(
      policy.maxOutputChars,
      DEFAULT_CHANNEL_MAX_OUTPUT_CHARS,
      DEFAULT_CHANNEL_MAX_OUTPUT_CHARS,
    ),
  };
}

function uniqueIds(values: readonly string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function channelRuntimeSkillNames(values: readonly string[]) {
  return uniqueIds(values).filter((name) => !channelSkillManagementNames.has(name));
}

export function intersectChannelPermissionIds<T extends string>(
  selected: readonly T[],
  allowed: readonly string[],
): T[] {
  const allowedIds = new Set(uniqueIds(allowed));
  return selected.filter((value) => allowedIds.has(value.trim()));
}

/** Return a live-settings view containing only servers authorized by a profile. */
export function createChannelMcpSettingsSnapshot(
  settings: McpSettings,
  allowedServerIds: readonly string[],
): McpSettings {
  const allowed = new Set(uniqueIds(allowedServerIds));
  const servers = settings.servers
    .filter((server) => allowed.has(server.id.trim()))
    .map((server) =>
      Object.freeze({
        ...server,
        args: Object.freeze([...server.args]) as unknown as string[],
        ...(server.env ? { env: Object.freeze({ ...server.env }) as Record<string, string> } : {}),
        ...(server.headers
          ? { headers: Object.freeze({ ...server.headers }) as Record<string, string> }
          : {}),
      }),
    );
  const selected = settings.selected.filter((serverId) => allowed.has(serverId.trim()));
  return Object.freeze({
    ...settings,
    servers: Object.freeze(servers) as unknown as McpSettings["servers"],
    selected: Object.freeze(selected) as unknown as string[],
  });
}

/** Freeze the current desktop capabilities into a bounded installation default. */
export function createDefaultChannelPermissionPolicy(
  settings: AppSettings,
): ChannelPermissionPolicy {
  const executionMode = settings.system.executionMode;
  const workdir = settings.system.workdir.trim();
  return {
    executionMode,
    workdir,
    allowEmptyWorkdir: executionMode !== "text" && workdir.length === 0,
    allowedSkills: settings.skills.enabled
      ? channelRuntimeSkillNames(settings.skills.selected)
      : [],
    allowedSystemTools: uniqueIds([
      ...DEFAULT_CHANNEL_BUILTIN_SYSTEM_TOOLS,
      ...settings.system.selectedSystemTools,
    ]),
    allowedMcpServers: uniqueIds(
      settings.mcp.servers.filter((server) => server.enabled).map((server) => server.id),
    ),
    memoryEnabled: true,
    // Hosted search sends query context to the provider and is not represented
    // by the local system-tool allowlist, so installation defaults opt out.
    nativeWebSearchEnabled: false,
    maxDurationSeconds: DEFAULT_CHANNEL_MAX_DURATION_SECONDS,
    maxOutputChars: DEFAULT_CHANNEL_MAX_OUTPUT_CHARS,
  };
}
