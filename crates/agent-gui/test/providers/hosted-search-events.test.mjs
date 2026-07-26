import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const hostedSearchEvents = loader.loadModule("src/lib/providers/hostedSearchEvents.ts");

function waitForProbeParser() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

function sse(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function delayedSseResponse(event) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(encoder.encode(sse(event)));
          controller.close();
        }, 5);
      },
    }),
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}

test("hosted search fetch probes attribute concurrent same-provider streams by request id", async () => {
  const originalFetch = globalThis.fetch;
  const eventsA = [];
  const eventsB = [];
  let callCount = 0;

  globalThis.fetch = async () => {
    callCount += 1;
    return new Response(
      sse({
        type: "response.output_item.added",
        item: {
          type: "web_search_call",
          id: `search-${callCount}`,
          status: "in_progress",
          action: { query: `query ${callCount}` },
        },
      }),
      { headers: { "content-type": "text/event-stream; charset=utf-8" } },
    );
  };

  const probeA = hostedSearchEvents.startHostedSearchFetchProbe({
    providerId: "codex",
    sessionId: "session-a",
    requestId: "probe-a",
    enabled: true,
    onRawEvent: (event) => eventsA.push(event),
  });
  const probeB = hostedSearchEvents.startHostedSearchFetchProbe({
    providerId: "codex",
    sessionId: "session-b",
    requestId: "probe-b",
    enabled: true,
    onRawEvent: (event) => eventsB.push(event),
  });

  try {
    await fetch("http://127.0.0.1:18080/proxy/codex/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [hostedSearchEvents.HOSTED_SEARCH_PROBE_HEADER]: "probe-b",
      },
      body: JSON.stringify({ prompt_cache_key: "session-b" }),
    });
    await waitForProbeParser();

    assert.equal(eventsA.length, 0);
    assert.equal(eventsB.length, 1);
    assert.equal(eventsB[0].item.id, "search-1");

    await fetch("http://127.0.0.1:18080/proxy/codex/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [hostedSearchEvents.HOSTED_SEARCH_PROBE_HEADER]: "probe-a",
      },
      body: JSON.stringify({ prompt_cache_key: "session-a" }),
    });
    await waitForProbeParser();

    assert.equal(eventsA.length, 1);
    assert.equal(eventsA[0].item.id, "search-2");
    assert.equal(eventsB.length, 1);
  } finally {
    probeA.finish();
    probeB.finish();
    globalThis.fetch = originalFetch;
  }
});

test("hosted search fetch probe finish waits for delayed clone parsing", async () => {
  const originalFetch = globalThis.fetch;
  const events = [];

  globalThis.fetch = async () =>
    delayedSseResponse({
      type: "response.output_item.added",
      item: {
        type: "web_search_call",
        id: "search-delayed",
        status: "in_progress",
        action: { query: "delayed query" },
      },
    });

  const probe = hostedSearchEvents.startHostedSearchFetchProbe({
    providerId: "codex",
    sessionId: "session-delayed",
    requestId: "probe-delayed",
    enabled: true,
    onRawEvent: (event) => events.push(event),
  });

  try {
    await fetch("http://127.0.0.1:18080/proxy/codex/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [hostedSearchEvents.HOSTED_SEARCH_PROBE_HEADER]: "probe-delayed",
      },
      body: JSON.stringify({ prompt_cache_key: "session-delayed" }),
    });
    await probe.finish();

    assert.equal(events.length, 1);
    assert.equal(events[0].item.id, "search-delayed");
  } finally {
    await probe.finish();
    globalThis.fetch = originalFetch;
  }
});

test("hosted search aggregation ignores ordinary text that only mentions search tokens", () => {
  const emitted = [];
  const aggregator = hostedSearchEvents.createHostedSearchEventAggregator({
    providerId: "codex",
    onHostedSearch: (block) => emitted.push(block),
  });

  aggregator.accept({
    type: "response.output_text.delta",
    item_id: "msg-1",
    delta: "OpenAI web_search and url_citation are provider event names.",
  });

  assert.deepEqual(aggregator.getBlocks(), []);
  assert.deepEqual(emitted, []);
});

test("hosted search aggregation dedupes identical updates and separates completion from dispose", () => {
  const emitted = [];
  const aggregator = hostedSearchEvents.createHostedSearchEventAggregator({
    providerId: "codex",
    onHostedSearch: (block) => emitted.push(block),
  });
  const rawSearchEvent = {
    type: "response.output_item.added",
    item: {
      type: "web_search_call",
      id: "search-1",
      status: "in_progress",
      action: { query: "ArcForge hosted search" },
    },
  };

  aggregator.accept(rawSearchEvent);
  aggregator.accept(rawSearchEvent);
  assert.equal(emitted.length, 1);
  assert.equal(aggregator.getBlocks()[0].status, "searching");

  const disposed = aggregator.dispose();
  assert.equal(disposed[0].status, "searching");
  assert.equal(emitted.length, 1);

  const completed = aggregator.complete();
  assert.equal(completed[0].status, "completed");
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].status, "completed");
});

