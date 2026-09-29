import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const copy = (value) => JSON.parse(JSON.stringify(value));

function response(command) {
  if (command === "memory_list") return { entries: [], quota: { used: 0, limit: 500 } };
  if (command === "memory_read") return {
    slug: "language", scope: "global", memoryType: "feedback", body: "中文", totalLines: 1,
    window: { offset: 0, length: 1 }, meta: {},
  };
  if (command === "memory_search") return { matches: [], historyMatches: [] };
  if (command === "memory_recent_rejections") return { entries: [] };
  if (command === "memory_today_local_date") return "2026-09-29";
  if (command === "memory_apply_batch") return { created: ["language"], updated: [], deleted: [], warnings: [] };
  if (command === "memory_index_overview") return { user: [], project: [], global: [], recentDays: [] };
  return { slug: "language", scope: "global", indexUpdated: true };
}

function harness(extraMocks = {}) {
  const calls = [];
  const loader = createTsModuleLoader({ mocks: {
    "@tauri-apps/api/core": { async invoke(command, args) {
      calls.push({ command, args: args === undefined ? undefined : copy(args) });
      return response(command === "memory_scoped" ? args.command : command);
    } },
    ...extraMocks,
  } });
  return { calls, loader, api: loader.loadModule("src/lib/memory/api.ts") };
}

test("ordinary desktop calls retain their original command and payload", async () => {
  const { api, calls } = harness();
  assert.equal(api.resolveMemoryAccessContext("local-chat"), undefined);
  assert.equal(api.resolveMemoryAccessContext("web-chat", { channel: "web" }), undefined);
  await api.memoryList({ workdir: "/repo" });
  await api.memoryWrite({ conversationId: "local-chat", slug: "language", scope: "global" });
  await api.memoryPathsInfo();
  assert.deepEqual(calls, [
    { command: "memory_list", args: { args: { workdir: "/repo" } } },
    { command: "memory_write", args: { args: { conversationId: "local-chat", slug: "language", scope: "global" } } },
    { command: "memory_paths_info", args: undefined },
  ]);
});

test("resumed WeCom chats and audit-bearing mutations cannot fall back to local memory", async () => {
  const { api, calls } = harness();
  const context = api.resolveMemoryAccessContext(" wecom:alice:session-2 ");
  assert.equal(context.conversationId, "wecom:alice:session-2");
  assert.equal(Object.isFrozen(context), true);
  assert.equal(api.resolveMemoryAccessContext("bound-chat", { channel: "wecom" }).conversationId, "bound-chat");
  assert.throws(() => api.resolveMemoryAccessContext("", { channel: "wecom" }), /binding/);
  await api.memoryWrite({ conversationId: "wecom:alice:session-2", slug: "language", scope: "global" });
  await api.memoryIndexOverview("/repo", context);
  assert.equal(calls[0].command, "memory_scoped");
  assert.deepEqual(calls[0].args.context, { conversationId: "wecom:alice:session-2" });
  assert.deepEqual(calls[1].args.args, { workdir: "/repo" });
  await assert.rejects(api.memoryList({}, { conversationId: " " }), /binding/);
  assert.equal(calls.length, 2, "invalid context must not invoke the unscoped command");
});

test("memory tools capture the parent context for every action, including read-only subagents", async () => {
  const { loader, calls } = harness();
  const { createMemoryTools } = loader.loadModule("src/lib/tools/memoryTools.ts");
  const input = { conversationId: "wecom:alice:session-1" };
  const bundle = createMemoryTools({ workdir: "/repo", conversationId: "child-run-id", memoryContext: input });
  input.conversationId = "wecom:bob:session-1";
  assert.equal(bundle.tools[0].parameters.properties.memoryContext, undefined);
  assert.equal(bundle.tools[0].parameters.properties.ownerId, undefined);
  for (const action of ["list", "read", "search", "write", "update", "delete", "accept"]) {
    const result = await bundle.executeToolCall({ id: action, name: "MemoryManager", type: "toolCall", arguments: {
      action, slug: "language", scope: "global", type: "feedback", query: "language",
      description: "回答语言", body: "中文", ownerId: "bob", memoryContext: input,
    } });
    assert.equal(result.isError, false, action);
  }
  const child = createMemoryTools({ workdir: "/child-worktree", conversationId: "other-child-id",
    memoryContext: { conversationId: "wecom:alice:session-1" }, mode: "ro" });
  await child.executeToolCall({ id: "child-read", name: "MemoryManager", arguments: { action: "list" } });
  assert.equal(calls.length, 8);
  assert.ok(calls.every((call) => call.command === "memory_scoped"));
  assert.ok(calls.every((call) => call.args.context.conversationId === "wecom:alice:session-1"));
  assert.ok(calls.every((call) => call.args.args.args.ownerId === undefined));
});

