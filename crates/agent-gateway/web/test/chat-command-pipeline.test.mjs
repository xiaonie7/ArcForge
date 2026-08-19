import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});

const { ChatCommandPipeline } = loader.loadModule(
  "src/lib/chat/stream/chatCommandPipeline.ts",
);
const { normalizeCommandUpdate } = loader.loadModule("src/lib/chat/stream/streamTypes.ts");

function createTranscriptHarness() {
  const calls = [];
  return {
    calls,
    store: {
      addOptimisticUserEntry(input) {
        calls.push(["add", input.clientRequestId]);
      },
      removeOptimisticUserEntry(clientRequestId) {
        calls.push(["remove", clientRequestId]);
      },
      appendLocalError(message) {
        calls.push(["error", message]);
      },
      restoreEditResendTranscript(clientRequestId) {
        calls.push(["restore", clientRequestId]);
      },
      applyEvent(event) {
        calls.push(["event", event.type, event.run_id, event.text ?? null]);
      },
    },
  };
}

test("command update normalization accepts durable terminal phases", () => {
  assert.deepEqual(
    normalizeCommandUpdate({
      run_id: "run-1",
      client_request_id: "client-1",
      conversation_id: "conversation-1",
      phase: "completed",
      message: "durable answer",
      run_started: true,
    }),
    {
      runId: "run-1",
      clientRequestId: "client-1",
      conversationId: "conversation-1",
      phase: "completed",
      errorCode: null,
      message: "durable answer",
      runStarted: true,
    },
  );
  assert.equal(
    normalizeCommandUpdate({ run_id: "run-1", phase: "not-a-terminal-state" }),
    null,
  );
});

test("completed replay before ACK settles and rebinds the pending command", async () => {
  const transcript = createTranscriptHarness();
  const bound = [];
  const completed = [];
  let resolveAck;
  const pipeline = new ChatCommandPipeline({
    getTranscriptStore: () => transcript.store,
    onBound: (update, pending) => bound.push([update.conversationId, pending.conversationId]),
    onCompleted: (update, pending) => completed.push([update.message, pending.conversationId]),
  });

  const outcomePromise = pipeline.submit({
    conversationId: "draft-1",
    clientRequestId: "client-1",
    message: "hello",
    submit: () =>
      new Promise((resolve) => {
        resolveAck = resolve;
      }),
  });
  pipeline.handleCommandUpdate({
    runId: "run-1",
    clientRequestId: "client-1",
    conversationId: "conversation-1",
    phase: "completed",
    errorCode: null,
    message: "durable answer",
  });
  resolveAck({ runId: "run-1", conversationId: "conversation-1", acceptedSeq: 9 });

  assert.deepEqual(await outcomePromise, { kind: "settled" });
  assert.equal(pipeline.hasPending("draft-1"), false);
  assert.equal(pipeline.hasPending("conversation-1"), false);
  assert.deepEqual(bound, [["conversation-1", "conversation-1"]]);
  assert.deepEqual(completed, [["durable answer", "conversation-1"]]);
  assert.deepEqual(transcript.calls, [
    ["add", "client-1"],
    ["event", "run_started", "run-1", null],
    ["event", "token", "run-1", "durable answer"],
    ["event", "run_finished", "run-1", null],
  ]);
});

test("terminal update for a started run never compensates away the prompt", async () => {
  const transcript = createTranscriptHarness();
  const failures = [];
  const pipeline = new ChatCommandPipeline({
    getTranscriptStore: () => transcript.store,
    onFailed: (pending, errorCode, message) =>
      failures.push([pending.clientRequestId, errorCode, message]),
  });
  await pipeline.submit({
    conversationId: "conversation-1",
    clientRequestId: "client-1",
    message: "hello",
    submit: async () => ({ runId: "run-1", conversationId: "conversation-1", acceptedSeq: 1 }),
  });
  pipeline.handleCommandUpdate({
    runId: "run-1",
    clientRequestId: "client-1",
    conversationId: "conversation-1",
    phase: "failed",
    errorCode: "runtime_error",
    message: "run failed",
    runStarted: true,
  });
  assert.deepEqual(transcript.calls, [["add", "client-1"]]);
  assert.deepEqual(failures, [["client-1", "runtime_error", "run failed"]]);
  assert.equal(pipeline.hasPending("conversation-1"), false);
});

test("unknown replay fails immediately with the durable restart reason", async () => {
  const transcript = createTranscriptHarness();
  let resolveAck;
  const failures = [];
  const pipeline = new ChatCommandPipeline({
    getTranscriptStore: () => transcript.store,
    onFailed: (pending, errorCode, message) =>
      failures.push([pending.conversationId, errorCode, message]),
  });

  const outcomePromise = pipeline.submit({
    conversationId: "conversation-1",
    clientRequestId: "client-1",
    message: "hello",
    submit: () =>
      new Promise((resolve) => {
        resolveAck = resolve;
      }),
  });
  pipeline.handleCommandUpdate({
    runId: "run-1",
    clientRequestId: "client-1",
    conversationId: "conversation-1",
    phase: "unknown",
    errorCode: "gateway_restart",
    message: "Gateway restarted before completion.",
  });
  resolveAck({ runId: "run-1", conversationId: "conversation-1", acceptedSeq: 9 });

  assert.deepEqual(await outcomePromise, {
    kind: "failed",
    errorCode: "gateway_restart",
    message: "Gateway restarted before completion.",
  });
  assert.deepEqual(failures, [
    ["conversation-1", "gateway_restart", "Gateway restarted before completion."],
  ]);
  assert.deepEqual(transcript.calls, [
    ["add", "client-1"],
    ["remove", "client-1"],
    ["error", "Gateway restarted before completion."],
  ]);
});
