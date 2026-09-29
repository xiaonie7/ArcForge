import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

function harness() {
  const calls = [];
  const loader = createWebModuleLoader({
    rootDir: fileURLToPath(new URL("../", import.meta.url)),
    mocks: {
      "../lib/storage": { loadToken: () => "test-token" },
      "../lib/gatewaySocket": { getGatewayWebSocketClient: () => ({
        memoryManage: async (payload) => { calls.push(payload); return { ok: true }; },
      }) },
    },
  });
  return { invoke: loader.loadModule("src/shims/tauriCore.ts").invoke, calls };
}

test("scoped memory preserves owner context and nested original invocation over the gateway", async () => {
  const { invoke, calls } = harness();
  const payload = {
    context: { conversationId: "wecom:alice" },
    command: "memory_write",
    args: { args: { slug: "reply-style", scope: "global", body: "concise" } },
  };
  await invoke("memory_scoped", payload);
  assert.deepEqual(calls, [{ command: "memory_scoped", args: payload }]);
});

test("ordinary desktop memory keeps the existing gateway payload shape", async () => {
  const { invoke, calls } = harness();
  await invoke("memory_list", { args: { scope: "global" } });
  await invoke("memory_index_overview", { workdir: "E:/repo" });
  await invoke("memory_spaces_list");
  assert.deepEqual(calls, [
    { command: "memory_list", args: { scope: "global" } },
    { command: "memory_index_overview", args: { workdir: "E:/repo" } },
    { command: "memory_spaces_list", args: {} },
  ]);
});
