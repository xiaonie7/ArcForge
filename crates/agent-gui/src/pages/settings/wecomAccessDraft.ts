import type { WeComAccessPolicy, WeComAccessScope } from "../../lib/security/wecomAccessPolicy";

export type WeComAccessRuleDraft = {
  tenantId: string;
  botId: string;
  externalUserId: string;
  enabled: boolean;
  roles: string[];
  scopes: WeComAccessScope[];
  allowedToolNames: string[];
  allowedSkillNames: string[];
  defaultSkillName: string;
  allowedSkillBaseDirs: string[];
  allowedDatabaseProfileIds: string[];
  allowedMcpServerIds: string[];
};

export function createWeComAccessRuleDraft(tenantId: string, botId: string): WeComAccessRuleDraft {
  return {
    tenantId: tenantId.trim() || botId.trim(),
    botId: botId.trim(),
    externalUserId: "",
    enabled: true,
    roles: [],
    scopes: [],
    allowedToolNames: [],
    allowedSkillNames: [],
    defaultSkillName: "",
    allowedSkillBaseDirs: [],
    allowedDatabaseProfileIds: [],
    allowedMcpServerIds: [],
  };
}

export function editWeComAccessRuleDraft(
  rule: WeComAccessRuleDraft,
  patch: Partial<WeComAccessRuleDraft>,
): WeComAccessRuleDraft {
  return { ...rule, ...patch };
}

export function isCompleteWeComAccessRuleDraft(rule: WeComAccessRuleDraft): boolean {
  return Boolean(rule.tenantId.trim() && rule.botId.trim() && rule.externalUserId.trim());
}

export function commitWeComAccessRuleDraft(
  policy: WeComAccessPolicy,
  rule: WeComAccessRuleDraft,
): WeComAccessPolicy | null {
  if (!isCompleteWeComAccessRuleDraft(rule)) return null;
  return {
    rules: [
      ...policy.rules,
      {
        ...rule,
        tenantId: rule.tenantId.trim(),
        botId: rule.botId.trim(),
        externalUserId: rule.externalUserId.trim(),
      },
    ],
  };
}
