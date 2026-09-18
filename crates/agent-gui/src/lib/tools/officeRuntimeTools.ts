import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";
import { Type } from "typebox";

import { isRestrictedEditScope, parseArtifactEditResult } from "../artifactReview/editScope";
import { artifactPathsMatch, emitArtifactChange } from "../artifactReview/events";
import type { ArtifactEditScope } from "../artifactReview/types";
import {
  type BuiltinToolBundle,
  createBuiltinMetadataMap,
  type DisplayFileItemDetails,
  type DisplayFilePreviewKind,
  type DocumentArtifactSummary,
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

/** `deck.changed_slide_ids` from a presentation create/patch result → review units. */
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

function sharedInputsChanged(parsedOutput: unknown) {
  if (!parsedOutput || typeof parsedOutput !== "object") return false;
  const deck = (parsedOutput as { deck?: unknown }).deck;
  return Boolean(
    deck &&
      typeof deck === "object" &&
      (deck as { shared_inputs_changed?: unknown }).shared_inputs_changed === true,
  );
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
  "slide_id",
  "element_id",
  "replacement",
  "edit_id",
  "revert",
]);
const PRESENTATION_PATCH_ARGUMENTS = [
  "slide_id",
  "element_id",
  "replacement",
  "edit_id",
  "revert",
] as const;
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
    "patch (change ONE page or ONE element of a deck built from a manifest: spec_path=manifest, output_path=the built deck, slide_id, optional element_id, and replacement = the complete new SVG element / page SVG / JSON template edit; the runtime snapshots the old content, rebuilds, and reports changed_slide_ids; revert=<edit_id> undoes an edit), " +
    "validate (layout and resource relationships, also normalizes SVG assets into .arcforge-assets/), inspect (editable elements, layouts, protected regions, theme, relationship errors), and render " +
    '(.pdf via LibreOffice or .png page previews via OfficeCLI; spec_path may hold {"pages":"2"}). ' +
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
      slide_id: Type.Optional(
        Type.String({
          description: "presentation patch: manifest slide_id of the page to change.",
        }),
      ),
      element_id: Type.Optional(
        Type.String({
          description:
            "presentation patch: SVG element id (or template shape name) inside that page; omit to replace the whole page.",
        }),
      ),
      replacement: Type.Optional(
        Type.String({
          description:
            'presentation patch: the complete new content. One SVG element keeping the same id and data-role for an element; the whole page SVG for a page; {"text": ...} or {"rows": [...]} for a template shape.',
        }),
      ),
      edit_id: Type.Optional(
        Type.String({
          description: "presentation patch: stable id for the snapshot; generated when omitted.",
        }),
      ),
      revert: Type.Optional(
        Type.String({
          description:
            "presentation patch: undo the edit with this id instead of applying a replacement.",
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

export function createOfficeRuntimeTools(params: {
  workdir: string;
  /** Inline review edit lock: patch may target only this unit/element; create is refused. */
  editScope?: ArtifactEditScope;
}): BuiltinToolBundle {
  const pathResolver = new ToolPathResolver({ workdir: params.workdir });
  const lock = isRestrictedEditScope(params.editScope) ? params.editScope : null;

  /** Enforce the scope lock before anything reaches the runtime. */
  function applyEditScope(args: Record<string, unknown>) {
    const isPresentation = args.document === "presentation";
    const usesPatchArguments = PRESENTATION_PATCH_ARGUMENTS.some((key) => args[key] !== undefined);
    if (usesPatchArguments && !(isPresentation && args.action === "patch")) {
      throw new Error(
        "slide_id, element_id, replacement, edit_id and revert are only valid for document=presentation action=patch",
      );
    }
    if (!lock) return;
    if (!artifactPathsMatch(params.workdir, lock.artifact.workdir) || !lock.manifestPath) {
      throw new Error("The scoped edit must use the reviewed workspace and its linked manifest.");
    }
    if (!isPresentation) {
      throw new Error(
        "Only the presentation being reviewed can change during a scoped inline edit.",
      );
    }
    if (!["patch", "inspect", "validate", "render"].includes(String(args.action))) {
      throw new Error(
        `Scoped inline edit: use action=patch with slide_id="${lock.unitId}"${lock.elementId ? ` and element_id="${lock.elementId}"` : ""} instead of rebuilding the deck with create.`,
      );
    }
    if (args.action === "inspect") {
      if (
        typeof args.input_path !== "string" ||
        ![lock.artifact.path, lock.templatePath].some(
          (path) => path && artifactPathsMatch(args.input_path as string, path),
        ) ||
        args.output_path !== undefined ||
        args.spec_path !== undefined
      ) {
        throw new Error("Scoped inspection may only read the reviewed deck or its template.");
      }
      return;
    }
    if (args.action === "render") {
      const previewPath = `.arcforge-review/${lock.editId}.png`;
      if (
        typeof args.input_path !== "string" ||
        !artifactPathsMatch(args.input_path, lock.artifact.path) ||
        args.spec_path !== undefined ||
        (args.output_path !== undefined &&
          !artifactPathsMatch(String(args.output_path), previewPath))
      ) {
        throw new Error(`Scoped rendering may only preview the reviewed deck into ${previewPath}.`);
      }
      args.output_path = previewPath;
      args.force = true;
      return;
    }
    if (args.action === "validate") {
      if (
        typeof args.spec_path !== "string" ||
        !artifactPathsMatch(args.spec_path, lock.manifestPath) ||
        args.output_path !== undefined ||
        (args.input_path !== undefined &&
          (!lock.templatePath || !artifactPathsMatch(String(args.input_path), lock.templatePath)))
      ) {
        throw new Error("Scoped validation must use the linked manifest and original template.");
      }
      args.input_path = lock.templatePath;
      args.force = false;
      return;
    }
    if (args.revert !== undefined) {
      throw new Error(
        "Reverting edits is done from the review panel, not inside a scoped edit turn.",
      );
    }
    const slideId = typeof args.slide_id === "string" ? args.slide_id.trim() : "";
    const elementId = typeof args.element_id === "string" ? args.element_id.trim() : "";
    if (slideId !== lock.unitId) {
      throw new Error(
        `Scope violation: this edit is locked to slide_id "${lock.unitId}"; "${slideId || "(none)"}" was refused and nothing changed.`,
      );
    }
    if (lock.kind === "element" && elementId !== lock.elementId) {
      throw new Error(
        `Scope violation: this edit is locked to element_id "${lock.elementId}" on slide "${lock.unitId}"; "${elementId || "(whole page)"}" was refused and nothing changed.`,
      );
    }
    if (lock.kind === "unit" && elementId) {
      throw new Error(
        "A page-scoped edit must replace the whole page: omit element_id. Corrections share one undo record.",
      );
    }
    const outputPath = typeof args.output_path === "string" ? args.output_path.trim() : "";
    if (!artifactPathsMatch(outputPath, lock.artifact.path)) {
      throw new Error(
        `Scope violation: output_path must be the reviewed deck "${lock.artifact.path}".`,
      );
    }
    if (lock.manifestPath) {
      const specPath = typeof args.spec_path === "string" ? args.spec_path.trim() : "";
      if (!artifactPathsMatch(specPath, lock.manifestPath)) {
        throw new Error(
          `Scope violation: spec_path must be the deck manifest "${lock.manifestPath}".`,
        );
      }
    }
    if (
      args.input_path !== undefined &&
      (typeof args.input_path !== "string" ||
        !lock.templatePath ||
        !artifactPathsMatch(args.input_path, lock.templatePath))
    ) {
      throw new Error("Scope violation: input_path must be the deck's original template.");
    }
    if (args.edit_id !== undefined && args.edit_id !== lock.editId) {
      throw new Error("Scope violation: edit_id must match the current inline edit.");
    }
    // Corrections to this target preserve the first snapshot and update its latest result.
    args.edit_id = lock.editId;
    args.input_path = lock.templatePath;
  }

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
      if (lock && isSpreadsheetCode)
        throw new Error("SpreadsheetCode is unavailable during a scoped presentation edit.");
      const args = validateArguments(
        { ...toolCall.arguments },
        toolCall.name,
        isSpreadsheetCode ? SPREADSHEET_CODE_ARGUMENTS : OFFICE_RUNTIME_ARGUMENTS,
      );
      if (!isSpreadsheetCode) applyEditScope(args);
      const timeoutSeconds =
        typeof args.timeout_seconds === "number" ? args.timeout_seconds : undefined;
      const isPresentationPatch =
        !isSpreadsheetCode && args.document === "presentation" && args.action === "patch";
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
          ...(isPresentationPatch
            ? {
                edit: {
                  slideId: args.slide_id,
                  elementId: args.element_id,
                  replacement: args.replacement,
                  editId: args.edit_id,
                  revert: args.revert,
                },
              }
            : {}),
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
      const editResult = isPresentationPatch ? parseArtifactEditResult(parsedOutput) : null;
      if (
        result.success &&
        args.document === "presentation" &&
        (args.action === "create" || args.action === "patch") &&
        typeof args.output_path === "string" &&
        args.output_path.trim()
      ) {
        emitArtifactChange({
          workdir: params.workdir,
          path: args.output_path.trim(),
          artifactType: "pptx",
          changedUnits: !changedUnits || sharedInputsChanged(parsedOutput) ? "all" : changedUnits,
          ...(editResult ? { edit: editResult } : {}),
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
              editResult,
              kind: "display_file",
              files: [generatedFileWithArtifact],
            }
          : { ...result, parsedOutput, changedUnits, editResult, previewError },
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
    tools: lock
      ? [
          {
            ...officeRuntimeTool,
            description: `Edit only ${lock.unitId}${lock.elementId ? ` / ${lock.elementId}` : ""} in ${lock.artifact.path}. Use patch; create and revert are unavailable. Inspect the reviewed deck or template, validate the linked manifest, or render the deck into .arcforge-review/${lock.editId}.png. Repeated patches share one undo record.`,
            parameters: Type.Object(
              {
                ...(officeRuntimeTool.parameters as { properties: Record<string, any> }).properties,
                document: Type.Literal("presentation"),
                action: Type.Union([
                  Type.Literal("patch"),
                  Type.Literal("inspect"),
                  Type.Literal("validate"),
                  Type.Literal("render"),
                ]),
              },
              { additionalProperties: false },
            ),
          },
        ]
      : [officeRuntimeTool, spreadsheetCodeTool],
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
