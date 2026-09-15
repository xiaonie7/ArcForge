import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";
import { Type } from "typebox";

import { emitArtifactChange } from "../artifactReview/events";
import {
  type BuiltinToolBundle,
  createBuiltinMetadataMap,
  type DocumentArtifactSummary,
  type DisplayFileItemDetails,
  type DisplayFilePreviewKind,
} from "./builtinTypes";
import { ToolPathResolver } from "./pathUtils";

type OfficeRuntimeResponse = {
  success: boolean;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  runtime: string;
  runtimePath: string;
  artifact?: DocumentArtifactSummary;
  artifactError?: string;
};

type OfficeRuntimeCancelResponse = {
  cancelled: boolean;
};

type WorkspaceArtifactDescriptor = {
  path: string;
  relativePath?: string | null;
  fileName: string;
  mimeType?: string | null;
  previewKind?: DisplayFilePreviewKind | null;
  sizeBytes: number;
  mtimeMs: number;
  fileId?: string | null;
  previewSupported: boolean;
};

type DescribeWorkspaceArtifactsResponse = {
  files: WorkspaceArtifactDescriptor[];
};

const OFFICE_RUNTIME_TOOL_NAME = "OfficeRuntime";

/** `deck.changed_slide_ids` from a presentation create result → review units. */
function extractChangedUnits(parsedOutput: unknown): { type: string; id: string }[] | undefined {
  if (!parsedOutput || typeof parsedOutput !== "object") return undefined;
  const deck = (parsedOutput as { deck?: unknown }).deck;
  if (!deck || typeof deck !== "object") return undefined;
  const ids = (deck as { changed_slide_ids?: unknown }).changed_slide_ids;
  if (!Array.isArray(ids)) return undefined;
  return ids
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .map((id) => ({ type: "slide", id }));
}
const SPREADSHEET_CODE_TOOL_NAME = "SpreadsheetCode";
const OFFICE_RUNTIME_ARGUMENTS = new Set([
  "document",
  "action",
  "spec_path",
  "input_path",
  "output_path",
  "force",
  "timeout_seconds",
]);
const SPREADSHEET_CODE_ARGUMENTS = new Set([
  "script_path",
  "input_path",
  "output_path",
  "force",
  "timeout_seconds",
]);

const officeRuntimeTool: Tool = {
  name: OFFICE_RUNTIME_TOOL_NAME,
  description:
    "Create, patch, inspect, validate, or render Office deliverables with ArcForge's bundled local runtime. " +
    "Use document=spreadsheet for XLSX create/patch/inspect. Use document=presentation for PPTX " +
    "create (a schema_version 3 deck manifest, optionally with input_path as the template PPTX; " +
    "reuse original template pages with source_slide plus text_edits/table_edits using shape ids from inspect, or author SVG pages; " +
    "manifest assets may be raster pictures or SVG icons/logos that become native shapes), " +
    "validate (layout and resource relationships, also normalizes SVG assets into .arcforge-assets/), inspect (editable elements, layouts, protected regions, theme, relationship errors), and render " +
    "(.pdf via LibreOffice or .png page previews via OfficeCLI; spec_path may hold {\"pages\":\"2\"}). " +
    "Use document=word for DOCX create/patch/inspect/validate and HTML/PNG render. " +
    "Paths must stay inside the current workspace.",
  parameters: Type.Object(
    {
      document: Type.Union([
        Type.Literal("spreadsheet"),
        Type.Literal("presentation"),
        Type.Literal("word"),
      ]),
      action: Type.Union([
        Type.Literal("create"),
        Type.Literal("patch"),
        Type.Literal("inspect"),
        Type.Literal("validate"),
        Type.Literal("render"),
      ]),
      spec_path: Type.Optional(
        Type.String({
          description:
            "Workspace JSON specification path: spreadsheet/presentation create, presentation validate, spreadsheet/word patch, or optional presentation PNG render options.",
        }),
      ),
      input_path: Type.Optional(
        Type.String({
          description:
            "Workspace XLSX, PPTX, or DOCX input path for patch, inspect, validate, or render; for presentation create/validate it is the optional template PPTX.",
        }),
      ),
      output_path: Type.Optional(
        Type.String({
          description:
            "Workspace XLSX, PPTX, DOCX, PDF, HTML, or PNG destination path, depending on the action.",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description: "Overwrite the exact destination only when the user explicitly approved it.",
        }),
      ),
      timeout_seconds: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 600,
          description: "Execution timeout in seconds; defaults to 180.",
        }),
      ),
    },
    { additionalProperties: false },
  ),
};

