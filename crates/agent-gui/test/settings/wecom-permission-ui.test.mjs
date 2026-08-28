import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const fixtureLoader = createTsModuleLoader();
const { getDefaultSettings } = fixtureLoader.loadModule("src/lib/settings/index.ts");
const permissionHelpers = fixtureLoader.loadModule("src/lib/wecomPermissionProfile.ts");
const Button = "mock-button";
const t = (key) => key;

function settings(botId) {
  const defaults = getDefaultSettings();
  return {
    ...defaults,
    wecom: {
      ...defaults.wecom,
      enabled: true,
      gatewayMode: "local",
      botId,
      tenantId: "tenant-1",
      connectorId: "connector-1",
      secretConfigured: true,
    },
  };
}

function installationDefault(settings, followsDesktop = false) {
  const input = permissionHelpers.buildWecomInstallationDefaultInput(settings);
  return {
    profile: {
      id: `${settings.wecom.botId}-profile`,
      name: input.name,
      revision: 2,
      policy: input.policy,
      policyHash: `${settings.wecom.botId}-hash-2`,
      enabled: true,
      createdAt: 1,
      updatedAt: 2,
    },
    binding: {
      id: `${settings.wecom.botId}-binding`,
      installationId: input.installationId,
      principalType: "installation",
      principalId: "*",
      profileId: `${settings.wecom.botId}-profile`,
      profileRevision: 2,
      updatedAt: 2,
    },
    followsDesktop,
    profileCurrentRevision: 2,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function createHookHarness() {
  const slots = [];
  let index = 0;
  let effects = [];
  let dirty = false;
  let renderComponent;
  let tree;

  function slot(kind, initialize) {
    const nextIndex = index++;
    slots[nextIndex] ??= { kind, ...initialize() };
    assert.equal(slots[nextIndex].kind, kind, "hook order must stay stable");
    return slots[nextIndex];
  }

  function changed(previous, next) {
    return !previous || previous.length !== next.length ||
      next.some((value, i) => !Object.is(previous[i], value));
  }

  const react = {
    useState(initialValue) {
      const state = slot("state", () => ({
        value: typeof initialValue === "function" ? initialValue() : initialValue,
      }));
      state.setValue ??= (next) => {
        const value = typeof next === "function" ? next(state.value) : next;
        if (Object.is(value, state.value)) return;
        state.value = value;
        dirty = true;
      };
      return [state.value, state.setValue];
    },
    useRef(initialValue) {
      return slot("ref", () => ({ value: { current: initialValue } })).value;
    },
    useMemo(compute, deps) {
      const memo = slot("memo", () => ({}));
      if (changed(memo.deps, deps)) {
        memo.value = compute();
        memo.deps = [...deps];
      }
      return memo.value;
    },
    useCallback(callback, deps) {
      return react.useMemo(() => callback, deps);
    },
    useEffect(effect, deps) {
      const state = slot("effect", () => ({}));
      if (!changed(state.deps, deps)) return;
      state.deps = [...deps];
      effects.push(() => {
        state.cleanup?.();
        state.cleanup = effect();
      });
    },
  };

  function flush() {
    let renders = 0;
    while (dirty) {
      assert.ok(++renders < 50, "component state updates must settle");
      dirty = false;
      index = 0;
      effects = [];
      tree = renderComponent();
      const committedEffects = effects;
      effects = [];
      for (const effect of committedEffects) effect();
    }
    return tree;
  }

  return {
    react,
    flush,
    render(component) {
      renderComponent = component;
      dirty = true;
      return flush();
    },
    cleanup() {
      for (const state of slots) state.cleanup?.();
    },
  };
}

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object") return [];
  return [node, ...elements(node.props?.children)];
}

function textContent(node) {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textContent).join("");
  return node && typeof node === "object" ? textContent(node.props?.children) : "";
}

function followButton(tree) {
  const button = elements(tree).find(
    (node) => node.type === Button &&
      textContent(node).includes("settings.wecomFollowDesktop"),
  );
  assert.ok(button, "the manual installation default must expose an explicit follow button");
  return button;
}

async function settle(harness) {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    harness.flush();
  }
  return harness.flush();
}

