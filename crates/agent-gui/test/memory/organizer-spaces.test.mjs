import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const fixtures = createTsModuleLoader();
const pipeline = fixtures.loadModule("src/lib/memory/organizer/pipeline.ts");
const settingsModule = fixtures.loadModule("src/lib/settings/index.ts");
const { getDefaultSettings } = settingsModule;
const spaces = [
  { spaceId: "a", conversationId: "wecom:a", label: "Alice", workdir: "E:/Alice" },
  { spaceId: "b", conversationId: "wecom:b", label: "Bob", workdir: "E:/Bob" },
];
const spaceKey = (context) => context?.conversationId ?? "local";
const workdirs = { local: "E:/Desktop", "wecom:a": "E:/Alice", "wecom:b": "E:/Bob" };
const settle = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("organizer did not settle");
};

function harness({ scheduled = true, listFails = false, blockFirst = false } = {}) {
  let settings = getDefaultSettings();
  settings = {
    ...settings,
    system: { ...settings.system, workdir: workdirs.local },
    memory: {
      ...settings.memory,
      organizerEnabled: scheduled,
      organizerSchedule: { ...settings.memory.organizerSchedule, frequency: scheduled ? "daily" : "none" },
      organizerNextRunAt: scheduled ? Date.now() - 1000 : undefined,
      organizerModel: { customProviderId: "p", model: "model" },
      organizerScope: "all",
    },
    customProviders: [{ id: "p", name: "P", type: "openai-compatible", baseUrl: "https://example.test", apiKey: "test" }],
  };
  const calls = [];
  const claims = [];
  const finished = [];
  const prompts = [];
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  let first = true;
  let settingsUpdates = 0;
  function record(name, args, context) {
    const key = spaceKey(context);
    calls.push({ name, args, key });
    if (args?.workdir !== undefined) assert.equal(args.workdir, workdirs[key], `${name} must use the space profile workdir`);
  }
  const api = {
    async memorySpacesList() { if (listFails) throw new Error("space listing unavailable"); return spaces; },
    async memoryOrganizeDueClaim(args, context) {
      record("claim", args, context);
      claims.push({ args, key: spaceKey(context) });
      return { run: { runId: "same-run-id", trigger: args.enabled ? "scheduled" : "manual", status: "running", scope: "all", mode: "standard" } };
    },
    async memoryList(args, context) {
      record("list", args, context);
      return { entries: [{ slug: "same-slug", scope: "global", memoryType: "user", description: spaceKey(context), unreviewed: true }], truncated: false };
    },
    async memoryRead(args, context) { record("read", args, context); return { body: `secret:${spaceKey(context)}` }; },
    async memoryQuotaSummary(args, context) { record("quota", args, context); return { scopes: [] }; },
    async memoryOrganizeRunUpdate(args, context) { record("update", args, context); },
    async memoryOrganizeDueComplete(args, context) { record("complete", args, context); finished.push(spaceKey(context)); },
    async memoryApplyBatch(args, context) {
      record("apply", args, context);
      assert.equal(args.decisions[0].body, `secret:${spaceKey(context)}`);
      return { created: [], updated: ["same-slug"], deleted: [], warnings: [] };
    },
  };
  const loader = createTsModuleLoader({ mocks: {
    "../api": api,
    "../../settings": { ...settingsModule, findProviderModelConfig() { return undefined; } },
    "../../debug/agentDebug": { createStreamDebugLogger() {} },
    "../../providers/llm": { assistantMessageToText() { return ""; } },
    "../../chat/runner/agentRunner": {
      async runAssistantWithTools(params) {
        prompts.push(params.context.messages[0].content);
        if (blockFirst && first) { first = false; await barrier; }
        await params.executeToolCall({ id: "read", name: "MemoryManager", arguments: {} });
        await params.executeToolCall({ id: "plan", name: "SubmitMemoryOrganizePlan", arguments: { summary: "done", decisions: [] } });
        return { emittedMessages: [], assistant: {} };
      },
    },
    "../../tools/memoryTools": {
      createMemoryTools(params) {
        record("tools", { workdir: params.workdir }, params.memoryContext);
        assert.equal(params.mode, "ro");
        return { tools: [], async executeToolCall() { return { role: "toolResult", content: [] }; } };
      },
    },
    "./pipeline": {
      ...pipeline,
      buildDecisions(results) {
        const entries = results.flatMap((result) => result.cluster.entries);
        assert.equal(entries.length, 1, "clusters must never combine different spaces");
        return { decisions: [{ op: "upsert", slug: "same-slug", body: entries[0].body }], reviewSkipped: 0, mergedCount: 0, rejectionBuckets: {}, reviewItems: [] };
      },
    },
  } });
  const { createMemoryOrganizerService } = loader.loadModule("src/lib/memory/organizer/service.ts");
  const service = createMemoryOrganizerService({
    getSettings: () => settings,
    setSettings: (updater) => { settings = updater(settings); settingsUpdates++; },
  });
  return { service, calls, claims, finished, prompts, release, settingsUpdates: () => settingsUpdates };
}

test("scheduled organizer keeps scans, RO tools, quotas, writes and run history in each space", async () => {
  const h = harness();
  try {
    h.service.configure();
    await settle(() => h.finished.length === 3 && h.settingsUpdates() === 1);
    assert.deepEqual(h.claims.map((item) => item.key), ["local", "wecom:a", "wecom:b"]);
    assert.equal(new Set(h.claims.map((item) => item.args.dueAt)).size, 1);
    for (const key of ["local", "wecom:a", "wecom:b"]) {
      assert.deepEqual(new Set(h.calls.filter((call) => call.key === key).map((call) => call.name)),
        new Set(["claim", "list", "read", "quota", "tools", "update", "apply", "complete"]));
    }
    for (let index = 0; index < 3; index++) {
      const key = ["local", "wecom:a", "wecom:b"][index];
      assert.ok(h.prompts[index].includes(`secret:${key}`));
      for (const other of ["local", "wecom:a", "wecom:b"].filter((item) => item !== key)) {
        assert.ok(!h.prompts[index].includes(`secret:${other}`));
      }
    }
  } finally { h.service.dispose(); }
});

test("manual organizer queues a second space and snapshots the original context", async () => {
  const h = harness({ scheduled: false, blockFirst: true });
  try {
    const context = { conversationId: "wecom:a" };
    h.service.poke(context);
    context.conversationId = "wecom:b";
    await settle(() => h.prompts.length === 1);
    h.service.poke({ conversationId: "wecom:b" });
    h.release();
    await settle(() => h.finished.length === 2);
    assert.deepEqual(h.claims.map((item) => item.key), ["wecom:a", "wecom:b"]);
    assert.ok(h.claims.every((claim) => claim.args.enabled === false));
    assert.equal(h.settingsUpdates(), 0);
    assert.equal(h.calls.filter((call) => call.name === "apply").length, 0, "manual runs only create review plans");
    const completions = h.calls.filter((call) => call.name === "complete");
    assert.deepEqual(completions.map((call) => call.args.report.safeDecisions[0].body), ["secret:wecom:a", "secret:wecom:b"]);
  } finally { h.service.dispose(); }
});

test("space enumeration failure preserves the local scheduled organizer", async () => {
  const h = harness({ listFails: true });
  try {
    h.service.configure();
    await settle(() => h.finished.length === 1 && h.settingsUpdates() === 1);
    assert.deepEqual(h.claims.map((item) => item.key), ["local"]);
  } finally { h.service.dispose(); }
});