test("concurrent background extraction keeps candidates, tools and daily/batch writes in its captured context", async () => {
  let releaseAlice;
  const aliceGate = new Promise((resolve) => { releaseAlice = resolve; });
  const { loader, calls } = harness({
    [path.join(rootDir, "src/lib/chat/runner/agentRunner.ts")]: {
      async runAssistantWithTools(params) {
        if (params.sessionId.includes("wecom:alice")) await aliceGate;
        const read = await params.executeToolCall({ id: "lookup", name: "MemoryManager", arguments: {
          action: "search", query: "language", include_history: true,
        } });
        assert.equal(read.isError, false);
        await params.executeToolCall({ id: "plan", name: "SubmitMemoryPlan", arguments: { items: [
          { action: "write", slug: "language", scope: "global", type: "feedback", description: "回答语言",
            body: "默认中文", confidence: "high", source_quote: "以后默认用中文回答", reasoning: "explicit request" },
          { action: "append_daily", body: "用户确认了回答语言偏好。" },
        ] } });
        return { emittedMessages: [] };
      },
    },
  });
  const { runMemoryExtraction } = loader.loadModule("src/lib/chat/memory/extractionEngine.ts");
  const context = { conversationId: "wecom:alice:session-1" };
  const params = (id, memoryContext) => ({
    primary: { providerId: "openai", model: "test", runtime: { baseUrl: "x", apiKey: "y" } },
    sessionId: id, conversationId: id, memoryContext, workdir: "/same-project",
    messages: [{ role: "user", content: "请记住以后默认用中文回答", timestamp: Date.now() }],
    alreadyWrittenSlugs: [],
  });
  const alice = runMemoryExtraction(params("wecom:alice:session-1", context));
  context.conversationId = "wecom:bob:session-1";
  const bob = await runMemoryExtraction(params("wecom:bob:session-1"));
  assert.equal(bob.ok, true);
  releaseAlice();
  assert.equal((await alice).ok, true);
  assert.ok(calls.every((call) => call.command === "memory_scoped"));
  for (const user of ["alice", "bob"]) {
    const owned = calls.filter((call) => call.args.context.conversationId === `wecom:${user}:session-1`);
    assert.deepEqual(new Set(owned.map((call) => call.args.command)), new Set([
      "memory_today_local_date", "memory_list", "memory_recent_rejections", "memory_search", "memory_apply_batch",
    ]));
    const batch = owned.find((call) => call.args.command === "memory_apply_batch").args.args.args;
    assert.equal(batch.conversationId, `wecom:${user}:session-1`);
    assert.equal(batch.dailyAppend.bullet, "用户确认了回答语言偏好。");
  }
});

test("missing channel binding stops extraction without unscoped reads or model calls", async () => {
  const calls = [];
  let modelCalls = 0;
  const { loader } = harness({
    "@tauri-apps/api/core": { async invoke(command) { calls.push(command); throw new Error("binding missing"); } },
    [path.join(rootDir, "src/lib/chat/runner/agentRunner.ts")]: {
      async runAssistantWithTools() { modelCalls++; throw new Error("must not run"); },
    },
  });
  const { runMemoryExtraction } = loader.loadModule("src/lib/chat/memory/extractionEngine.ts");
  const result = await runMemoryExtraction({
    primary: { providerId: "openai", model: "test", runtime: {} },
    sessionId: "s", conversationId: "wecom:missing-binding", workdir: "/repo",
    messages: [{ role: "user", content: "请记住默认中文回答" }], alreadyWrittenSlugs: [],
  });
  assert.equal(result.ok, false);
  assert.equal(modelCalls, 0);
  assert.ok(calls.every((command) => command === "memory_scoped"));
});
