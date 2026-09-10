import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function createHarness(options = {}) {
  const invocations = [];
  const completions = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "fs_read_image_source") {
            if (String(args.source).endsWith(".svg")) {
              return {
                kind: "image",
                path: args.source,
                mimeType: "image/svg+xml",
                data: "PHN2Zy8+",
                sizeBytes: 8,
              };
            }
            return {
              kind: "image",
              path: args.source,
              mimeType: "image/png",
              data: "iVBORw0KGgo=",
              sizeBytes: 1024,
            };
          }
          throw new Error(`unexpected command ${command}`);
        },
      },
    },
  });
  const { createVisualReviewTools } = loader.loadModule("src/lib/tools/visualReviewTools.ts");
  const review = {
    providerId: "codex",
    model: options.model ?? "gpt-5",
    source: options.source ?? "configured",
    runtime: {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "key",
      requestFormat: "chat_completions",
    },
  };
  const bundle = createVisualReviewTools({
    workdir: "E:/workspace",
    review,
    resolveHomeDir: async () => "C:/Users/test",
    deps: {
      resolveModelInput: () => options.input ?? ["text", "image"],
      async complete(params) {
        completions.push(params);
        return {
          role: "assistant",
          content: [{ type: "text", text: options.answer ?? "p-02: title overlaps the card. FIX" }],
          timestamp: Date.now(),
          usage: { input: 0, output: 0 },
        };
      },
    },
  });
  return { bundle, invocations, completions };
}

test("VisualReview sends workspace images to the review model and returns its findings", async () => {
  const { bundle, invocations, completions } = createHarness();
  assert.deepEqual(
    bundle.tools.map((tool) => tool.name),
    ["VisualReview"],
  );
  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "call-1",
    name: "VisualReview",
    arguments: {
      paths: ["deck/plan-preview.png", "deck/.arcforge-assets/icon-check/raster.png"],
      question: "Check p-01 and p-02 for cut-off text.",
      context: "business-blue style pack",
    },
  });
  assert.equal(result.isError, false, JSON.stringify(result.content));
  assert.match(result.content[0].text, /Reviewed 2 images with gpt-5 \(visual review model\)/);
  assert.match(result.content[0].text, /title overlaps the card/);
  assert.equal(result.details.kind, "visual_review");
  assert.equal(result.details.reviewed, true);
  assert.deepEqual(
    result.details.images.map((image) => image.mimeType),
    ["image/png", "image/png"],
  );

  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].args.source_type, "path");
  assert.equal(completions.length, 1);
  const request = completions[0];
  assert.equal(request.model, "gpt-5");
  assert.equal(request.runtime.reasoning, "off");
  assert.equal(request.runtime.nativeWebSearchEnabled, false);
  const userMessage = request.context.messages[0];
  assert.equal(userMessage.role, "user");
  assert.equal(userMessage.content.filter((block) => block.type === "image").length, 2);
  assert.match(userMessage.content[0].text, /Question: Check p-01 and p-02/);
  assert.match(userMessage.content[0].text, /Context: business-blue/);
});

test("VisualReview refuses text-only models instead of pretending to look", async () => {
  const { bundle, completions } = createHarness({
    input: ["text"],
    model: "deepseek-chat",
    source: "current",
  });
  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "call-2",
    name: "VisualReview",
    arguments: { paths: ["deck/plan-preview.png"], question: "Any overlaps?" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /NOT performed/);
  assert.match(result.content[0].text, /deepseek-chat \(current chat model\)/);
  assert.match(result.content[0].text, /Visual review model/);
  assert.equal(result.details.reviewed, false);
  assert.equal(completions.length, 0);
});

test("VisualReview rejects SVG inputs and points at the raster preview", async () => {
  const { bundle, completions } = createHarness();
  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "call-3",
    name: "VisualReview",
    arguments: { paths: ["deck/assets/icon.svg"], question: "Recognizable?" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /raster\.png/);
  assert.equal(completions.length, 0);
});

test("VisualReview validates its arguments", async () => {
  const { bundle } = createHarness();
  const missingPaths = await bundle.executeToolCall({
    type: "toolCall",
    id: "call-4",
    name: "VisualReview",
    arguments: { question: "?" },
  });
  assert.equal(missingPaths.isError, true);
  assert.match(missingPaths.content[0].text, /at least one image path/);

  const missingQuestion = await bundle.executeToolCall({
    type: "toolCall",
    id: "call-5",
    name: "VisualReview",
    arguments: { paths: ["a.png"] },
  });
  assert.equal(missingQuestion.isError, true);
  assert.match(missingQuestion.content[0].text, /requires `question`/);
});
