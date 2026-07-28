import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const broker = loader.loadModule("src/lib/execution/broker.ts");

function proposal(overrides = {}) {
  return {
    schemaVersion: 1,
    protocolVersion: "1.0",
    taskId: "task-1",
    runId: "run-1",
    runSpecHash: "a".repeat(64),
    workspaceId: "workspace-1",
    sourceSequence: 1,
    toolCallId: "tool-1",
    toolName: "Write",
    effect: "workspace_draft_mutation",
    arguments: { path: "src/app.ts", content: "next" },
    submittedAt: 1,
    ...overrides,
  };
}

test("brokered submitter authorizes before dispatching the reconstructed tool call", async () => {
  const calls = [];
  const submit = broker.createBrokeredToolIntentSubmitter({
    capabilities: ["workspace.write"],
    async authorize(intent) {
      calls.push(["authorize", intent.toolCallId]);
      return { authorized: true, authorizationId: "grant-1", isolationLevel: "workspace_only" };
    },
    async executeToolCall(toolCall) {
      calls.push(["execute", toolCall.id, toolCall.name, toolCall.arguments.path]);
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "done" }],
        details: {},
        isError: false,
        timestamp: 1,
      };
    },
  });
  const result = await submit(proposal());
  assert.equal(result.isError, false);
  assert.deepEqual(calls, [
    ["authorize", "tool-1"],
    ["execute", "tool-1", "Write", "src/app.ts"],
  ]);
});

test("brokered submitter denies missing capability and broker rejection without execution", async () => {
  let executions = 0;
  const missingCapability = broker.createBrokeredToolIntentSubmitter({
    capabilities: ["workspace.read"],
    async authorize() {
      throw new Error("must not authorize");
    },
    async executeToolCall() {
      executions += 1;
    },
  });
  await assert.rejects(missingCapability(proposal()), /missing capability workspace\.write/);

  const rejected = broker.createBrokeredToolIntentSubmitter({
    capabilities: ["workspace.write"],
    async authorize() {
      return { authorized: false, reason: "path escaped" };
    },
    async executeToolCall() {
      executions += 1;
    },
  });
  const second = await rejected(proposal());
  assert.equal(second.isError, true);
  assert.equal(second.details.code, "broker_denied");
  assert.equal(executions, 0);
});

test("cancellation while authorization is pending never reaches the executor", async () => {
  const controller = new AbortController();
  let executions = 0;
  const submit = broker.createBrokeredToolIntentSubmitter({
    capabilities: ["workspace.write"],
    async authorize() {
      controller.abort(new Error("Cancelled"));
      return { authorized: true, authorizationId: "late-grant" };
    },
    async executeToolCall() {
      executions += 1;
    },
  });

  await assert.rejects(submit(proposal(), controller.signal), /Cancelled/);
  assert.equal(executions, 0);
});