test("hosted search aggregation extracts structural Anthropic and Gemini search metadata", () => {
  const anthropic = hostedSearchEvents.createHostedSearchEventAggregator({
    providerId: "claude_code",
  });
  anthropic.accept({
    type: "content_block_start",
    content_block: {
      type: "server_tool_use",
      id: "toolu_1",
      name: "web_search",
      input: { query: "ArcForge Anthropic search" },
    },
  });
  anthropic.accept({
    type: "content_block_start",
    content_block: {
      type: "web_search_tool_result",
      tool_use_id: "toolu_1",
      content: [
        {
          type: "web_search_result",
          url: "https://example.com/anthropic",
          title: "Anthropic Result",
        },
      ],
    },
  });

  assert.deepEqual(anthropic.getBlocks()[0].queries, ["ArcForge Anthropic search"]);
  assert.deepEqual(anthropic.getBlocks()[0].sources.map((source) => source.url), [
    "https://example.com/anthropic",
  ]);

  const gemini = hostedSearchEvents.createHostedSearchEventAggregator({
    providerId: "gemini",
  });
  gemini.accept({
    candidates: [
      {
        groundingMetadata: {
          webSearchQueries: ["ArcForge Gemini search"],
          groundingChunks: [
            {
              web: {
                uri: "https://example.com/gemini",
                title: "Gemini Result",
              },
            },
          ],
        },
      },
    ],
  });

  assert.deepEqual(gemini.getBlocks()[0].queries, ["ArcForge Gemini search"]);
  assert.deepEqual(gemini.getBlocks()[0].sources.map((source) => source.url), [
    "https://example.com/gemini",
  ]);
});

test("hosted search aggregation accumulates an Anthropic query streamed as partial_json fragments", () => {
  const anthropic = hostedSearchEvents.createHostedSearchEventAggregator({
    providerId: "claude_code",
  });

  // The real Anthropic wire format streams the tool-call JSON input across
  // several content_block_delta events; no single fragment is valid JSON on
  // its own, so the query can only be read once every fragment has arrived.
  anthropic.accept({
    type: "content_block_start",
    index: 0,
    content_block: { type: "server_tool_use", id: "toolu_incremental", name: "web_search" },
  });
  anthropic.accept({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"que' },
  });
  assert.deepEqual(anthropic.getBlocks(), []);

  anthropic.accept({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: 'ry": "ArcFo' },
  });
  assert.deepEqual(anthropic.getBlocks(), []);

  anthropic.accept({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: 'rge incremental search"}' },
  });

  assert.deepEqual(anthropic.getBlocks()[0].queries, ["ArcForge incremental search"]);
  assert.equal(anthropic.getBlocks()[0].status, "searching");

  anthropic.accept({ type: "content_block_stop", index: 0 });
});

test("hosted search aggregation extracts Anthropic citations_delta into the active search block", () => {
  const anthropic = hostedSearchEvents.createHostedSearchEventAggregator({
    providerId: "claude_code",
  });

  anthropic.accept({
    type: "content_block_start",
    content_block: {
      type: "server_tool_use",
      id: "toolu_cited",
      name: "web_search",
      input: { query: "ArcForge citation search" },
    },
  });
  anthropic.accept({
    type: "content_block_delta",
    index: 1,
    delta: {
      type: "citations_delta",
      citation: { url: "https://example.com/cited", title: "Cited Result" },
    },
  });

  const block = anthropic.getBlocks()[0];
  assert.deepEqual(block.queries, ["ArcForge citation search"]);
  assert.deepEqual(
    block.sources.map((source) => ({ url: source.url, sourceType: source.sourceType })),
    [{ url: "https://example.com/cited", sourceType: "citation" }],
  );
});

test("hosted search aggregation marks Anthropic web_search_tool_result_error as failed", () => {
  const anthropic = hostedSearchEvents.createHostedSearchEventAggregator({
    providerId: "claude_code",
  });

  anthropic.accept({
    type: "content_block_start",
    content_block: {
      type: "server_tool_use",
      id: "toolu_failed",
      name: "web_search",
      input: { query: "ArcForge failing search" },
    },
  });
  anthropic.accept({
    type: "content_block_start",
    content_block: { type: "web_search_tool_result_error", tool_use_id: "toolu_failed" },
  });

  assert.equal(anthropic.getBlocks()[0].status, "failed");
});

test("hosted search aggregation extracts OpenAI url_citation annotations and marks call completion", () => {
  const emitted = [];
  const openai = hostedSearchEvents.createHostedSearchEventAggregator({
    providerId: "codex",
    onHostedSearch: (block) => emitted.push(block),
  });

  openai.accept({
    type: "response.output_item.added",
    item: {
      type: "web_search_call",
      id: "search-annotated",
      status: "in_progress",
      action: { query: "ArcForge OpenAI search" },
    },
  });
  openai.accept({
    type: "response.output_item.done",
    item: { type: "web_search_call", id: "search-annotated", status: "completed" },
  });
  openai.accept({
    type: "response.output_text.annotation.added",
    annotation: {
      type: "url_citation",
      url: "https://example.com/openai",
      title: "OpenAI Result",
    },
  });

  const block = openai.getBlocks()[0];
  assert.equal(block.status, "completed");
  assert.deepEqual(block.queries, ["ArcForge OpenAI search"]);
  assert.deepEqual(
    block.sources.map((source) => ({ url: source.url, sourceType: source.sourceType })),
    [{ url: "https://example.com/openai", sourceType: "citation" }],
  );
});
