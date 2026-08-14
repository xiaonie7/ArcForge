import type { PromptRunRequest } from "../../lib/automation";
import { type AppSettings, normalizeSystemToolSelection } from "../../lib/settings";

export type CronCapabilitySnapshot = {
  selectedSkills: string[];
  selectedSystemTools: AppSettings["system"]["selectedSystemTools"];
  mcp: AppSettings["mcp"];
};

/**
 * Playbook-created tasks carry an explicit capability snapshot. Legacy tasks
 * omit these fields and keep the pre-Playbook behavior of following the
 * current global configuration.
 */
export function resolveCronCapabilitySnapshot(
  settings: AppSettings,
  request: PromptRunRequest,
): CronCapabilitySnapshot {
  const selectedSkills = request.selectedSkills ?? settings.skills.selected;
  const selectedSystemTools =
    request.selectedSystemTools === undefined
      ? settings.system.selectedSystemTools
      : normalizeSystemToolSelection(request.selectedSystemTools);
  const allowedMcpIds = request.mcpServerIds;

  if (allowedMcpIds === undefined) {
    return {
      selectedSkills,
      selectedSystemTools,
      mcp: settings.mcp,
    };
  }

  const allowed = new Set(allowedMcpIds.map((id) => id.trim()).filter(Boolean));
  return {
    selectedSkills,
    selectedSystemTools,
    mcp: {
      servers: settings.mcp.servers.filter((server) => allowed.has(server.id.trim())),
      selected: settings.mcp.selected.filter((id) => allowed.has(id.trim())),
    },
  };
}
