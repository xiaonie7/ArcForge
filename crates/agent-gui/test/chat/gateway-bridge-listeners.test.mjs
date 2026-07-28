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

function createCommandListenerLoader(hookHarness, invoke) {
  return createTsModuleLoader({
    mocks: {
      react: hookHarness.react,
      "@tauri-apps/api/core": { invoke },
      "@tauri-apps/api/event": {
        async listen() {
          return () => {};
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
        wecomAccessPolicy: {
          rules: [
            {
              tenantId: "tenant-1",
              botId: "bot-1",
              externalUserId: "user-1",
              scopes: ["tool:read"],
              allowedToolNames: ["Read"],
            },
          ],
        },
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
      ["token", "tool_status"],
    );
    assert.equal(bridgeEvents[0].event.text, "已开启新会话。");
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
  let claim = claimedCommand("compact");

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
        wecomAccessPolicy: {
          rules: [
            {
              tenantId: "tenant-1",
              botId: "bot-1",
              externalUserId: "user-1",
              scopes: ["tool:read"],
              allowedToolNames: ["Read"],
            },
          ],
        },
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
    assert.deepEqual(sent[0].gatewayBridgeRequestOverride.principal.allowedToolNames, ["Read"]);
    assert.ok(invokeCalls.some((call) => call.command === "gateway_chat_mark_started"));
    assert.ok(invokeCalls.some((call) => call.command === "gateway_chat_complete"));
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
