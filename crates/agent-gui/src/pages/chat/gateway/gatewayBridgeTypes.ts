import type { MutableRefObject } from "react";
import type { MentionComposerDraft } from "../../../components/chat/MentionComposer";
import type {
  ChannelPermissionPolicy,
  ChannelPermissionProfile,
} from "../../../lib/channelControl";
import { normalizeChannelPermissionPolicy } from "../../../lib/channelPermissionPolicy";
import type { HistoryMessageRef } from "../../../lib/chat/conversation/conversationState";
import type { PendingUploadedFile } from "../../../lib/chat/messages/uploadedFiles";
import type {
  PrincipalContext,
  TrustedChannelOrigin,
} from "../../../lib/security/principalContext";
import type {
  ChatRuntimeControls,
  ExecutionMode,
  ProviderId,
  SystemToolId,
} from "../../../lib/settings";
import type { ConversationRuntimeEntry } from "../runtime/chatPageRuntime";

export type GatewaySelectedModelEvent = {
  customProviderId: string;
  model: string;
  providerType: string;
};

export type GatewayChatRuntimeControlsEvent = Pick<
  ChatRuntimeControls,
  "thinkingEnabled" | "nativeWebSearchEnabled" | "reasoning"
>;

export type GatewayChatRequestEvent = {
  requestId: string;
  conversationId: string;
  clientRequestId?: string;
  message: string;
  rebased?: boolean;
  baseMessageRef?: HistoryMessageRef;
  selectedModel?: GatewaySelectedModelEvent;
  runtimeControls?: GatewayChatRuntimeControlsEvent;
  executionMode?: string;
  workdir?: string;
  selectedSystemTools?: string[];
  uploadedFiles?: PendingUploadedFile[];
  queuePolicy?: "auto" | "append" | "interrupt" | string;
  /** Gateway-authenticated channel origin. Never populated from message text. */
  origin?: TrustedChannelOrigin;
};

export type GatewayChatClaimedRequest = {
  requestId: string;
  clientRequestId: string;
  conversationId: string;
  state: string;
  attempt: number;
  leaseMs: number;
  request: GatewayChatRequestEvent;
};

export type GatewayChatRequestReadyEvent = {
  requestId?: string;
  reason?: string;
};

export type EnsureGatewayBridgeConversationReadyOptions = {
  rebased?: boolean;
  baseMessageRef?: HistoryMessageRef;
  /** Allocate an empty runtime when a trusted channel owns a new derived id. */
  createIfMissing?: boolean;
};

export type GatewayChatCancelEvent = {
  requestId: string;
  conversationId: string;
};

export type ChannelPermissionPolicySnapshot = Readonly<
  Omit<
    Required<ChannelPermissionPolicy>,
    "allowedSkills" | "allowedSystemTools" | "allowedMcpServers"
  > & {
    allowedSkills: readonly string[];
    allowedSystemTools: readonly string[];
    allowedMcpServers: readonly string[];
  }
>;

export type ChannelPermissionProfileSnapshot = Readonly<
  Pick<ChannelPermissionProfile, "id" | "revision" | "policyHash"> & {
    policy: ChannelPermissionPolicySnapshot;
  }
>;

/** Copy and deeply freeze the authorization decision captured for one run. */
export function freezeChannelPermissionProfile(
  profile: ChannelPermissionProfile | ChannelPermissionProfileSnapshot,
): ChannelPermissionProfileSnapshot {
  const normalized = normalizeChannelPermissionPolicy({
    ...profile.policy,
    allowedSkills: profile.policy.allowedSkills?.slice(),
    allowedSystemTools: profile.policy.allowedSystemTools?.slice(),
    allowedMcpServers: profile.policy.allowedMcpServers?.slice(),
  });
  const allowedSkills = Object.freeze(normalized.allowedSkills.slice());
  const allowedSystemTools = Object.freeze(normalized.allowedSystemTools.slice());
  const allowedMcpServers = Object.freeze(normalized.allowedMcpServers.slice());
  const policy = Object.freeze({
    ...normalized,
    allowedSkills,
    allowedSystemTools,
    allowedMcpServers,
  }) as ChannelPermissionPolicySnapshot;
  return Object.freeze({
    id: profile.id,
    revision: profile.revision,
    policyHash: profile.policyHash,
    policy,
  });
}

export type ActiveGatewayBridgeRequest = {
  requestId: string;
  conversationId: string;
  clientRequestId?: string;
  workerId?: string;
  startedAt: number;
  selectedModelOverride?: GatewaySelectedModelEvent;
  runtimeControlsOverride?: ChatRuntimeControls;
  executionModeOverride?: ExecutionMode;
  workdirOverride?: string;
  selectedSystemToolIdsOverride?: SystemToolId[];
  principal?: PrincipalContext;
  permissionProfile?: ChannelPermissionProfileSnapshot;
};

export type SendChatAction = (overrides?: {
  /** Existing durable queue admission, transferred to running in place. */
  lifecycleToken?: string;
  textOverride?: string;
  composerDraftOverride?: MentionComposerDraft;
  uploadedFilesOverride?: PendingUploadedFile[];
  conversationIdOverride?: string;
  executionModeOverride?: ExecutionMode;
  workdirOverride?: string;
  allowEmptyWorkdirOverride?: boolean;
  selectedSystemToolIdsOverride?: SystemToolId[];
  runtimeControlsOverride?: ChatRuntimeControls;
  gatewayBridgeRequestOverride?: ActiveGatewayBridgeRequest | null;
  preserveComposerOnStart?: boolean;
  beforeRuntimeStart?: () => Promise<void>;
  afterInitialHistoryPersist?: () => Promise<void>;
  // Edit-resend: the edited (truncation-base) user message. Forwarded on the
  // mirrored user_message event so the gateway can broadcast the truncation
  // (`rebased`) to every other connected client.
  editResendBaseMessageRef?: HistoryMessageRef;
}) => Promise<boolean>;

export type GatewayBridgeRuntimeRefs = {
  currentConversationIdRef: MutableRefObject<string>;
  conversationRuntimeCacheRef: MutableRefObject<Map<string, ConversationRuntimeEntry>>;
  ensureGatewayBridgeConversationReadyRef: MutableRefObject<
    (id: string, options?: EnsureGatewayBridgeConversationReadyOptions) => Promise<string>
  >;
  sendActionRef: MutableRefObject<SendChatAction>;
};

export function normalizeGatewayProviderType(value: string): ProviderId | null {
  const normalized = value.trim();
  if (
    normalized === "codex" ||
    normalized === "claude_code" ||
    normalized === "gemini" ||
    normalized === "zhipu"
  ) {
    return normalized;
  }
  return null;
}

export function normalizeGatewayExecutionMode(
  value: string | null | undefined,
): ExecutionMode | undefined {
  switch (value?.trim()) {
    case "tools":
    case "agent-dev":
    case "text":
      return value.trim() as ExecutionMode;
    default:
      return undefined;
  }
}

export function normalizeGatewayWorkdir(value: string | null | undefined): string | undefined {
  const normalized = value?.trim() ?? "";
  return normalized || undefined;
}
