import { invoke } from "@tauri-apps/api/core";

export type ChannelPermissionPolicy = {
  executionMode: "text" | "tools" | "agent-dev";
  workdir?: string;
  /** Defaults to false when omitted. */
  allowEmptyWorkdir?: boolean;
  allowedSkills?: readonly string[];
  allowedSystemTools?: readonly string[];
  allowedMcpServers?: readonly string[];
  memoryEnabled?: boolean;
  /** Provider-hosted web search. Defaults to false when omitted. */
  nativeWebSearchEnabled?: boolean;
  maxDurationSeconds?: number;
  maxOutputChars?: number;
};

export type ChannelPermissionProfile = {
  id: string;
  name: string;
  revision: number;
  policy: ChannelPermissionPolicy;
  policyHash: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type ChannelPrincipalBinding = {
  id: string;
  installationId: string;
  principalType: string;
  principalId: string;
  profileId: string;
  profileRevision: number;
  updatedAt: number;
};

export type ChannelInstallationDefault = {
  profile: ChannelPermissionProfile;
  binding: ChannelPrincipalBinding;
  followsDesktop: boolean;
  profileCurrentRevision: number;
};

export type ChannelDeliveryTarget = {
  id: string;
  channel: string;
  installationId: string;
  externalTargetId: string;
  targetType: string;
  displayName: string;
  enabled: boolean;
  validationStatus: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

export type ChannelDeliveryOutboxEntry = {
  id: string;
  targetId: string;
  runId?: string;
  idempotencyKey: string;
  body: string;
  status: "prepared" | "sending" | "sent" | "failed" | "unknown";
  attemptCount: number;
  leaseUntil?: number;
  lastError?: string;
  sentAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type ChannelClaimedDelivery = {
  outbox: ChannelDeliveryOutboxEntry;
  target: ChannelDeliveryTarget;
};

export const channelControl = {
  listProfiles: () => invoke<ChannelPermissionProfile[]>("channel_profiles_list"),
  saveProfile: (input: {
    id?: string;
    name: string;
    policy: ChannelPermissionPolicy;
    enabled?: boolean;
  }) => invoke<ChannelPermissionProfile>("channel_profile_save", { input }),
  ensureInstallationDefault: (input: {
    installationId: string;
    name: string;
    policy: ChannelPermissionPolicy;
  }) =>
    invoke<ChannelInstallationDefault>("channel_installation_default_ensure", {
      input,
    }),
  adoptInstallationDefault: (input: {
    installationId: string;
    name: string;
    policy: ChannelPermissionPolicy;
    expected: {
      bindingId: string;
      profileId: string;
      profileRevision: number;
      profileCurrentRevision: number;
      policyHash: string;
    };
  }) =>
    invoke<ChannelInstallationDefault>("channel_installation_default_adopt", {
      input,
    }),
  bindPrincipal: (input: {
    id?: string;
    installationId: string;
    principalType: string;
    principalId: string;
    profileId: string;
  }) => invoke<ChannelPrincipalBinding>("channel_principal_bind", { input }),
  resolveProfile: (input: { installationId: string; principalType: string; principalId: string }) =>
    invoke<ChannelPermissionProfile | null>("channel_profile_resolve", {
      input,
    }),
  resolveEffectiveProfile: (input: {
    installationId: string;
    userId: string;
    conversationId?: string;
    groupId?: string;
  }) =>
    invoke<ChannelPermissionProfile | null>("channel_profile_resolve_effective", {
      input,
    }),
  listTargets: (channel?: string) =>
    invoke<ChannelDeliveryTarget[]>("channel_delivery_targets_list", {
      channel,
    }),
  saveTarget: (input: {
    channel: string;
    installationId: string;
    externalTargetId: string;
    targetType: string;
    displayName?: string;
    enabled?: boolean;
    validationStatus?: string;
  }) => invoke<ChannelDeliveryTarget>("channel_delivery_target_save", { input }),
  enqueueDelivery: (input: {
    targetId: string;
    runId?: string;
    idempotencyKey: string;
    body: string;
  }) =>
    invoke<ChannelDeliveryOutboxEntry>("channel_delivery_outbox_enqueue", {
      input,
    }),
  claimDeliveries: (limit = 20, leaseMs = 30_000) =>
    invoke<ChannelDeliveryOutboxEntry[]>("channel_delivery_outbox_claim", {
      limit,
      leaseMs,
    }),
  claimDeliveryForRun: (runId: string) =>
    invoke<ChannelClaimedDelivery | null>("channel_delivery_outbox_claim_for_run", {
      runId,
    }),
  markDelivery: (id: string, status: "sent" | "failed" | "unknown", error?: string) =>
    invoke<void>("channel_delivery_outbox_mark", { input: { id, status, error } }),
};
