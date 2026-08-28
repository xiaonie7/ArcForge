import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function createHookHarness() {
  const refs = [];
  const effects = [];
  let refIndex = 0;
  let effectIndex = 0;

  const react = {
    useRef(initialValue) {
      const index = refIndex++;
      refs[index] ??= { current: initialValue };
      return refs[index];
    },
    useEffect(effect, deps) {
      const index = effectIndex++;
      const previous = effects[index];
      const changed =
        !previous ||
        deps.length !== previous.deps.length ||
        deps.some((value, depIndex) => value !== previous.deps[depIndex]);
      if (!changed) return;
      previous?.cleanup?.();
      effects[index] = { deps: [...deps], cleanup: effect() };
    },
  };

  return {
    react,
    render(run) {
      refIndex = 0;
      effectIndex = 0;
      run();
    },
    cleanup() {
      for (const effect of effects) {
        effect?.cleanup?.();
      }
    },
  };
}

function createEventTarget() {
  const handlers = new Map();
  return {
    handlers,
    addEventListener(name, handler) {
      const set = handlers.get(name) ?? new Set();
      set.add(handler);
      handlers.set(name, set);
    },
    removeEventListener(name, handler) {
      handlers.get(name)?.delete(handler);
    },
  };
}

async function flushPromises() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function trustedCommandOrigin(command, requestId) {
  return {
    channel: "wecom",
    tenantId: "tenant-1",
    botId: "bot-1",
    externalUserId: "user-1",
    chatId: "",
    chatType: "direct",
    externalMessageId: `message-${command}`,
    connectorId: "connector-1",
    channelSessionId: "session-1",
    channelCommand: command,
    requestId,
    authTime: 1_700_000_000,
  };
}

function claimedCommand(command) {
  const requestId = `request-${command}`;
  return {
    requestId,
    clientRequestId: `client-${command}`,
    conversationId: "untrusted-conversation",
    state: "claimed",
    attempt: 1,
    leaseMs: 30_000,
    request: {
      requestId,
      conversationId: "untrusted-conversation",
      message: "",
      uploadedFiles: [],
      queuePolicy: "append",
      origin: trustedCommandOrigin(command, requestId),
    },
  };
}

