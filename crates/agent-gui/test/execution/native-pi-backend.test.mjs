import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const agentRunnerPath = path.join(rootDir, "src/lib/chat/runner/agentRunner.ts");

function toolResult(toolCall, text = "ok") {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    details: {},
    isError: false,
    timestamp: 1,
  };
}

test("sealed RunSpec cannot drift after its hash is computed", async () => {
  const loader = createTsModuleLoader();
  const contracts = loader.loadModule("src/lib/execution/contracts.ts");
  const runSpec = await contracts.sealRunSpec({
    taskId: "task-1",
    runId: "run-1",
    backendId: "native-pi",
    mode: "execute",
    workspace: {
      workspaceId: "workspace-1",
      parentRoot: "C:/repo",
      taskRoot: "C:/repo-worktree",
      baseRevision: "a".repeat(40),
    },
    capabilities: ["workspace.read"],
    validationPlan: {
      requiredChecks: ["base_revision"],
      commands: [],
    },
    candidatePolicy: { allowedOutputPaths: [] },
    createdAt: 1,
  });

  assert.equal(Object.isFrozen(runSpec), true);
  assert.equal(Object.isFrozen(runSpec.spec), true);
  assert.equal(Object.isFrozen(runSpec.spec.workspace), true);
  assert.equal(Object.isFrozen(runSpec.spec.capabilities), true);
  assert.equal(Object.isFrozen(runSpec.spec.validationPlan), true);
  assert.equal(Object.isFrozen(runSpec.spec.validationPlan.requiredChecks), true);
  assert.equal(Object.isFrozen(runSpec.spec.candidatePolicy), true);
  assert.equal(Object.isFrozen(runSpec.spec.candidatePolicy.allowedOutputPaths), true);
  assert.equal(
    runSpec.hash,
    "a90e0ea2194df8febad90fd83a841cab52a1fed4b1e7619b2e0be28247411fa0",
  );
  assert.throws(() => runSpec.spec.capabilities.push("workspace.write"), TypeError);
  assert.throws(() => {
    runSpec.spec.workspace.taskRoot = "C:/elsewhere";
  }, TypeError);
});

test("NativePiBackend emits ordered ToolIntentProposal objects and only proposes completion", async () => {
  const loader = createTsModuleLoader({
    mocks: {
      [agentRunnerPath]: {
        async runAssistantWithTools(params) {
          await params.executeToolCall({
            type: "toolCall",
            id: "read-1",
            name: "Read",
            arguments: { path: "src/app.ts" },
          });
          await params.executeToolCall({
            type: "toolCall",
            id: "write-1",
            name: "Write",
            arguments: { path: "src/app.ts", content: "next" },
          });
          const assistant = {
            role: "assistant",
            content: [{ type: "text", text: "candidate ready" }],
            timestamp: 2,
          };
          return { assistant, messages: [assistant], emittedMessages: [assistant] };
        },
      },
    },
  });
  const contracts = loader.loadModule("src/lib/execution/contracts.ts");
  const backendModule = loader.loadModule("src/lib/execution/nativePiBackend.ts");
  const runSpec = await contracts.sealRunSpec({
    taskId: "task-1",
    runId: "run-1",
    backendId: "native-pi",
    mode: "execute",
    workspace: {
      workspaceId: "workspace-1",
      parentRoot: "C:/repo",
      taskRoot: "C:/repo-worktree",
      baseRevision: "a".repeat(40),
    },
    capabilities: ["workspace.read", "workspace.write"],
    validationPlan: {
      requiredChecks: ["base_revision", "candidate_paths"],
      commands: [],
    },
    candidatePolicy: { allowedOutputPaths: ["src/**"] },
    createdAt: 1,
  });
  const proposals = [];
  const outcome = await backendModule.nativePiBackend.run({
    runSpec,
    request: {
      providerId: "codex",
      model: "test",
      runtime: { baseUrl: "https://example.test", apiKey: "test" },
      context: { systemPrompt: "", messages: [], tools: [] },
      workdir: "C:/repo-worktree",
      tools: [],
      onTextDelta() {},
    },
    async submitToolIntent(proposal) {
      proposals.push(proposal);
      return toolResult(
        {
          id: proposal.toolCallId,
          name: proposal.toolName,
        },
        "authorized",
      );
    },
  });

  assert.deepEqual(
    proposals.map((proposal) => [proposal.sourceSequence, proposal.toolName, proposal.effect]),
    [
      [1, "Read", "workspace_read"],
      [2, "Write", "workspace_draft_mutation"],
    ],
  );
  assert.equal(proposals[0].runSpecHash, runSpec.hash);
  assert.equal(outcome.completionProposal.kind, "completion_proposal");
  assert.equal(outcome.completionProposal.backendStatus, "completed");
  assert.ok(!("success" in outcome.completionProposal));
});

