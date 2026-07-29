import type { TrustedChannelOrigin } from "./principalContext";

export const WECOM_ACCESS_SCOPES = [
  "interaction:respond",
  "tool:read",
  "skill:use",
  "database:read",
  "mcp:invoke",
] as const;

export type WeComAccessScope = (typeof WECOM_ACCESS_SCOPES)[number];

export type WeComAccessRule = Readonly<{
  tenantId: string;
  botId: string;
  externalUserId: string;
  enabled: boolean;
  roles: readonly string[];
  scopes: readonly WeComAccessScope[];
  allowedToolNames: readonly string[];
  allowedSkillNames: readonly string[];
  defaultSkillName: string;
  allowedSkillBaseDirs: readonly string[];
  allowedDatabaseProfileIds: readonly string[];
  allowedMcpServerIds: readonly string[];
}>;

export type WeComAccessPolicy = Readonly<{
  rules: readonly WeComAccessRule[];
}>;

export type ResolvedWeComGrant = Readonly<{
  matched: boolean;
  roles: readonly string[];
  scopes: readonly WeComAccessScope[];
  allowedToolNames: readonly string[];
  allowedSkillNames: readonly string[];
  defaultSkillName: string;
  allowedSkillBaseDirs: readonly string[];
  allowedDatabaseProfileIds: readonly string[];
  allowedMcpServerIds: readonly string[];
}>;

const MAX_RULES = 256;
const MAX_VALUES_PER_RULE = 256;
const MAX_ID_LENGTH = 512;
const SUPPORTED_SCOPES = new Set<string>(WECOM_ACCESS_SCOPES);

function normalizeId(value: unknown) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized.length <= MAX_ID_LENGTH ? normalized : "";
}

function normalizeStringList(value: unknown, predicate?: (item: string) => boolean) {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, MAX_VALUES_PER_RULE)) {
    const item = normalizeId(raw);
    if (!item || seen.has(item) || (predicate && !predicate(item))) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function normalizeSkillBaseDirs(value: unknown) {
  return normalizeStringList(value)
    .map(
      (item) =>
        item
          .replace(/\\/g, "/")
          .replace(/^\/+|\/+$/g, "")
          .split("/")[0] ?? "",
    )
    .filter(Boolean);
}

export function normalizeWeComAccessPolicy(value: unknown): WeComAccessPolicy {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const inputRules = Array.isArray(raw.rules) ? raw.rules.slice(0, MAX_RULES) : [];
  const rules: WeComAccessRule[] = [];

  for (const input of inputRules) {
    if (!input || typeof input !== "object") continue;
    const item = input as Record<string, unknown>;
    const tenantId = normalizeId(item.tenantId);
    const botId = normalizeId(item.botId);
    const externalUserId = normalizeId(item.externalUserId);
    // Wildcards are intentionally unsupported. Every grant must identify the
    // exact authenticated tenant, bot, and WeCom user tuple.
    if (!tenantId || !botId || !externalUserId) continue;

    const allowedSkillNames = normalizeStringList(item.allowedSkillNames);
    const requestedDefaultSkillName = normalizeId(item.defaultSkillName);
    // A default is executable authority, not a display preference. Retain it
    // only when the same rule explicitly grants the exact Skill name.
    const defaultSkillName = allowedSkillNames.includes(requestedDefaultSkillName)
      ? requestedDefaultSkillName
      : "";

    rules.push(
      Object.freeze({
        tenantId,
        botId,
        externalUserId,
        enabled: item.enabled !== false,
        roles: Object.freeze(normalizeStringList(item.roles)),
        scopes: Object.freeze(
          normalizeStringList(item.scopes, (scope) =>
            SUPPORTED_SCOPES.has(scope),
          ) as WeComAccessScope[],
        ),
        allowedToolNames: Object.freeze(normalizeStringList(item.allowedToolNames)),
        allowedSkillNames: Object.freeze(allowedSkillNames),
        defaultSkillName,
        allowedSkillBaseDirs: Object.freeze(normalizeSkillBaseDirs(item.allowedSkillBaseDirs)),
        allowedDatabaseProfileIds: Object.freeze(
          normalizeStringList(item.allowedDatabaseProfileIds),
        ),
        allowedMcpServerIds: Object.freeze(normalizeStringList(item.allowedMcpServerIds)),
      }),
    );
  }

  return Object.freeze({ rules: Object.freeze(rules) });
}

function appendUnique(target: string[], values: readonly string[]) {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
}

export function resolveWeComGrant(
  origin: Pick<TrustedChannelOrigin, "tenantId" | "botId" | "externalUserId">,
  policyValue?: unknown,
): ResolvedWeComGrant {
  const policy = normalizeWeComAccessPolicy(policyValue);
  const matches = policy.rules.filter(
    (rule) =>
      rule.enabled &&
      rule.tenantId === origin.tenantId &&
      rule.botId === origin.botId &&
      rule.externalUserId === origin.externalUserId,
  );

  const roles: string[] = [];
  const scopes: WeComAccessScope[] = [];
  const allowedToolNames: string[] = [];
  const allowedSkillNames: string[] = [];
  const allowedSkillBaseDirs: string[] = [];
  const allowedDatabaseProfileIds: string[] = [];
  const allowedMcpServerIds: string[] = [];
  const defaultSkillNames = new Set<string>();
  for (const rule of matches) {
    appendUnique(roles, rule.roles);
    appendUnique(scopes, rule.scopes);
    appendUnique(allowedToolNames, rule.allowedToolNames);
    appendUnique(allowedSkillNames, rule.allowedSkillNames);
    if (rule.defaultSkillName) defaultSkillNames.add(rule.defaultSkillName);
    appendUnique(allowedSkillBaseDirs, rule.allowedSkillBaseDirs);
    appendUnique(allowedDatabaseProfileIds, rule.allowedDatabaseProfileIds);
    appendUnique(allowedMcpServerIds, rule.allowedMcpServerIds);
  }

  // Distinct defaults from overlapping exact-match rules are ambiguous. Do
  // not choose by rule order; force the caller to route without a default.
  const defaultSkillName = defaultSkillNames.size === 1 ? [...defaultSkillNames][0] : "";

  return Object.freeze({
    matched: matches.length > 0,
    roles: Object.freeze(roles),
    scopes: Object.freeze(scopes),
    allowedToolNames: Object.freeze(allowedToolNames),
    allowedSkillNames: Object.freeze(allowedSkillNames),
    defaultSkillName,
    allowedSkillBaseDirs: Object.freeze(allowedSkillBaseDirs),
    allowedDatabaseProfileIds: Object.freeze(allowedDatabaseProfileIds),
    allowedMcpServerIds: Object.freeze(allowedMcpServerIds),
  });
}

export function principalCanUseSkill(
  principal: {
    scopes: readonly string[];
    allowedSkillNames: readonly string[];
    allowedSkillBaseDirs: readonly string[];
  },
  skill: { name?: string; baseDir?: string },
) {
  if (!principal.scopes.includes("skill:use")) return false;
  const name = typeof skill.name === "string" ? skill.name.trim() : "";
  const baseDir =
    typeof skill.baseDir === "string"
      ? (skill.baseDir
          .trim()
          .replace(/\\/g, "/")
          .replace(/^\/+|\/+$/g, "")
          .split("/")[0] ?? "")
      : "";
  return (
    (name.length > 0 && principal.allowedSkillNames.includes(name)) ||
    (baseDir.length > 0 && principal.allowedSkillBaseDirs.includes(baseDir))
  );
}