function channelPermissionProfile(overrides = {}) {
  return {
    id: "profile-1",
    name: "WeCom default",
    revision: 2,
    policy: {
      executionMode: "tools",
      allowedSkills: ["review"],
      allowedSystemTools: ["search"],
      allowedMcpServers: ["docs"],
      memoryEnabled: false,
    },
    policyHash: "hash-2",
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function installBrowserGlobals() {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  let nextTimerId = 1;
  const timers = new Map();
  globalThis.window = {
    ...createEventTarget(),
    setInterval(callback) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    setTimeout,
    clearTimeout,
  };
  globalThis.document = {
    ...createEventTarget(),
    visibilityState: "visible",
  };
  return () => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  };
}

function createCommandListenerLoader(
  hookHarness,
  invoke,
  resolveEffectiveProfile = async () => channelPermissionProfile(),
  principalContext,
  resolveWecomProfile,
) {
  const mocks = {
    react: hookHarness.react,
    "@tauri-apps/api/core": { invoke },
    "@tauri-apps/api/event": {
      async listen() {
        return () => {};
      },
    },
    "../../../lib/wecomPermissionProfile": {
      resolveWecomPermissionProfile(settings, principal, conversationId) {
        if (resolveWecomProfile) return resolveWecomProfile(settings, principal, conversationId);
        return resolveEffectiveProfile({
          installationId: principal.installationId,
          userId: principal.externalUserId,
          conversationId,
        });
      },
    },
    "../../../lib/settings": {
      normalizeChatRuntimeControls(value) {
        return value;
      },
      normalizeSystemToolSelection(value) {
        return Array.isArray(value) ? value : [];
      },
    },
  };
  if (principalContext) {
    mocks["../../../lib/security/principalContext"] = principalContext;
  }
  return createTsModuleLoader({
    mocks,
  });
}

for (const syncFails of [false, true]) {
  test(`trusted requests ${syncFails ? "fail closed when desktop sync fails" : "wait for desktop sync before queueing"}`, async () => {
    const restoreGlobals = installBrowserGlobals();
    const hookHarness = createHookHarness();
    const calls = [];
    const queued = [];
    const settings = { skills: { enabled: true, selected: ["current-skill"] } };
    let claim = claimedCommand("compact");
    let finishSync;
    const sync = new Promise((resolve, reject) => {
      finishSync = () => (syncFails ? reject(new Error("desktop sync failed")) : resolve());
    });
    let syncStarted = false;
    try {
      const loader = createCommandListenerLoader(
        hookHarness,
        async (command, payload) => {
          calls.push({ command, payload });
          if (command === "gateway_chat_claim_next") {
            const result = claim;
            claim = null;
            return result;
          }
          return undefined;
        },
        undefined,
        undefined,
        async (currentSettings, principal) => {
          assert.equal(currentSettings, settings);
          assert.equal(principal.externalUserId, "user-1");
          syncStarted = true;
          await sync;
          return channelPermissionProfile({
            policy: { executionMode: "tools", allowedSkills: ["current-skill"] },
          });
        },
      );
      const { useGatewayBridgeListeners } = loader.loadModule(
        "src/pages/chat/gateway/useGatewayBridgeListeners.ts",
      );
      hookHarness.render(() =>
        useGatewayBridgeListeners({
          settings,
          allowWecomGroupMessages: true,
          currentConversationIdRef: { current: "local-conversation" },
          conversationRuntimeCacheRef: { current: new Map() },
          ensureGatewayBridgeConversationReadyRef: { current: async (id) => id },
          sendActionRef: { current: async () => false },
          queueGatewayBridgeEventForRequest() {},
          shouldQueueGatewayChatRequest() {
            return true;
          },
          async enqueueGatewayChatRequest(...args) {
            queued.push(args);
            return true;
          },
          isConversationRunning() {
            return false;
          },
          getConversationAbortController() {
            return null;
          },
        }),
      );
      await waitFor(() => syncStarted, "desktop sync did not start");
      assert.equal(queued.length, 0);
      assert.equal(calls.some((call) => call.command === "gateway_chat_mark_started"), false);
      finishSync();
      const finalCommand = syncFails ? "gateway_chat_fail" : "gateway_chat_mark_queued_in_gui";
      await waitFor(() => calls.some((call) => call.command === finalCommand), finalCommand);
      if (syncFails) {
        assert.equal(queued.length, 0);
        assert.equal(calls.some((call) => call.command === "gateway_chat_mark_started"), false);
      } else {
        assert.deepEqual(queued[0][3].policy.allowedSkills, ["current-skill"]);
        assert.ok(Object.isFrozen(queued[0][3].policy.allowedSkills));
      }
    } finally {
      finishSync();
      hookHarness.cleanup();
      restoreGlobals();
    }
  });
}

test("gateway bridge listener keeps one worker across renders and handles native wake immediately", async () => {
  const hookHarness = createHookHarness();
  const invokeCalls = [];
  const registrations = [];
  const windowEvents = createEventTarget();
  const documentEvents = createEventTarget();
  let nextTimerId = 1;
  const timers = new Map();

  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    ...windowEvents,
    setInterval(callback) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    setTimeout,
    clearTimeout,
  };
  globalThis.document = {
    ...documentEvents,
    visibilityState: "visible",
  };

  try {
    const loader = createTsModuleLoader({
      mocks: {
        react: hookHarness.react,
        "@tauri-apps/api/core": {
          async invoke(command, payload) {
            invokeCalls.push({ command, payload });
            if (command === "gateway_chat_claim_next") return null;
            return undefined;
          },
        },
        "@tauri-apps/api/event": {
          listen(name, handler) {
            let resolve;
            const promise = new Promise((next) => {
              resolve = next;
            });
            registrations.push({ name, handler, resolve, disposed: false });
            return promise;
          },
        },
        "../../../lib/settings": {
          normalizeChatRuntimeControls(value) {
            return value;
          },
          normalizeSystemToolSelection(value) {
            return Array.isArray(value) ? value : [];
          },
        },
      },
    });
    const { useGatewayBridgeListeners } = loader.loadModule(
      "src/pages/chat/gateway/useGatewayBridgeListeners.ts",
    );

    const currentConversationIdRef = { current: "conversation-1" };
    const ensureGatewayBridgeConversationReadyRef = {
      current: async (id) => id || "conversation-1",
    };
    const sendActionRef = { current: async () => true };
    let firstAbortCalls = 0;
    let secondAbortCalls = 0;
    const baseParams = {
      currentConversationIdRef,
      conversationRuntimeCacheRef: { current: new Map() },
      ensureGatewayBridgeConversationReadyRef,
      sendActionRef,
      queueGatewayBridgeEventForRequest() {},
      shouldQueueGatewayChatRequest() {
        return false;
      },
      async enqueueGatewayChatRequest() {
        return false;
      },
      isConversationRunning() {
        return false;
      },
      getConversationAbortController() {
        return { abort: () => firstAbortCalls++ };
      },
    };

    hookHarness.render(() => useGatewayBridgeListeners(baseParams));

    assert.ok(
      invokeCalls.some((call) => call.command === "gateway_chat_claim_next"),
      "the inbox must drain before async listen registration resolves",
    );
    assert.equal(registrations.length, 4);
    assert.ok(registrations.some((entry) => entry.name === "gateway:chat-runtime-wake"));

    for (const registration of registrations) {
      registration.resolve(() => {
        registration.disposed = true;
      });
    }
    await flushPromises();

    const runtimeHeartbeatsBeforeRender = invokeCalls.filter(
      (call) => call.command === "gateway_chat_runtime_heartbeat",
    );
    assert.ok(runtimeHeartbeatsBeforeRender.length > 0);
    const workerId = runtimeHeartbeatsBeforeRender[0].payload.worker_id;

    hookHarness.render(() =>
      useGatewayBridgeListeners({
        ...baseParams,
        shouldQueueGatewayChatRequest() {
          return true;
        },
        async enqueueGatewayChatRequest() {
          return true;
        },
        getConversationAbortController() {
          return { abort: () => secondAbortCalls++ };
        },
      }),
    );

    assert.equal(registrations.length, 4, "callback identity changes must not remount listeners");
    assert.ok(registrations.every((entry) => entry.disposed === false));

    const claimsBeforeWake = invokeCalls.filter(
      (call) => call.command === "gateway_chat_claim_next",
    ).length;
    registrations.find((entry) => entry.name === "gateway:chat-runtime-wake").handler({
      payload: { reason: "prepare" },
    });
    await flushPromises();
    const claimsAfterWake = invokeCalls.filter(
      (call) => call.command === "gateway_chat_claim_next",
    ).length;
    assert.ok(claimsAfterWake > claimsBeforeWake);

    registrations.find((entry) => entry.name === "gateway:chat-cancel").handler({
      payload: { requestId: "request-1", conversationId: "conversation-1" },
    });
    assert.equal(firstAbortCalls, 0);
    assert.equal(secondAbortCalls, 1, "listeners must dispatch through the latest callback refs");

    const runtimeWorkerIds = invokeCalls
      .filter((call) => call.command === "gateway_chat_runtime_heartbeat")
      .map((call) => call.payload.worker_id);
    assert.ok(runtimeWorkerIds.every((candidate) => candidate === workerId));

    hookHarness.cleanup();
    const finalHeartbeat = invokeCalls
      .filter((call) => call.command === "gateway_chat_runtime_heartbeat")
      .at(-1);
    assert.equal(finalHeartbeat.payload.worker_id, workerId);
    assert.equal(finalHeartbeat.payload.state, "suspended");
    assert.ok(registrations.every((entry) => entry.disposed === true));
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("trusted requests start their lease heartbeat before identity and permission resolution", async () => {
  const restoreGlobals = installBrowserGlobals();
  const hookHarness = createHookHarness();
  const invokeCalls = [];
  let claim = claimedCommand("");
  claim.request.message = "slow identity question";
  let principalResolutionSawHeartbeat = false;
  let permissionResolutionSawHeartbeat = false;
  const principal = {
    installationId:
      '{"bot_id":"bot-1","channel":"wecom","connector_id":"connector-1","tenant_id":"tenant-1"}',
    channel: "wecom",
    tenantId: "tenant-1",
    botId: "bot-1",
    connectorId: "connector-1",
    externalUserId: "user-1",
    chatId: "",
    chatType: "direct",
    externalMessageId: "message-slow-identity",
    channelSessionId: "session-1",
  };

  try {
    const leaseHeartbeatStarted = () =>
      invokeCalls.some(
        (call) =>
          call.command === "gateway_chat_heartbeat" && call.payload.request_id === "request-",
      );
    const loader = createCommandListenerLoader(
      hookHarness,
      async (command, payload) => {
        invokeCalls.push({ command, payload });
        if (command === "gateway_chat_claim_next") {
          const next = claim;
          claim = null;
          return next;
        }
        return undefined;
      },
      async () => {
        permissionResolutionSawHeartbeat = leaseHeartbeatStarted();
        return channelPermissionProfile();
      },
      {
        async resolvePrincipalContext() {
          principalResolutionSawHeartbeat = leaseHeartbeatStarted();
          return principal;
        },
        async derivePrincipalConversationId() {
          return "conversation-slow-identity";
        },
      },
    );
    const { useGatewayBridgeListeners } = loader.loadModule(
      "src/pages/chat/gateway/useGatewayBridgeListeners.ts",
    );

    hookHarness.render(() =>
      useGatewayBridgeListeners({
        allowWecomGroupMessages: true,
        currentConversationIdRef: { current: "local-conversation" },
        conversationRuntimeCacheRef: { current: new Map() },
        ensureGatewayBridgeConversationReadyRef: { current: async (id) => id },
        sendActionRef: { current: async () => false },
        queueGatewayBridgeEventForRequest() {},
        shouldQueueGatewayChatRequest() {
          return true;
        },
        async enqueueGatewayChatRequest() {
          return true;
        },
        isConversationRunning() {
          return false;
        },
        getConversationAbortController() {
          return null;
        },
      }),
    );

    await waitFor(
      () => invokeCalls.some((call) => call.command === "gateway_chat_mark_queued_in_gui"),
      "timed out waiting for the trusted request to enter the GUI queue",
    );

    assert.equal(principalResolutionSawHeartbeat, true);
    assert.equal(permissionResolutionSawHeartbeat, true);
  } finally {
    hookHarness.cleanup();
    restoreGlobals();
  }
});

test("trusted /new completes without invoking the chat send pipeline", async () => {
  const restoreGlobals = installBrowserGlobals();
  const hookHarness = createHookHarness();
  const invokeCalls = [];
  const bridgeEvents = [];
  let claim = claimedCommand("new");
  let sendCalls = 0;
  let ensureCalls = 0;
  const ensureOptions = [];

  try {
    const loader = createCommandListenerLoader(hookHarness, async (command, payload) => {
      invokeCalls.push({ command, payload });
      if (command === "gateway_chat_claim_next") {
        const next = claim;
        claim = null;
        return next;
      }
      return undefined;
    });
    const { useGatewayBridgeListeners } = loader.loadModule(
      "src/pages/chat/gateway/useGatewayBridgeListeners.ts",
    );

    hookHarness.render(() =>
      useGatewayBridgeListeners({
        allowWecomGroupMessages: true,
        currentConversationIdRef: { current: "local-conversation" },
        conversationRuntimeCacheRef: { current: new Map() },
        ensureGatewayBridgeConversationReadyRef: {
          current: async (id, options) => {
            ensureCalls += 1;
            ensureOptions.push(options);
            return id;
          },
        },
        sendActionRef: {
          current: async () => {
            sendCalls += 1;
            return true;
          },
        },
        queueGatewayBridgeEventForRequest(requestId, event) {
          bridgeEvents.push({ requestId, event });
        },
        shouldQueueGatewayChatRequest() {
          return false;
        },
        async enqueueGatewayChatRequest() {
          return false;
        },
        isConversationRunning() {
          return false;
        },
        getConversationAbortController() {
          return null;
        },
      }),
    );
    await waitFor(
      () =>
        invokeCalls.some((call) => call.command === "gateway_chat_complete") &&
        invokeCalls.filter((call) => call.command === "gateway_chat_claim_next").length >= 2,
      "timed out waiting for /new completion",
    );

    assert.equal(sendCalls, 0);
    assert.equal(ensureCalls, 1);
    assert.equal(ensureOptions[0].createIfMissing, true);
    assert.ok(
      invokeCalls.some((call) => call.command === "gateway_chat_mark_started"),
      "control command must enter the normal run lifecycle",
    );
    assert.ok(invokeCalls.some((call) => call.command === "gateway_chat_complete"));
    assert.deepEqual(
      bridgeEvents.map(({ event }) => event.type),
      ["done"],
    );
    assert.equal(bridgeEvents[0].event.final_text, "已开启新会话。");
    assert.ok(bridgeEvents.every(({ event }) => event.type !== "user_message"));
  } finally {
    hookHarness.cleanup();
    restoreGlobals();
  }
});

test("trusted /compact reaches send with empty text and authenticated principal", async () => {
  const restoreGlobals = installBrowserGlobals();
  const hookHarness = createHookHarness();
  const invokeCalls = [];
  const sent = [];
  const ensureOptions = [];
  const permissionResolutions = [];
  let claim = claimedCommand("compact");

  try {
    const loader = createCommandListenerLoader(
      hookHarness,
      async (command, payload) => {
        invokeCalls.push({ command, payload });
        if (command === "gateway_chat_claim_next") {
          const next = claim;
          claim = null;
          return next;
        }
        return undefined;
      },
      async (input) => {
        permissionResolutions.push(input);
        return channelPermissionProfile();
      },
    );
    const { useGatewayBridgeListeners } = loader.loadModule(
      "src/pages/chat/gateway/useGatewayBridgeListeners.ts",
    );

    hookHarness.render(() =>
      useGatewayBridgeListeners({
        allowWecomGroupMessages: true,
        currentConversationIdRef: { current: "local-conversation" },
        conversationRuntimeCacheRef: { current: new Map() },
        ensureGatewayBridgeConversationReadyRef: {
          current: async (id, options) => {
            ensureOptions.push(options);
            return id;
          },
        },
        sendActionRef: {
          current: async (overrides) => {
            sent.push(overrides);
            await overrides.beforeRuntimeStart?.();
            return true;
          },
        },
        queueGatewayBridgeEventForRequest() {},
        shouldQueueGatewayChatRequest() {
          return false;
        },
        async enqueueGatewayChatRequest() {
          return false;
        },
        isConversationRunning() {
          return false;
        },
        getConversationAbortController() {
          return null;
        },
      }),
    );
    await waitFor(
      () =>
        sent.length === 1 &&
        invokeCalls.some((call) => call.command === "gateway_chat_complete") &&
        invokeCalls.filter((call) => call.command === "gateway_chat_claim_next").length >= 2,
      "timed out waiting for /compact completion",
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].textOverride, "");
    assert.equal(sent[0].gatewayBridgeRequestOverride.principal.channelCommand, "compact");
    assert.equal(ensureOptions[0].createIfMissing, true);
    assert.equal(
      sent[0].gatewayBridgeRequestOverride.principal.externalUserId,
      "user-1",
    );
    assert.deepEqual(permissionResolutions, [
      {
        installationId:
          '{"bot_id":"bot-1","channel":"wecom","connector_id":"connector-1","tenant_id":"tenant-1"}',
        userId: "user-1",
        conversationId: undefined,
      },
    ]);
    const permissionProfile = sent[0].gatewayBridgeRequestOverride.permissionProfile;
    assert.equal(permissionProfile.id, "profile-1");
    assert.ok(Object.isFrozen(permissionProfile));
    assert.ok(Object.isFrozen(permissionProfile.policy));
    assert.ok(Object.isFrozen(permissionProfile.policy.allowedSkills));
    assert.equal(
      Object.hasOwn(sent[0].gatewayBridgeRequestOverride.principal, "allowedToolNames"),
      false,
    );
    assert.ok(invokeCalls.some((call) => call.command === "gateway_chat_mark_started"));
    assert.ok(invokeCalls.some((call) => call.command === "gateway_chat_complete"));
  } finally {
    hookHarness.cleanup();
    restoreGlobals();
  }
});

test("trusted requests without an effective permission profile fail closed", async () => {
  const restoreGlobals = installBrowserGlobals();
  const hookHarness = createHookHarness();
  const invokeCalls = [];
  let claim = claimedCommand("compact");
  let sendCalls = 0;
  let queueCalls = 0;

  try {
    const loader = createCommandListenerLoader(
      hookHarness,
      async (command, payload) => {
        invokeCalls.push({ command, payload });
        if (command === "gateway_chat_claim_next") {
          const next = claim;
          claim = null;
          return next;
        }
        return undefined;
      },
      async () => null,
    );
    const { useGatewayBridgeListeners } = loader.loadModule(
      "src/pages/chat/gateway/useGatewayBridgeListeners.ts",
    );

    hookHarness.render(() =>
      useGatewayBridgeListeners({
        allowWecomGroupMessages: true,
        currentConversationIdRef: { current: "local-conversation" },
        conversationRuntimeCacheRef: { current: new Map() },
        ensureGatewayBridgeConversationReadyRef: { current: async (id) => id },
        sendActionRef: {
          current: async () => {
            sendCalls += 1;
            return true;
          },
        },
        queueGatewayBridgeEventForRequest() {},
        shouldQueueGatewayChatRequest() {
          return true;
        },
        async enqueueGatewayChatRequest() {
          queueCalls += 1;
          return true;
        },
        isConversationRunning() {
          return false;
        },
        getConversationAbortController() {
          return null;
        },
      }),
    );
    await waitFor(
      () => invokeCalls.some((call) => call.command === "gateway_chat_fail"),
      "timed out waiting for permission rejection",
    );

    const failure = invokeCalls.find((call) => call.command === "gateway_chat_fail");
    assert.equal(failure.payload.error_code, "channel_permission_denied");
    assert.equal(sendCalls, 0);
    assert.equal(queueCalls, 0);
    assert.equal(
      invokeCalls.some((call) => call.command === "gateway_chat_mark_started"),
      false,
    );
  } finally {
    hookHarness.cleanup();
    restoreGlobals();
  }
});

test("trusted queued requests carry the same frozen permission snapshot", async () => {
  const restoreGlobals = installBrowserGlobals();
  const hookHarness = createHookHarness();
  const invokeCalls = [];
  const queued = [];
  let claim = claimedCommand("");
  claim.request.message = "queued question";

  try {
    const loader = createCommandListenerLoader(hookHarness, async (command, payload) => {
      invokeCalls.push({ command, payload });
      if (command === "gateway_chat_claim_next") {
        const next = claim;
        claim = null;
        return next;
      }
      return undefined;
    });
    const { useGatewayBridgeListeners } = loader.loadModule(
      "src/pages/chat/gateway/useGatewayBridgeListeners.ts",
    );

    hookHarness.render(() =>
      useGatewayBridgeListeners({
        allowWecomGroupMessages: true,
        currentConversationIdRef: { current: "local-conversation" },
        conversationRuntimeCacheRef: { current: new Map() },
        ensureGatewayBridgeConversationReadyRef: { current: async (id) => id },
        sendActionRef: { current: async () => false },
        queueGatewayBridgeEventForRequest() {},
        shouldQueueGatewayChatRequest() {
          return true;
        },
        async enqueueGatewayChatRequest(...args) {
          queued.push(args);
          return true;
        },
        isConversationRunning() {
          return false;
        },
        getConversationAbortController() {
          return null;
        },
      }),
    );
    await waitFor(
      () => invokeCalls.some((call) => call.command === "gateway_chat_mark_queued_in_gui"),
      "timed out waiting for trusted request queueing",
    );

    assert.equal(queued.length, 1);
    assert.equal(queued[0][2].externalUserId, "user-1");
    assert.equal(queued[0][3].id, "profile-1");
    assert.ok(Object.isFrozen(queued[0][3]));
    assert.ok(Object.isFrozen(queued[0][3].policy.allowedSystemTools));
    const queuedControl = invokeCalls.find(
      (call) => call.command === "gateway_chat_mark_queued_in_gui",
    );
    assert.ok(queuedControl.payload.worker_id);
    assert.equal(
      queued[0][4],
      queuedControl.payload.worker_id,
      "the GUI queue must retain the worker that owns the Rust-side lease",
    );
    assert.equal(
      invokeCalls.some((call) => call.command === "gateway_chat_mark_started"),
      false,
    );
  } finally {
    hookHarness.cleanup();
    restoreGlobals();
  }
});

test("trusted /help is rejected before starting or superseding a desktop run", async () => {
  const restoreGlobals = installBrowserGlobals();
  const hookHarness = createHookHarness();
  const invokeCalls = [];
  const bridgeEvents = [];
  let claim = claimedCommand("help");
  let sendCalls = 0;

  try {
    const loader = createCommandListenerLoader(hookHarness, async (command, payload) => {
      invokeCalls.push({ command, payload });
      if (command === "gateway_chat_claim_next") {
        const next = claim;
        claim = null;
        return next;
      }
      return undefined;
    });
    const { useGatewayBridgeListeners } = loader.loadModule(
      "src/pages/chat/gateway/useGatewayBridgeListeners.ts",
    );

    hookHarness.render(() =>
      useGatewayBridgeListeners({
        allowWecomGroupMessages: true,
        currentConversationIdRef: { current: "local-conversation" },
        conversationRuntimeCacheRef: { current: new Map() },
        ensureGatewayBridgeConversationReadyRef: { current: async (id) => id },
        sendActionRef: {
          current: async () => {
            sendCalls += 1;
            return true;
          },
        },
        queueGatewayBridgeEventForRequest(requestId, event) {
          bridgeEvents.push({ requestId, event });
        },
        shouldQueueGatewayChatRequest() {
          return false;
        },
        async enqueueGatewayChatRequest() {
          return false;
        },
        isConversationRunning() {
          return true;
        },
        getConversationAbortController() {
          return { abort() {} };
        },
      }),
    );
    await waitFor(
      () => invokeCalls.some((call) => call.command === "gateway_chat_fail"),
      "timed out waiting for /help rejection",
    );

    assert.equal(sendCalls, 0);
    assert.equal(
      invokeCalls.some((call) => call.command === "gateway_chat_mark_started"),
      false,
    );
    assert.deepEqual(
      bridgeEvents.map(({ event }) => event.type),
      ["error"],
    );
  } finally {
    hookHarness.cleanup();
    restoreGlobals();
  }
});