test("NativePiBackend fails closed on tools outside the candidate descriptor set", async () => {
  const loader = createTsModuleLoader({
    mocks: {
      [agentRunnerPath]: {
        async runAssistantWithTools(params) {
          const result = await params.executeToolCall({
            type: "toolCall",
            id: "mcp-1",
            name: "McpManager",
            arguments: { action: "list" },
          });
          assert.equal(result.isError, true);
          assert.equal(result.details.code, "candidate_tool_not_allowed");
          const assistant = { role: "assistant", content: [], timestamp: 2 };
          return { assistant, messages: [assistant], emittedMessages: [assistant] };
        },
      },
    },
  });
  const contracts = loader.loadModule("src/lib/execution/contracts.ts");
  const backendModule = loader.loadModule("src/lib/execution/nativePiBackend.ts");
  const runSpec = await contracts.sealRunSpec({
    taskId: "task-1",
    runId: "run-1",
    backendId: "native-pi",
    mode: "execute",
    workspace: {
      workspaceId: "workspace-1",
      parentRoot: "C:/repo",
      taskRoot: "C:/repo-worktree",
      baseRevision: "a".repeat(40),
    },
    capabilities: ["workspace.read"],
    validationPlan: { requiredChecks: [], commands: [] },
    candidatePolicy: { allowedOutputPaths: [] },
    createdAt: 1,
  });
  let submitted = 0;
  await backendModule.nativePiBackend.run({
    runSpec,
    request: {
      providerId: "codex",
      model: "test",
      runtime: { baseUrl: "https://example.test", apiKey: "test" },
      context: { systemPrompt: "", messages: [], tools: [] },
      workdir: "C:/repo-worktree",
      tools: [],
      onTextDelta() {},
    },
    async submitToolIntent() {
      submitted += 1;
      throw new Error("should not be called");
    },
  });
  assert.equal(submitted, 0);
});

test("NativePiBackend does not emit completion after its run was cancelled", async () => {
  const controller = new AbortController();
  const loader = createTsModuleLoader({
    mocks: {
      [agentRunnerPath]: {
        async runAssistantWithTools() {
          controller.abort(new Error("Cancelled"));
          const assistant = { role: "assistant", content: [], timestamp: 2 };
          return { assistant, messages: [assistant], emittedMessages: [assistant] };
        },
      },
    },
  });
  const contracts = loader.loadModule("src/lib/execution/contracts.ts");
  const backendModule = loader.loadModule("src/lib/execution/nativePiBackend.ts");
  const runSpec = await contracts.sealRunSpec({
    taskId: "task-1",
    runId: "run-1",
    backendId: "native-pi",
    mode: "execute",
    workspace: {
      workspaceId: "workspace-1",
      parentRoot: "C:/repo",
      taskRoot: "C:/repo-worktree",
      baseRevision: "a".repeat(40),
    },
    capabilities: ["workspace.read"],
    validationPlan: {
      requiredChecks: [
        "base_revision",
        "candidate_paths",
        "candidate_limits",
        "candidate_stability",
        "git_diff_check",
      ],
      commands: [],
    },
    candidatePolicy: { allowedOutputPaths: [] },
    createdAt: 1,
  });

  await assert.rejects(
    backendModule.nativePiBackend.run({
      runSpec,
      request: {
        providerId: "codex",
        model: "test",
        runtime: { baseUrl: "https://example.test", apiKey: "test" },
        context: { systemPrompt: "", messages: [], tools: [] },
        workdir: "C:/repo-worktree",
        tools: [],
        signal: controller.signal,
        onTextDelta() {},
      },
      async submitToolIntent() {
        throw new Error("not used");
      },
    }),
    /Cancelled/,
  );
});
