import type {
  Context,
  ImageContent,
  TextContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";

import {
  assistantMessageToText,
  completeAssistantMessage,
  type ProviderRuntimeConfig,
} from "../providers/llm";
import { createModelFromConfig } from "../providers/runtime/modelFactory";
import type { ProviderId } from "../settings";
import { type BuiltinToolBundle, createBuiltinMetadataMap } from "./builtinTypes";
import { invokeFs } from "./fsBackend";
import { formatResolvedTarget, ToolPathResolver } from "./pathUtils";

export const VISUAL_REVIEW_TOOL_NAME = "VisualReview";
const MAX_REVIEW_IMAGES = 6;

/** The model that answers VisualReview calls: the configured review slot or the chat model. */
export type VisualReviewModelConfig = {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  /** `configured` = Settings → Custom settings → Visual review model; `current` = chat model. */
  source: "configured" | "current";
};

export type VisualReviewImageDetails = {
  path: string;
  mimeType: string;
  sizeBytes: number;
};

export type VisualReviewResultDetails = {
  kind: "visual_review";
  providerId: ProviderId;
  model: string;
  source: VisualReviewModelConfig["source"];
  reviewed: boolean;
  images: VisualReviewImageDetails[];
};

type ReadImageResponse = {
  kind: string;
  path: string;
  mimeType?: string | null;
  data?: string | null;
  sizeBytes?: number | null;
};

type VisualReviewDeps = {
  complete: typeof completeAssistantMessage;
  resolveModelInput: (config: VisualReviewModelConfig) => readonly string[];
};

const defaultDeps: VisualReviewDeps = {
  complete: completeAssistantMessage,
  resolveModelInput: (config) =>
    createModelFromConfig(
      config.providerId,
      config.model,
      config.runtime.baseUrl,
      config.runtime.requestFormat,
      config.runtime.modelConfig,
      config.runtime.baseUrl,
    ).input,
};

const REVIEW_SYSTEM_PROMPT = [
  "You are a meticulous visual reviewer for slide decks, icons, and document previews.",
  "Look at every attached image and answer the reviewer's question precisely.",
  "Report concrete problems only: name the image, the page or element id when it is given, and what is wrong (cut-off text, overlaps, cramped cards, cropped pictures, unreadable contrast, inconsistent colors or fonts, elements covering logos or footers, unrecognizable icons).",
  "Do not invent problems. If something is fine, say so briefly. End with a one-line verdict: PASS or FIX.",
].join(" ");

function normalizePaths(raw: unknown): string[] {
  if (typeof raw === "string") {
    return raw.trim() ? [raw.trim()] : [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

export function createVisualReviewTools(params: {
  workdir: string;
  review: VisualReviewModelConfig;
  resolveHomeDir?: () => Promise<string>;
  deps?: Partial<VisualReviewDeps>;
}): BuiltinToolBundle {
  const { workdir, review } = params;
  const deps: VisualReviewDeps = { ...defaultDeps, ...params.deps };
  const pathResolver = new ToolPathResolver({
    workdir,
    resolveHomeDir: params.resolveHomeDir,
  });

  const tool: Tool = {
    name: VISUAL_REVIEW_TOOL_NAME,
    description:
      "Ask the configured visual review model to look at up to 6 local images (PNG, JPEG, WebP, GIF) and answer a question about them. " +
      "Use it to check rendered slide previews, icon rasters (.arcforge-assets/<id>/raster.png), screenshots, or design mockups when you cannot see images yourself (a Read result says the image was omitted) or when the deck workflow asks for a review pass. " +
      "Pass workspace-relative or absolute image paths exactly as returned by other tools, and a precise question or checklist. " +
      "The result names the model that looked at the images; if no vision-capable model is available the call fails and visual verification must be reported as not performed.",
    parameters: Type.Object(
      {
        paths: Type.Array(
          Type.String({ description: "Local image path (workspace-relative or absolute)." }),
          {
            minItems: 1,
            maxItems: MAX_REVIEW_IMAGES,
            description:
              "Images to review, in order. SVG files are not accepted; use their raster.png.",
          },
        ),
        question: Type.String({
          description:
            "What to check, for example the section D review checklist plus the page ids the images belong to.",
        }),
        context: Type.Optional(
          Type.String({
            description:
              "Optional background: what the pages should show, palette, template constraints.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
  };

  async function executeToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    const timestamp = Date.now();
    const fail = (text: string, images: VisualReviewImageDetails[] = []): ToolResultMessage => ({
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text }],
      details: {
        kind: "visual_review",
        providerId: review.providerId,
        model: review.model,
        source: review.source,
        reviewed: false,
        images,
      } satisfies VisualReviewResultDetails,
      isError: true,
      timestamp,
    });

    if (toolCall.name !== VISUAL_REVIEW_TOOL_NAME) {
      return fail(`Unknown tool: ${toolCall.name}`);
    }
    const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
    const paths = normalizePaths(args.paths ?? args.path);
    const question = typeof args.question === "string" ? args.question.trim() : "";
    const extraContext = typeof args.context === "string" ? args.context.trim() : "";
    if (paths.length === 0) {
      return fail("VisualReview requires at least one image path in `paths`.");
    }
    if (paths.length > MAX_REVIEW_IMAGES) {
      return fail(`VisualReview accepts at most ${MAX_REVIEW_IMAGES} images per call.`);
    }
    if (!question) {
      return fail(
        "VisualReview requires `question`: say what to check and which pages the images show.",
      );
    }

    const inputs = deps.resolveModelInput(review);
    if (!inputs.includes("image")) {
      return fail(
        [
          `VisualReview was NOT performed: model ${review.model} (${review.source === "configured" ? "visual review model" : "current chat model"}) does not accept image input.`,
          "Configure a vision-capable model under Settings → Providers → Custom settings → Visual review model, or report that visual verification was not done.",
        ].join(" "),
      );
    }

    const images: VisualReviewImageDetails[] = [];
    const blocks: ImageContent[] = [];
    for (const [index, raw] of paths.entries()) {
      const label = paths.length > 1 ? `VisualReview.paths[${index}]` : "VisualReview.paths";
      let resolved: Awaited<ReturnType<ToolPathResolver["resolvePath"]>>;
      try {
        resolved = await pathResolver.resolvePath(raw, {
          label,
          intent: "image",
          required: true,
          allowExternal: true,
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error), images);
      }
      const source =
        resolved.scope === "external"
          ? resolved.absolutePath
          : resolved.relativePath || resolved.absolutePath;
      let response: ReadImageResponse;
      try {
        response = await invokeFs<ReadImageResponse>("fs_read_image_source", {
          workdir: resolved.scope === "external" ? workdir : resolved.root,
          source,
          source_type: "path",
        });
      } catch (error) {
        return fail(
          `VisualReview could not read ${formatResolvedTarget(resolved)}: ${error instanceof Error ? error.message : String(error)}`,
          images,
        );
      }
      const mimeType = String(response.mimeType || "").toLowerCase();
      if (!response.data || !mimeType) {
        return fail(
          `VisualReview could not load image bytes for ${formatResolvedTarget(resolved)}.`,
          images,
        );
      }
      if (mimeType === "image/svg+xml") {
        return fail(
          `${formatResolvedTarget(resolved)} is an SVG. Review its rasterized preview instead (for deck assets: .arcforge-assets/<asset id>/raster.png after validate).`,
          images,
        );
      }
      images.push({
        path: resolved.displayPath,
        mimeType,
        sizeBytes: typeof response.sizeBytes === "number" ? response.sizeBytes : 0,
      });
      blocks.push({ type: "image", data: response.data, mimeType });
    }

    const intro: TextContent = {
      type: "text",
      text: [
        `Images (${images.length}):`,
        ...images.map((image, index) => `${index + 1}. ${image.path}`),
        "",
        extraContext ? `Context: ${extraContext}\n` : "",
        `Question: ${question}`,
      ]
        .filter((line) => line !== undefined)
        .join("\n"),
    };
    const context: Context = {
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [intro, ...blocks],
          timestamp,
        },
      ],
    };

    try {
      const assistant = await deps.complete({
        providerId: review.providerId,
        model: review.model,
        runtime: {
          ...review.runtime,
          reasoning: "off",
          promptCachingEnabled: false,
          nativeWebSearchEnabled: false,
        },
        context,
        cacheRetention: "none",
        signal,
      });
      const answer = assistantMessageToText(assistant).trim();
      if (!answer) {
        return fail(`VisualReview: model ${review.model} returned no text.`, images);
      }
      const header = `Reviewed ${images.length} image${images.length === 1 ? "" : "s"} with ${review.model} (${review.source === "configured" ? "visual review model" : "current chat model"}).`;
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: `${header}\n\n${answer}` }],
        details: {
          kind: "visual_review",
          providerId: review.providerId,
          model: review.model,
          source: review.source,
          reviewed: true,
          images,
        } satisfies VisualReviewResultDetails,
        isError: false,
        timestamp,
      };
    } catch (error) {
      return fail(
        `VisualReview failed while calling ${review.model}: ${error instanceof Error ? error.message : String(error)}`,
        images,
      );
    }
  }

  return {
    groupId: "system",
    tools: [tool],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        VISUAL_REVIEW_TOOL_NAME,
        {
          groupId: "system",
          kind: "visual_review",
          isReadOnly: true,
          displayCategory: "system",
        },
      ],
    ]),
  };
}
