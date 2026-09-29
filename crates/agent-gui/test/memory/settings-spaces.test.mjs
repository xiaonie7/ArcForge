import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function hooks() {
  const slots = [];
  let index = 0;
  let effects = [];
  let dirty = false;
  let mounted = true;
  let component;
  let tree;
  const slot = (init) => slots[index++] ?? (slots[index - 1] = init());
  const changed = (a, b) => !a || a.length !== b.length || b.some((value, i) => !Object.is(value, a[i]));
  const react = {
    useState(initial) {
      const state = slot(() => ({ value: typeof initial === "function" ? initial() : initial }));
      state.set ??= (next) => {
        if (!mounted) return;
        const value = typeof next === "function" ? next(state.value) : next;
        if (!Object.is(value, state.value)) { state.value = value; dirty = true; }
      };
      return [state.value, state.set];
    },
    useRef(value) { return slot(() => ({ current: value })); },
    useMemo(compute, deps) {
      const state = slot(() => ({}));
      if (changed(state.deps, deps)) { state.value = compute(); state.deps = [...deps]; }
      return state.value;
    },
    useEffect(effect, deps) {
      const state = slot(() => ({}));
      if (changed(state.deps, deps)) {
        state.deps = [...deps];
        effects.push(() => { state.cleanup?.(); state.cleanup = effect(); });
      }
    },
  };
  function flush() {
    for (let count = 0; dirty; count++) {
      assert.ok(count < 30, "hooks must settle");
      index = 0; effects = []; dirty = false;
      tree = component();
      for (const effect of effects) effect();
    }
    return tree;
  }
  return {
    react, flush,
    render(render) { component = render; dirty = true; return flush(); },
    cleanup() { mounted = false; for (const state of slots) state.cleanup?.(); },
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const drain = () => new Promise((resolve) => setImmediate(resolve));
const elements = (node) => Array.isArray(node) ? node.flatMap(elements)
  : node && typeof node === "object" ? [node, ...elements(node.props?.children)] : [];
const t = (key) => key;
const spaces = [
  { spaceId: "a", conversationId: "wecom:a", label: "Alice", workdir: "E:/Alice" },
  { spaceId: "b", conversationId: "wecom:b", label: "Bob", workdir: "E:/Bob" },
];

test("space selector remounts drafts and history and uses the selected profile workdir", async () => {
  const h = hooks();
  const loader = createTsModuleLoader({ mocks: {
    react: h.react,
    "react-dom": { createPortal: (node) => node },
    "../../../i18n": { useLocale: () => ({ t }) },
    "../../../lib/memory/api": { memorySpacesList: async () => spaces, formatMemoryError: String },
    "./platform": { DrawerSelect: "space-select", Button: "button", RefreshCw: "refresh" },
    "./MemorySettingsDrawer": { MemorySettingsDrawer: "drawer" },
    "./useMemoryPanelData": {},
  } });
  const { MemoryPanel } = loader.loadModule("src/pages/settings/memory/MemoryPanel.tsx");
  try {
    h.render(() => MemoryPanel({ workdir: "E:/Desktop" }));
    await drain();
    let tree = h.flush();
    const pane = () => elements(tree).find((element) => element.type?.name === "ScopedMemoryPanel");
    const localKey = pane().key;
    elements(tree).find((element) => element.type === "space-select").props.onValueChange("a");
    tree = h.flush();
    const alice = pane();
    assert.notEqual(alice.key, localKey);
    assert.equal(alice.props.workdir, "E:/Alice");
    assert.deepEqual(alice.props.memoryContext, { conversationId: "wecom:a" });
    elements(tree).find((element) => element.type === "space-select").props.onValueChange("b");
    tree = h.flush();
    assert.notEqual(pane().key, alice.key);
    assert.equal(pane().props.workdir, "E:/Bob");
    assert.equal(alice.props.memoryContext.conversationId, "wecom:a", "an old review retains its original binding");
  } finally { h.cleanup(); }
});

test("late reads and saves from an unmounted space cannot populate the new space", async () => {
  const lateRead = deferred();
  const lateSave = deferred();
  const calls = [];
  let delayRead = false;
  const meta = { slug: "same-slug", scope: "global", memoryType: "user", description: "same" };
  const read = (name) => ({ ...meta, body: `body:${name}`, meta: {} });
  const api = {
    formatMemoryError: String,
    async memoryList(args, context) { calls.push(["list", context.conversationId, args.workdir]); return { entries: [meta], quota: { used: 1, limit: 500 } }; },
    async memoryPathsInfo(context) { return { root: context.conversationId }; },
    async memoryRead(args, context) {
      calls.push(["read", context.conversationId, args.workdir]);
      return delayRead && context.conversationId === "wecom:a" ? lateRead.promise : read(context.conversationId);
    },
    async memoryUpdate(args, context) { calls.push(["save", context.conversationId, args.workdir]); return lateSave.promise; },
  };
  function mount(space) {
    const h = hooks();
    const loader = createTsModuleLoader({ mocks: { react: h.react, "../../../lib/memory/api": api } });
    const { useMemoryPanelData } = loader.loadModule("src/pages/settings/memory/useMemoryPanelData.ts");
    const memoryContext = Object.freeze({ conversationId: space.conversationId });
    h.render(() => useMemoryPanelData({ workdir: space.workdir, memoryContext, t }));
    return h;
  }
  const alice = mount(spaces[0]);
  let bob;
  try {
    await drain();
    await alice.flush().openEntry(meta);
    const saving = alice.flush().saveSelected();
    delayRead = true;
    const reading = alice.flush().openEntry(meta);
    alice.cleanup();
    bob = mount(spaces[1]);
    await drain();
    await bob.flush().openEntry(meta);
    lateRead.resolve(read("wecom:a"));
    lateSave.resolve({ slug: "same-slug" });
    await Promise.all([saving, reading]);
    await drain();
    assert.equal(bob.flush().selected.body, "body:wecom:b");
    assert.equal(bob.flush().pathsInfo.root, "wecom:b");
    assert.deepEqual(calls.filter(([name]) => name === "save"), [["save", "wecom:a", "E:/Alice"]]);
    assert.ok(calls.every(([, context, workdir]) => workdir === (context === "wecom:a" ? "E:/Alice" : "E:/Bob")));
  } finally { alice.cleanup(); bob?.cleanup(); }
});

test("manual review applies and records its history in its original space", async () => {
  const h = hooks();
  const pending = deferred();
  const calls = [];
  const context = Object.freeze({ conversationId: "wecom:a" });
  const run = {
    runId: "same-run-id", trigger: "manual", status: "succeeded", reviewSkipped: 0,
    report: { version: 4, clusterSummaries: [], reviewItems: [], raw: [],
      safeDecisions: [{ op: "upsert", slug: "same-slug", body: "Alice", riskLevel: "low" }],
      manualApplyState: { status: "pending", appliedDecisionKeys: [], failedDecisionKeys: [] } },
  };
  const loader = createTsModuleLoader({ mocks: {
    react: h.react,
    "react-dom": { createPortal: (node) => node },
    "./platform": { Button: "button", DrawerSelect: "select" },
    "./useMemoryPanelData": { useOrganizeRunHistory: () => ({ runs: [run], selectedRun: run, setSelectedRun() {}, loading: false, error: null, setError() {}, async reload() {} }) },
    "../../../lib/memory/api": {
      formatMemoryError: String,
      async memoryApplyBatch(args, target) { calls.push(["apply", target.conversationId, args.workdir]); return pending.promise; },
      async memoryOrganizeRunUpdate(args, target) { calls.push(["history", target.conversationId, args.runId]); },
    },
  } });
  const { OrganizerHistoryModal } = loader.loadModule("src/pages/settings/memory/OrganizerHistoryModal.tsx");
  const previousDocument = globalThis.document;
  globalThis.document = { body: {} };
  try {
    const tree = h.render(() => OrganizerHistoryModal({ t, onClose() {}, workdir: "E:/Alice", memoryContext: context, spaceLabel: "Alice" }));
    const apply = elements(tree).find((element) => element.type === "button" && element.props.children?.includes?.("settings.memoryOrganizerApplySelected"));
    assert.ok(apply);
    const task = apply.props.onClick();
    h.cleanup();
    pending.resolve({ created: [], updated: ["same-slug"], deleted: [], warnings: [] });
    await task;
    assert.deepEqual(calls, [["apply", "wecom:a", "E:/Alice"], ["history", "wecom:a", "same-run-id"]]);
  } finally { h.cleanup(); globalThis.document = previousDocument; }
});

test("memory settings files stay byte-identical across desktop and gateway", () => {
  for (const name of ["MemoryPanel.tsx", "MemorySettingsDrawer.tsx", "OrganizerHistoryModal.tsx", "useMemoryPanelData.ts", "panelModel.ts"]) {
    assert.equal(fs.readFileSync(new URL(`../../src/pages/settings/memory/${name}`, import.meta.url), "utf8"),
      fs.readFileSync(new URL(`../../../agent-gateway/web/src/pages/settings/memory/${name}`, import.meta.url), "utf8"), name);
  }
});