function createSectionHarness(ensure) {
  const hookHarness = createHookHarness();
  const ensureCalls = [];
  const adoptionCalls = [];
  const iconNames = [
    "Activity", "Bot", "Check", "Cloud", "Copy", "Eye", "EyeOff", "FileText", "Key",
    "Loader2", "MessageSquare", "RefreshCw", "Save", "Send", "Server", "Shield",
    "Terminal", "Trash2",
  ];
  const icons = Object.fromEntries(iconNames.map((name) => [name, `icon-${name}`]));
  const loader = createTsModuleLoader({
    mocks: {
      react: hookHarness.react,
      "@tauri-apps/api/core": {
        async invoke(command) {
          assert.equal(command, "wecom_runtime_status");
          return { mode: "local", overall: "stopped", gatewayState: "stopped", connectorState: "stopped" };
        },
      },
      "@tauri-apps/api/event": { async listen() { return () => {}; } },
      "../../components/icons": icons,
      "../../components/ui/button": { Button },
      "../../components/ui/input": { Input: "mock-input" },
      "../../components/ui/textarea": { Textarea: "mock-textarea" },
      "../../i18n": { useLocale() { return { t }; } },
      "./shared": { AgentActivationSwitch: "mock-activation-switch" },
      "../../lib/wecomPermissionProfile": {
        ...permissionHelpers,
        ensureWecomInstallationDefault(current) {
          ensureCalls.push(current.wecom.botId);
          return ensure(current);
        },
        async adoptWecomInstallationDefault(current, existing) {
          adoptionCalls.push({ settings: current, existing });
          return installationDefault(current, true);
        },
      },
    },
  });
  const { WecomSection } = loader.loadModule("src/pages/settings/WecomSection.tsx");
  const setSettings = () => { throw new Error("permission reads must not update settings"); };
  const onOpenRemote = () => {};
  return {
    ...hookHarness,
    ensureCalls,
    adoptionCalls,
    renderSettings(current) {
      return hookHarness.render(() => WecomSection({ settings: current, setSettings, onOpenRemote }));
    },
  };
}

test("returning to loaded WeCom A while B is pending clears the follow button loading state", async () => {
  const a = settings("bot-a");
  const b = settings("bot-b");
  const waitingForB = deferred();
  const harness = createSectionHarness(async (current) => {
    if (current.wecom.botId === "bot-b") return waitingForB.promise;
    return installationDefault(current);
  });
  try {
    harness.renderSettings(a);
    const loaded = followButton(await settle(harness));
    assert.equal(loaded.props.disabled, false);

    const pending = followButton(harness.renderSettings(b));
    assert.equal(pending.props.disabled, true);
    assert.ok(elements(pending).some((node) => node.type === "icon-Loader2"));

    const restored = followButton(harness.renderSettings(a));
    assert.equal(restored.props.disabled, false, "returning to A must cancel B's loading indicator");
    assert.equal(elements(restored).some((node) => node.type === "icon-Loader2"), false);

    waitingForB.resolve(installationDefault(b));
    const settled = followButton(await settle(harness));
    assert.equal(settled.props.disabled, false, "B's late response must not replace A's snapshot");
    assert.deepEqual(harness.ensureCalls, ["bot-a", "bot-b"]);
    assert.deepEqual(harness.adoptionCalls, []);
  } finally {
    waitingForB.resolve(installationDefault(b));
    await settle(harness);
    harness.cleanup();
  }
});

test("WeCom identity changes hide the old CAS snapshot until explicit adoption of the new one", async () => {
  const a = settings("bot-a");
  const b = settings("bot-b");
  const waitingForB = deferred();
  const harness = createSectionHarness(async (current) => {
    if (current.wecom.botId === "bot-b") return waitingForB.promise;
    return installationDefault(current);
  });
  try {
    harness.renderSettings(a);
    await settle(harness);
    assert.equal(followButton(harness.renderSettings(b)).props.disabled, true);
    assert.deepEqual(harness.adoptionCalls, [], "switching identity must not adopt permissions");

    const existingB = installationDefault(b);
    waitingForB.resolve(existingB);
    const button = followButton(await settle(harness));
    assert.equal(button.props.disabled, false);
    assert.deepEqual(harness.adoptionCalls, []);
    button.props.onClick();
    await settle(harness);

    assert.equal(harness.adoptionCalls.length, 1);
    assert.equal(harness.adoptionCalls[0].settings.wecom.botId, "bot-b");
    assert.equal(harness.adoptionCalls[0].existing, existingB);
    assert.equal(
      harness.adoptionCalls[0].existing.binding.installationId,
      permissionHelpers.buildWecomInstallationDefaultInput(b).installationId,
    );
  } finally {
    waitingForB.resolve(installationDefault(b));
    await settle(harness);
    harness.cleanup();
  }
});
