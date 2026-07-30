import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function createHarness() {
  let historyReads = 0;
  const loader = createTsModuleLoader({
    mocks: {
      "../../../lib/chat/conversation/conversationState": {
        createConversationStateFromContext(context) {
          return {
            meta: { tools: context.tools },
            segments: [{ messages: context.messages }],
            historyRenderItems: [],
            activeSegmentIndex: 0,
          };
        },
        truncateConversationFromMessage() {
          throw new Error("unexpected rebase");
        },
      },
      "../../../lib/chat/history/chatHistory": {
        async getChatHistory() {
          historyReads += 1;
          throw new Error("history not found");
        },
      },
      "../../../lib/chat/page/chatPageHelpers": {
        createConversationIdentity() {
          return {
            conversationId: "generated-conversation",
            sessionId: "runtime-session",
            createdAt: 1_700_000_000_000,
          };
        },
      },
      "../../../lib/settings": {
        normalizeSelectedModelForProviders(value) {
          return value;
        },
        parseSelectedModelJson() {
          return undefined;
        },
      },
      "../../../lib/subagents": {
        collectRetainedSubagentParentToolCallIds() {
          return new Set();
        },
        async pruneSubagentRunsForConversation() {},
      },
      "../runtime/chatPageRuntime": {
        createConversationRuntimeEntry(params) {
          return {
            ...params,
            compactionStatus: params.compactionStatus ?? { phase: "idle" },
            isSending: params.isSending ?? false,
            errorMessage: null,
            hookWarning: null,
          };
        },
        setConversationRuntimeCacheEntry(cache, id, entry) {
          cache.set(id, entry);
        },
      },
    },
  });
  return {
    historyReads: () => historyReads,
    useGatewayBridgeReadiness: loader.loadModule(
      "src/pages/chat/gateway/useGatewayBridgeReadiness.ts",
    ).useGatewayBridgeReadiness,
  };
}

function readinessParams(cache) {
  return {
    settings: { customProviders: [] },
    conversationState: { meta: { tools: [{ name: "ReadOnly" }] } },
    currentConversationIdRef: { current: "local-conversation" },
    conversationRuntimeCacheRef: { current: cache },
    persistedConversationStateRef: { current: new Map() },
    buildRuntimeEntryFromVisibleState() {
      throw new Error("unexpected visible runtime read");
    },
    syncVisibleConversationRuntime() {},
    isConversationRunning() {
      return false;
    },
    sidebarStore: {
      peek() {
        return undefined;
      },
      upsertLocal() {},
    },
    gatewayBridgeHistorySummaryRef: { current: new Map() },
    hydratingConversationIdRef: { current: null },
    hydrationFailedConversationIdRef: { current: null },
    setHydratingConversationId() {},
    setHydrationFailedConversationId() {},
    subagentStoresRef: { current: { invalidate() {} } },
  };
}

test("trusted channel ids can allocate an empty runtime without reading missing history", async () => {
  const harness = createHarness();
  const cache = new Map();
  const { ensureGatewayBridgeConversationReady } = harness.useGatewayBridgeReadiness(
    readinessParams(cache),
  );

  const id = await ensureGatewayBridgeConversationReady("wecom:new-session", {
    createIfMissing: true,
  });

  assert.equal(id, "wecom:new-session");
  assert.equal(harness.historyReads(), 0);
  assert.equal(cache.get(id).sessionId, "runtime-session");
  assert.deepEqual(cache.get(id).state.segments[0].messages, []);
  assert.deepEqual(cache.get(id).state.meta.tools, [{ name: "ReadOnly" }]);
});

test("a stubbed conversation stays hydration-free on the very next message (wecom /new regression)", async () => {
  const harness = createHarness();
  const cache = new Map();
  const params = readinessParams(cache);
  const { ensureGatewayBridgeConversationReady } = harness.useGatewayBridgeReadiness(params);

  const firstId = await ensureGatewayBridgeConversationReady("wecom:rotated-session", {
    createIfMissing: true,
  });
  assert.equal(harness.historyReads(), 0);

  // Simulate the next inbound message reusing the same channel-derived
  // conversation id before any real send pipeline has persisted a sqlite
  // row for it. This used to force a getChatHistory() lookup that failed
  // with "history not found" because the conversation was "known" (in the
  // runtime cache) but not yet marked as persisted.
  const secondId = await ensureGatewayBridgeConversationReady("wecom:rotated-session", {
    createIfMissing: true,
  });

  assert.equal(secondId, firstId);
  assert.equal(harness.historyReads(), 0);
});

test("ordinary unknown desktop ids still require a persisted history record", async () => {
  const harness = createHarness();
  const { ensureGatewayBridgeConversationReady } = harness.useGatewayBridgeReadiness(
    readinessParams(new Map()),
  );

  await assert.rejects(
    ensureGatewayBridgeConversationReady("desktop:unknown"),
    /history not found/,
  );
  assert.equal(harness.historyReads(), 1);
});
