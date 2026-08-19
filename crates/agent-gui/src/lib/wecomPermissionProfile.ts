import { channelControl } from "./channelControl";
import { createDefaultChannelPermissionPolicy } from "./channelPermissionPolicy";
import { buildChannelInstallationId } from "./security/principalContext";
import type { AppSettings } from "./settings";

export function buildWecomInstallationDefaultInput(settings: AppSettings) {
  const botId = settings.wecom.botId.trim();
  const tenantId = settings.wecom.tenantId.trim() || botId;
  const connectorId = settings.wecom.connectorId.trim() || "wecom-desktop";
  return {
    installationId: buildChannelInstallationId({
      botId,
      channel: "wecom",
      connectorId,
      tenantId,
    }),
    name: `WeCom ${botId} default`,
    policy: createDefaultChannelPermissionPolicy(settings),
  };
}

export function ensureWecomInstallationDefault(settings: AppSettings) {
  return channelControl.ensureInstallationDefault(buildWecomInstallationDefaultInput(settings));
}