const spreadsheetCodeTool: Tool = {
  name: SPREADSHEET_CODE_TOOL_NAME,
  description:
    "Run a reviewed workbook-only Python script with ArcForge's bundled spreadsheet runtime. " +
    "The script receives an in-memory workbook and approved openpyxl helpers, cannot import modules " +
    "or access paths, and must leave loading and saving to ArcForge. Use this only when structured " +
    "OfficeRuntime create/patch operations are insufficient.",
  parameters: Type.Object(
    {
      script_path: Type.String({
        description: "Workspace .py file containing workbook-only transformation code.",
      }),
      input_path: Type.Optional(
        Type.String({
          description: "Optional workspace XLSX input; omit to start with a new workbook.",
        }),
      ),
      output_path: Type.String({ description: "Workspace XLSX destination path." }),
      force: Type.Optional(
        Type.Boolean({
          description: "Overwrite the exact destination only when the user explicitly approved it.",
        }),
      ),
      timeout_seconds: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 600,
          description: "Execution timeout in seconds; defaults to 180.",
        }),
      ),
    },
    { additionalProperties: false },
  ),
};

function asErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function createRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `office-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

function requestCancellation(requestId: string) {
  void (async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const response = await invoke<OfficeRuntimeCancelResponse>("office_runtime_cancel", {
          request_id: requestId,
        });
        if (response.cancelled) return;
      } catch {
        return;
      }
      await delay(50);
    }
  })();
}

function validateArguments(
  args: unknown,
  toolName: string,
  allowedArguments: ReadonlySet<string>,
): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`${toolName} arguments must be an object`);
  }
  const values = args as Record<string, unknown>;
  const unknown = Object.keys(values).filter((key) => !allowedArguments.has(key));
  if (unknown.length > 0) {
    throw new Error(`${toolName} received unsupported arguments: ${unknown.join(", ")}`);
  }
  return values;
}

function resultText(result: OfficeRuntimeResponse) {
  if (result.success) {
    const truncation =
      result.stdoutTruncated || result.stderrTruncated
        ? "\nwarning: runtime output was truncated"
        : "";
    return `${result.stdout.trim() || "Office Runtime completed successfully."}${truncation}`;
  }
  if (result.cancelled) return "Office Runtime execution was cancelled.";
  if (result.timedOut) return "Office Runtime execution timed out.";
  return (
    result.stderr.trim() ||
    result.stdout.trim() ||
    `Office Runtime failed with exit code ${result.exitCode ?? "unknown"}.`
  );
}

export function createOfficeRuntimeTools(params: { workdir: string }): BuiltinToolBundle {
  const pathResolver = new ToolPathResolver({ workdir: params.workdir });

  async function describeGeneratedOutput(outputPath: unknown): Promise<DisplayFileItemDetails> {
    if (typeof outputPath !== "string" || !outputPath.trim()) {
      throw new Error("Office Runtime did not provide an output path");
    }
    const resolved = await pathResolver.resolvePath(outputPath, {
      label: "OfficeRuntime.output_path",
      intent: "read",
      required: true,
    });
    if (resolved.scope !== "workspace" || !resolved.relativePath) {
      throw new Error("Office Runtime output must resolve to a workspace file");
    }
    const response = await invoke<DescribeWorkspaceArtifactsResponse>(
      "fs_describe_workspace_artifacts",
      {
        workdir: params.workdir,
        paths: [resolved.relativePath],
      },
    );
    const file = response?.files?.[0];
    if (!file || response.files.length !== 1) {
      throw new Error("workspace artifact descriptor response did not contain the output file");
    }
    const backendPath =
      typeof file.relativePath === "string" && file.relativePath.trim()
        ? file.relativePath.trim()
        : typeof file.path === "string"
          ? file.path.trim()
          : "";
    const relativePath = backendPath || resolved.relativePath;
    const fileName =
      typeof file.fileName === "string" && file.fileName.trim()
        ? file.fileName
        : relativePath.split("/").filter(Boolean).at(-1) || relativePath;
    return {
      path: relativePath,
      relativePath,
      fileName,
      mimeType: typeof file.mimeType === "string" && file.mimeType ? file.mimeType : undefined,
      previewKind: file.previewKind ?? undefined,
      sizeBytes: typeof file.sizeBytes === "number" ? file.sizeBytes : 0,
      mtimeMs: typeof file.mtimeMs === "number" ? file.mtimeMs : 0,
      fileId: typeof file.fileId === "string" && file.fileId ? file.fileId : undefined,
      previewSupported: file.previewSupported === true,
    };
  }

  async function executeToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    const timestamp = Date.now();
    if (
      toolCall.name !== OFFICE_RUNTIME_TOOL_NAME &&
      toolCall.name !== SPREADSHEET_CODE_TOOL_NAME
    ) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: `Unknown tool: ${toolCall.name}` }],
        details: {},
        isError: true,
        timestamp,
      };
    }
    if (signal?.aborted) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "Cancelled" }],
        details: {},
        isError: true,
        timestamp,
      };
    }

    const requestId = createRequestId();
    const onAbort = () => requestCancellation(requestId);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const isSpreadsheetCode = toolCall.name === SPREADSHEET_CODE_TOOL_NAME;
      const args = validateArguments(
        toolCall.arguments,
        toolCall.name,
        isSpreadsheetCode ? SPREADSHEET_CODE_ARGUMENTS : OFFICE_RUNTIME_ARGUMENTS,
      );
      const timeoutSeconds =
        typeof args.timeout_seconds === "number" ? args.timeout_seconds : undefined;
      const result = await invoke<OfficeRuntimeResponse>("office_runtime_execute", {
        input: {
          requestId,
          workdir: params.workdir,
          documentType: isSpreadsheetCode ? "spreadsheet" : args.document,
          action: isSpreadsheetCode ? "code" : args.action,
          specPath: args.spec_path,
          scriptPath: args.script_path,
          inputPath: args.input_path,
          outputPath: args.output_path,
          force: args.force === true,
          timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1_000,
        },
      });
      let parsedOutput: unknown;
      if (result.stdout.trim()) {
        try {
          parsedOutput = JSON.parse(result.stdout);
        } catch {
          parsedOutput = undefined;
        }
      }
      const displayPath = args.action === "validate" ? args.input_path : args.output_path;
      let generatedFile: DisplayFileItemDetails | undefined;
      let previewError: string | undefined;
      if (result.success && typeof displayPath === "string" && displayPath.trim()) {
        try {
          generatedFile = await describeGeneratedOutput(displayPath);
        } catch (error) {
          previewError = asErrorMessage(error);
        }
      }
      const warnings = [
        result.artifactError
          ? `document version metadata unavailable: ${result.artifactError}`
          : undefined,
        previewError ? `generated file preview unavailable: ${previewError}` : undefined,
      ].filter((warning): warning is string => Boolean(warning));
      const text = [resultText(result), ...warnings.map((warning) => `warning: ${warning}`)].join(
        "\n",
      );
      const generatedFileWithArtifact = result.artifact
        ? { ...generatedFile, artifact: result.artifact }
        : generatedFile;
      const changedUnits = extractChangedUnits(parsedOutput);
      if (
        result.success &&
        args.document === "presentation" &&
        args.action === "create" &&
        typeof args.output_path === "string" &&
        args.output_path.trim()
      ) {
        emitArtifactChange({
          workdir: params.workdir,
          path: args.output_path.trim(),
          artifactType: "pptx",
          changedUnits: changedUnits ?? "all",
        });
      }
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text }],
        details: generatedFile
          ? {
              ...result,
              parsedOutput,
              changedUnits,
              kind: "display_file",
              files: [generatedFileWithArtifact],
            }
          : { ...result, parsedOutput, changedUnits, previewError },
        isError: !result.success,
        timestamp,
      };
    } catch (error) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: `Office Runtime failed: ${asErrorMessage(error)}` }],
        details: {},
        isError: true,
        timestamp,
      };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  return {
    groupId: "office",
    tools: [officeRuntimeTool, spreadsheetCodeTool],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        OFFICE_RUNTIME_TOOL_NAME,
        {
          groupId: "office",
          kind: "office_runtime",
          isReadOnly: false,
          displayCategory: "file",
        },
      ],
      [
        SPREADSHEET_CODE_TOOL_NAME,
        {
          groupId: "office",
          kind: "spreadsheet_code",
          isReadOnly: false,
          displayCategory: "file",
        },
      ],
    ]),
  };
}
