import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";

import { runAssistantWithTools } from "../chat/runner/agentRunner";
import {
  createCompletionProposal,
  createToolIntentProposal,
  NATIVE_PI_BACKEND_ID,
  type CompletionProposal,
  type SealedRunSpec,
  type ToolIntentEffect,
  type ToolIntentProposal,
} from "./contracts";

export type NativePiRunParams = Parameters<typeof runAssistantWithTools>[0];
export type NativePiRunResult = Awaited<ReturnType<typeof runAssistantWithTools>>;
export type NativePiRunRequest = Omit<NativePiRunParams, "executeToolCall">;
type NativePiToolExecutionContext = Parameters<NativePiRunParams["executeToolCall"]>[2];

export type NativePiToolIntentSubmitter = (
  proposal: ToolIntentProposal,
  signal?: AbortSignal,
  context?: NativePiToolExecutionContext,
) => Promise<Message>;

export type NativePiBackendResult = {
  result: NativePiRunResult;
  completionProposal: CompletionProposal;
};

const TOOL_EFFECTS: Readonly<Record<string, ToolIntentEffect>> = Object.freeze({
  Read: "workspace_read",
  List: "workspace_read",
  Glob: "workspace_read",
  Grep: "workspace_read",
  Write: "workspace_draft_mutation",
  Edit: "workspace_draft_mutation",
  Delete: "workspace_draft_mutation",
  Bash: "process_execution",
  SendMessage: "coordination_message",
});

function unsupportedToolResult(toolCall: {
  id: string;
  name: string;
}): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [
      {
        type: "text",
        text: `NativePiBackend candidate mode denies unsupported tool: ${toolCall.name}`,
      },
    ],
    details: {
      code: "candidate_tool_not_allowed",
    },
    isError: true,
    timestamp: Date.now(),
  };
}

/**
 * ArcForge's native Pi adapter.
 *
 * Pi owns inference and tool selection. It can finish an AgentRun, but the
 * returned CompletionProposal is deliberately not a Task-success decision.
 * Candidate collection, validation and apply stay outside this adapter.
 */
export class NativePiBackend {
  readonly id = NATIVE_PI_BACKEND_ID;

  async run(params: {
    runSpec: SealedRunSpec;
    request: NativePiRunRequest;
    submitToolIntent: NativePiToolIntentSubmitter;
  }): Promise<NativePiBackendResult> {
    if (params.runSpec.spec.backendId !== this.id) {
      throw new Error(
        `NativePiBackend cannot execute backend ${JSON.stringify(params.runSpec.spec.backendId)}`,
      );
    }
    let sourceSequence = 0;
    const result = await runAssistantWithTools({
      ...params.request,
      executeToolCall: async (toolCall, signal, context) => {
        const effect = TOOL_EFFECTS[toolCall.name];
        if (!effect) {
          return unsupportedToolResult(toolCall);
        }
        sourceSequence += 1;
        return params.submitToolIntent(
          createToolIntentProposal({
            runSpec: params.runSpec,
            sourceSequence,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            effect,
            arguments:
              toolCall.arguments && typeof toolCall.arguments === "object"
                ? (toolCall.arguments as Record<string, unknown>)
                : {},
          }),
          signal,
          context,
        );
      },
    });
    if (params.request.signal?.aborted) {
      throw params.request.signal.reason ?? new Error("Cancelled");
    }
    return {
      result,
      completionProposal: createCompletionProposal(params.runSpec),
    };
  }
}

export const nativePiBackend = new NativePiBackend();
