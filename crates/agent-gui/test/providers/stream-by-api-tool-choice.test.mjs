import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function createUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createSourceStream() {
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-5.6",
    usage: createUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const events = [
    { type: "start", partial: { ...assistant, content: [] } },
    { type: "done", reason: "stop", message: assistant },
  ];
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    async result() {
      return assistant;
    },
  };
}

function createOpenAIModel(api = "openai-completions") {
  return {
    id: "gpt-5.6",
    name: "gpt-5.6",
    api,
    provider: "openai",
    baseUrl: "https://relay.example.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272000,
    maxTokens: 128000,
  };
}

function createLoaderCapturingOptions(capturedOptions) {
  return createTsModuleLoader({
    mocks: {
      "@earendil-works/pi-ai/api/openai-completions": {
        stream(_model, _context, options) {
          capturedOptions.push(options);
          return createSourceStream();
        },
      },
      "@earendil-works/pi-ai/api/openai-responses": {
        stream(_model, _context, options) {
          capturedOptions.push(options);
          return createSourceStream();
        },
      },
    },
  });
}

async function streamOnce(
  context,
  toolChoice,
  api = "openai-completions",
  extraOptions = {},
  modelOverrides = {},
) {
  const capturedOptions = [];
  const loader = createLoaderCapturingOptions(capturedOptions);
  const { streamSimpleByApi } = loader.loadModule("src/lib/providers/runtime/streamByApi.ts");
  const stream = streamSimpleByApi({ ...createOpenAIModel(api), ...modelOverrides }, context, {
    apiKey: "test-key",
    toolChoice,
    ...extraOptions,
  });
  await stream.result();
  assert.equal(capturedOptions.length, 1);
  return capturedOptions[0];
}

const echoTool = {
  name: "echo",
  description: "Echo tool",
  parameters: { type: "object", properties: {} },
};

test("openai-completions: 无工具请求不下发 tool_choice（压缩摘要等 text-only 路径）", async () => {
  const options = await streamOnce(
    { messages: [{ role: "user", content: "compaction payload", timestamp: 1 }] },
    "none",
  );
  assert.equal(options.toolChoice, undefined);
});

test("openai-completions: 无工具请求即使 toolChoice=auto 也不下发", async () => {
  const options = await streamOnce(
    { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    "auto",
  );
  assert.equal(options.toolChoice, undefined);
});

test("openai-completions: 带工具请求保留 tool_choice=none", async () => {
  const options = await streamOnce(
    {
      tools: [echoTool],
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    },
    "none",
  );
  assert.equal(options.toolChoice, "none");
});

test("openai-completions: 带工具请求 any 映射为 required", async () => {
  const options = await streamOnce(
    {
      tools: [echoTool],
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    },
    "any",
  );
  assert.equal(options.toolChoice, "required");
});

test("openai-responses: 无工具请求不下发 tool_choice", async () => {
  const options = await streamOnce(
    { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    "any",
    "openai-responses",
  );
  assert.equal(options.toolChoice, undefined);
});

test("openai-responses: 带工具请求 any 映射为 required", async () => {
  const options = await streamOnce(
    {
      tools: [echoTool],
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    },
    "any",
    "openai-responses",
  );
  assert.equal(options.toolChoice, "required");
});

test("openai-responses: 指定工具映射为 Responses function 选择器", async () => {
  const options = await streamOnce(
    {
      tools: [echoTool],
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    },
    { name: "echo" },
    "openai-responses",
  );
  assert.deepEqual(options.toolChoice, { type: "function", name: "echo" });
});

test("OpenAI completions/responses 都转发高级采样参数与思考预算", async () => {
  const samplingParams = {
    top_p: 0.91,
    top_k: 32,
    min_p: 0.06,
    repetition_penalty: 1.05,
  };
  const thinkingBudgets = { low: 2_048, medium: 8_192, high: 16_384 };

  for (const api of ["openai-completions", "openai-responses"]) {
    const options = await streamOnce(
      { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      "auto",
      api,
      { samplingParams, thinkingBudgets },
    );
    assert.deepEqual(options.samplingParams, samplingParams, `${api} samplingParams`);
    assert.deepEqual(options.thinkingBudgets, thinkingBudgets, `${api} thinkingBudgets`);
  }
});

test("请求级采样参数按键覆盖模型默认值", async () => {
  const options = await streamOnce(
    { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    "auto",
    "openai-completions",
    { samplingParams: { top_p: 0.91, min_p: 0.06 } },
    { samplingParams: { top_p: 0.75, top_k: 32 } },
  );

  assert.deepEqual(options.samplingParams, {
    top_p: 0.91,
    top_k: 32,
    min_p: 0.06,
  });
});
