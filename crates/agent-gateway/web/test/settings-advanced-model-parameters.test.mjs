import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const settings = loader.loadModule("@/lib/settings/index.ts");

test("gateway model normalization preserves valid advanced Pi parameters", () => {
  const normalized = settings.normalizeProviderModelConfig(
    {
      id: "custom-reasoning-model",
      contextWindow: 128_000,
      maxOutputToken: 16_384,
      samplingParams: {
        top_p: 0.95,
        top_k: 40,
        min_p: 0.05,
        stop: ["<END>"],
      },
      supportsFinishReason: false,
      thinkingTokenBudgetField: "thinking_budget_tokens",
    },
    "codex",
  );

  assert.deepEqual(normalized, {
    id: "custom-reasoning-model",
    contextWindow: 128_000,
    maxOutputToken: 16_384,
    samplingParams: {
      top_p: 0.95,
      top_k: 40,
      min_p: 0.05,
      stop: ["<END>"],
    },
    supportsFinishReason: false,
    thinkingTokenBudgetField: "thinking_budget_tokens",
  });
});

test("gateway model normalization drops malformed advanced Pi parameters", () => {
  const normalized = settings.normalizeProviderModelConfig(
    {
      id: "custom-model",
      samplingParams: ["top_p", 0.9],
      supportsFinishReason: "false",
      thinkingTokenBudgetField: "unsupported_budget_field",
    },
    "codex",
  );

  assert.equal("samplingParams" in normalized, false);
  assert.equal("supportsFinishReason" in normalized, false);
  assert.equal("thinkingTokenBudgetField" in normalized, false);

  const emptyParams = settings.normalizeProviderModelConfig(
    { id: "empty-params", samplingParams: {} },
    "zhipu",
  );
  assert.equal("samplingParams" in emptyParams, false);
});

test("gateway provider normalization persists all supported thinking budget field names", () => {
  const fields = [
    "thinking_token_budget",
    "thinking_budget",
    "thinking_budget_tokens",
  ];
  const provider = settings.normalizeCustomProvider({
    id: "compatible-endpoint",
    type: "codex",
    models: fields.map((thinkingTokenBudgetField, index) => ({
      id: `model-${index}`,
      samplingParams: { temperature: index / 10 },
      supportsFinishReason: true,
      thinkingTokenBudgetField,
    })),
    activeModels: fields.map((_, index) => `model-${index}`),
  });

  assert.deepEqual(
    provider.models.map((model) => ({
      samplingParams: model.samplingParams,
      supportsFinishReason: model.supportsFinishReason,
      thinkingTokenBudgetField: model.thinkingTokenBudgetField,
    })),
    fields.map((thinkingTokenBudgetField, index) => ({
      samplingParams: { temperature: index / 10 },
      supportsFinishReason: true,
      thinkingTokenBudgetField,
    })),
  );
});
