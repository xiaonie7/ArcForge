import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(
  here,
  "../../src/lib/conversationArchive/admission.ts",
);

function loadAdmission(invoke = async () => undefined) {
  return createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": { invoke },
    },
  }).loadModule(modulePath);
}

test("editing protection is explicitly acquired and released by one renderer owner", async () => {
  const calls = [];
  const { setConversationEditing } = loadAdmission(async (command, args) => {
    calls.push([command, args.input.conversationId, args.input.editing, args.input.token]);
  });

  await setConversationEditing(" conversation-1 ", true);
  await setConversationEditing("conversation-1", false);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.slice(0, 3)), [
    ["conversation_lifecycle_editing", "conversation-1", true],
    ["conversation_lifecycle_editing", "conversation-1", false],
  ]);
  assert.match(calls[0][3], /^editing:[^:]+:conversation-1$/);
  assert.equal(calls[0][3], calls[1][3]);
});

test("a queued admission transfers to running and releases only after an accepted turn", async () => {
  const { withConversationAdmission } = loadAdmission();
  const calls = [];
  const accepted = await withConversationAdmission(
    { conversationId: "c1", token: "queue:q1", originSourceId: "desktop", queued: true },
    async () => {
      calls.push(["run"]);
      return true;
    },
    {
      admit: async (input) => calls.push(["admit", input.phase, input.token]),
      release: async (token, finished) => calls.push(["release", token, finished]),
      onReleaseError: assert.fail,
    },
  );
  assert.equal(accepted, true);
  assert.deepEqual(calls, [
    ["admit", "running", "queue:q1"],
    ["run"],
    ["release", "queue:q1", true],
  ]);
});

test("a rejected queued turn restores queued protection instead of releasing it", async () => {
  const { withConversationAdmission } = loadAdmission();
  const phases = [];
  const accepted = await withConversationAdmission(
    { conversationId: "c1", token: "queue:q1", originSourceId: "web", queued: true },
    async () => false,
    {
      admit: async (input) => phases.push(input.phase),
      release: async () => assert.fail("rejected queue item must stay admitted"),
      onReleaseError: assert.fail,
    },
  );
  assert.equal(accepted, false);
  assert.deepEqual(phases, ["running", "queued"]);
});

test("settlement acknowledgement failure never asks the caller to replay an executed turn", async () => {
  const { withConversationAdmission } = loadAdmission();
  const errors = [];
  const accepted = await withConversationAdmission(
    { conversationId: "c1", token: "turn:t1", originSourceId: "desktop", queued: false },
    async () => true,
    {
      admit: async () => undefined,
      release: async () => {
        throw new Error("IPC reply lost");
      },
      onReleaseError: (error) => errors.push(String(error.message)),
    },
  );
  assert.equal(accepted, true);
  assert.deepEqual(errors, ["IPC reply lost"]);
});
