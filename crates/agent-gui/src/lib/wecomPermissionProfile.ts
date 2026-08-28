import {
  type ChannelInstallationDefault,
  type ChannelPermissionProfile,
  channelControl,
} from "./channelControl";
import { createDefaultChannelPermissionPolicy } from "./channelPermissionPolicy";
import { buildChannelInstallationId, type PrincipalContext } from "./security/principalContext";
import type { AppSettings } from "./settings";

type PendingInstallationDefault = {
  key: string;
  promise: Promise<ChannelInstallationDefault>;
};

const pendingInstallationDefaults = new Map<string, PendingInstallationDefault>();

/** Serialize writes per installation, sharing only an identical pending tail. */
function queueInstallationDefault(
  installationId: string,
  key: string,
  operation: () => Promise<ChannelInstallationDefault>,
): Promise<ChannelInstallationDefault> {
  const previous = pendingInstallationDefaults.get(installationId);
  if (previous?.key === key) return previous.promise;

  const promise = (previous?.promise.catch(() => undefined) ?? Promise.resolve()).then(operation);
  const pending = { key, promise };
  pendingInstallationDefaults.set(installationId, pending);
  const cleanup = () => {
    if (pendingInstallationDefaults.get(installationId) === pending) {
      pendingInstallationDefaults.delete(installationId);
    }
  };
  // Do not cache completed writes: a later call must observe manual profile
  // edits. Sharing only the tail also preserves the order of A -> B -> A.
  void promise.then(cleanup, cleanup);
  return promise;
}

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

export function buildWecomInstallationDefaultSyncKey(settings: AppSettings): string {
  return JSON.stringify(buildWecomInstallationDefaultInput(settings));
}

export function ensureWecomInstallationDefault(settings: AppSettings) {
  const input = buildWecomInstallationDefaultInput(settings);
  return queueInstallationDefault(input.installationId, `ensure:${JSON.stringify(input)}`, () =>
    channelControl.ensureInstallationDefault(input),
  );
}

export function adoptWecomInstallationDefault(
  settings: AppSettings,
  existing: ChannelInstallationDefault,
) {
  const input = {
    ...buildWecomInstallationDefaultInput(settings),
    expected: {
      bindingId: existing.binding.id,
      profileId: existing.binding.profileId,
      profileRevision: existing.binding.profileRevision,
      profileCurrentRevision: existing.profileCurrentRevision,
      policyHash: existing.profile.policyHash,
    },
  };
  return queueInstallationDefault(input.installationId, `adopt:${JSON.stringify(input)}`, () =>
    channelControl.adoptInstallationDefault(input),
  );
}

/** Resolve an authenticated principal after syncing only this desktop's installation. */
export async function resolveWecomPermissionProfile(
  settings: AppSettings,
  principal: PrincipalContext,
  conversationId?: string,
): Promise<ChannelPermissionProfile | null> {
  if (settings.wecom.enabled && settings.wecom.botId.trim()) {
    const { installationId } = buildWecomInstallationDefaultInput(settings);
    if (installationId === principal.installationId) {
      await ensureWecomInstallationDefault(settings);
    }
  }
  return channelControl.resolveEffectiveProfile({
    installationId: principal.installationId,
    userId: principal.externalUserId,
    conversationId,
  });
}
