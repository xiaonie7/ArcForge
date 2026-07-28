import type { BuiltinToolMetadata } from "../tools/builtinTypes";
import type { PrincipalContext } from "./principalContext";

export type ToolAuthorizationInput = {
  toolName: string;
  metadata?: BuiltinToolMetadata;
  principal?: PrincipalContext;
};

export type ToolAuthorizationDecision = {
  allowed: boolean;
  code?: string;
  reason?: string;
};

export type BuiltinToolAuthorizationPolicy = {
  isToolVisible: (input: ToolAuthorizationInput) => boolean;
  authorize: (input: ToolAuthorizationInput) => ToolAuthorizationDecision;
};

const ALWAYS_ALLOWED_INTERACTION_TOOLS = new Set(["AskUserQuestion", "TodoWrite"]);
const ALWAYS_DENIED_REMOTE_TOOLS = new Set([
  "Bash",
  "ManagedProcess",
  "ReadTerminal",
  "Terminal",
  "CronManager",
  "McpManager",
  "MemoryManager",
  "SkillsManager",
  "SSHManager",
  "TunnelManager",
  "Agent",
  "AgentBatch",
]);

function denied(reason: string, code = "principal_tool_denied"): ToolAuthorizationDecision {
  return { allowed: false, code, reason };
}

/**
 * Conservative policy for authenticated WeCom runs. Browser/local runs pass
 * through unchanged; channel-specific grants can be layered on later without
 * changing the executor contract.
 */
export function createBuiltinToolAuthorizationPolicy(
  principal?: PrincipalContext,
): BuiltinToolAuthorizationPolicy {
  const remote = principal?.channel === "wecom";
  if (!remote) {
    return {
      isToolVisible: () => true,
      authorize: () => ({ allowed: true }),
    };
  }

  const hasScope = (scope: string) => principal.scopes.includes(scope);
  const isGroup = principal.chatType === "group";
  const allowedToolNames = principal.allowedToolNames ?? [];
  const allowedMcpServerIds = principal.allowedMcpServerIds ?? [];

  const authorize = ({ toolName, metadata }: ToolAuthorizationInput) => {
    const normalizedName = toolName.trim();
    if (!normalizedName) return denied("Tool name is required.", "invalid_tool_name");
    if (ALWAYS_DENIED_REMOTE_TOOLS.has(normalizedName)) {
      return denied(`Tool ${normalizedName} is disabled for WeCom channel requests.`);
    }
    if (ALWAYS_ALLOWED_INTERACTION_TOOLS.has(normalizedName)) {
      return hasScope("interaction:respond")
        ? { allowed: true }
        : denied("Interactive responses are not enabled for this principal.");
    }
    if (!metadata) return denied(`Tool ${normalizedName} has no authorization metadata.`);

    if (metadata.groupId === "memory") {
      return denied("Conversation memory is isolated from remote channel requests.");
    }
    if (metadata.groupId === "shell" || metadata.groupId === "subagent") {
      return denied(`${metadata.groupId} tools are disabled for WeCom channel requests.`);
    }
    if (metadata.groupId === "mcp") {
      if (isGroup || !hasScope("mcp:invoke")) {
        return denied("MCP tools require a direct WeCom chat and an explicit local grant.");
      }
      const serverId = metadata.resourceId?.trim() ?? "";
      if (!serverId || !allowedMcpServerIds.includes(serverId)) {
        return denied(`MCP server for ${normalizedName} is not granted to this principal.`);
      }
      return { allowed: true };
    }
    if (!hasScope("tool:read")) {
      return denied("Read tools are not enabled for this principal.");
    }
    if (!allowedToolNames.includes(normalizedName)) {
      return denied(`Tool ${normalizedName} is not granted to this principal.`);
    }
    if (!metadata.isReadOnly) {
      return denied(`Mutating tool ${normalizedName} is disabled for WeCom channel requests.`);
    }
    if (isGroup && metadata.groupId === "office") {
      return denied(
        "Office tools are disabled in group chats because results may be visible to the group.",
      );
    }
    return { allowed: true };
  };

  return {
    isToolVisible: (input) => authorize(input).allowed,
    authorize,
  };
}

export function formatToolAuthorizationError(
  toolName: string,
  decision: ToolAuthorizationDecision,
) {
  const reason = decision.reason || "The current principal is not authorized for this tool.";
  return `Tool ${toolName.trim() || "(unknown)"} blocked: ${reason}`;
}
