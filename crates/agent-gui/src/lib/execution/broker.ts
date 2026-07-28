import type { Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";

import type {
  SealedRunSpec,
  ToolIntentProposal,
  ToolIntentEffect,
} from "./contracts";
import type { NativePiToolIntentSubmitter } from "./nativePiBackend";

export type BrokerAuthorization = {
  authorized: boolean;
  authorizationId?: string;
  isolationLevel?: "workspace_only";
  reason?: string;
};

export type ToolIntentAuthorizer = (
  proposal: ToolIntentProposal,
) => Promise<BrokerAuthorization>;

export type BrokerRunRegistration = {
  bindingId: string;
  isolationLevel: "workspace_only";
};

const REQUIRED_CAPABILITY_BY_EFFECT: Record<
  ToolIntentEffect,
  "workspace.read" | "workspace.write" | "process.execute" | "coordination.send"
> = {
  workspace_read: "workspace.read",
  workspace_draft_mutation: "workspace.write",
  process_execution: "process.execute",
  coordination_message: "coordination.send",
};

function brokerErrorResult(
  proposal: ToolIntentProposal,
  message: string,
  code: string,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: proposal.toolCallId,
    toolName: proposal.toolName,
    content: [{ type: "text", text: message }],
    details: {
      code,
      runId: proposal.runId,
      runSpecHash: proposal.runSpecHash,
      sourceSequence: proposal.sourceSequence,
    },
    isError: true,
    timestamp: Date.now(),
  };
}

export const tauriToolIntentAuthorizer: ToolIntentAuthorizer = async (proposal) => {
  const response = await invoke<BrokerAuthorization>("execution_broker_authorize", {
    proposal,
  });
  return {
    authorized: response.authorized === true,
    authorizationId:
      typeof response.authorizationId === "string" ? response.authorizationId : undefined,
    isolationLevel:
      response.isolationLevel === "workspace_only" ? "workspace_only" : undefined,
    reason: typeof response.reason === "string" ? response.reason : undefined,
  };
};

export async function registerBrokerRun(
  runSpec: SealedRunSpec,
): Promise<BrokerRunRegistration> {
  return invoke<BrokerRunRegistration>("execution_broker_register_run", {
    registration: {
      runSpec: runSpec.spec,
      runSpecHash: runSpec.hash,
    },
  });
}

export async function closeBrokerRun(runSpec: SealedRunSpec) {
  await invoke("execution_broker_close_run", {
    runId: runSpec.spec.runId,
    runSpecHash: runSpec.hash,
  });
}

export function createBrokeredToolIntentSubmitter(params: {
  capabilities: readonly string[];
  executeToolCall: (toolCall: ToolCall, signal?: AbortSignal) => Promise<Message>;
  authorize?: ToolIntentAuthorizer;
}): NativePiToolIntentSubmitter {
  const capabilities = new Set(params.capabilities);
  const authorize = params.authorize ?? tauriToolIntentAuthorizer;

  return async (proposal, signal) => {
    const requiredCapability = REQUIRED_CAPABILITY_BY_EFFECT[proposal.effect];
    if (!capabilities.has(requiredCapability)) {
      throw new Error(`Tool intent denied: missing capability ${requiredCapability}`);
    }
    if (signal?.aborted) throw signal.reason ?? new Error("Cancelled");

    let authorization: BrokerAuthorization;
    try {
      authorization = await authorize(proposal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Tool intent broker failed: ${message}`, { cause: error });
    }
    if (signal?.aborted) throw signal.reason ?? new Error("Cancelled");
    if (!authorization.authorized) {
      return brokerErrorResult(
        proposal,
        `Tool intent denied by broker: ${authorization.reason ?? "policy denied"}`,
        "broker_denied",
      );
    }

    const toolCall: ToolCall = {
      type: "toolCall",
      id: proposal.toolCallId,
      name: proposal.toolName,
      arguments: { ...proposal.arguments },
    };
    return params.executeToolCall(toolCall, signal);
  };
}
