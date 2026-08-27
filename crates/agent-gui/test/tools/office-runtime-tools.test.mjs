import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const toolSource = readFileSync(
  new URL("../../src/lib/tools/officeRuntimeTools.ts", import.meta.url),
  "utf8",
);
const registrySource = readFileSync(
  new URL("../../src/lib/tools/builtinRegistry.ts", import.meta.url),
  "utf8",
);
const rustSource = readFileSync(
  new URL("../../src-tauri/src/commands/workspace/office_runtime.rs", import.meta.url),
  "utf8",
);
const windowsConfig = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.windows.conf.json", import.meta.url), "utf8"),
);
const officeCliLicense = readFileSync(
  new URL("../../src-tauri/third-party/officecli/LICENSE", import.meta.url),
  "utf8",
);
const officeCliNotice = readFileSync(
  new URL("../../src-tauri/third-party/officecli/NOTICE", import.meta.url),
  "utf8",
);
const officeCliThirdPartyNotices = readFileSync(
  new URL("../../src-tauri/third-party/officecli/THIRD-PARTY-NOTICES.txt", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);
const buildScript = readFileSync(
  new URL("../../scripts/build-office-sidecar.ps1", import.meta.url),
  "utf8",
);
const officeCliBuildScript = readFileSync(
  new URL("../../scripts/build-officecli-sidecar.ps1", import.meta.url),
  "utf8",
);
const gatewayBuildScript = readFileSync(
  new URL("../../scripts/build-gateway-sidecar.ps1", import.meta.url),
  "utf8",
);
const sidecarBuildScript = readFileSync(
  new URL("../../scripts/build-sidecars.ps1", import.meta.url),
  "utf8",
);

test("OfficeRuntime is registered as a structured builtin tool", () => {
  assert.match(toolSource, /name: OFFICE_RUNTIME_TOOL_NAME/);
  assert.match(toolSource, /name: SPREADSHEET_CODE_TOOL_NAME/);
  assert.match(toolSource, /Type\.Literal\("word"\)/);
  assert.match(toolSource, /Type\.Literal\("validate"\)/);
  assert.match(toolSource, /document=word/);
  assert.match(toolSource, /HTML\/PNG render/);
  assert.match(toolSource, /tools: \[officeRuntimeTool, spreadsheetCodeTool\]/);
  assert.match(toolSource, /scriptPath: args\.script_path/);
  assert.match(toolSource, /office_runtime_execute/);
  assert.match(toolSource, /office_runtime_cancel/);
  assert.match(registrySource, /createOfficeRuntimeTools/);
  assert.match(registrySource, /createOfficeRuntimeTools\(\{ workdir: params\.workdir \}\)/);
});

test("successful OfficeRuntime outputs become native generated-file artifacts", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "office_runtime_execute") {
            return {
              success: true,
              exitCode: 0,
              stdout: '{"created":true}',
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
              timedOut: false,
              cancelled: false,
              durationMs: 125,
              runtime: "officecli",
              runtimePath: "arcforge-officecli.exe",
              artifact: {
                artifactId: "a2d76d44-a136-4890-9581-bc85b8ac9ef5",
                artifactKind: "document",
                documentType: "word",
                outputPath: "reports/brief.docx",
                currentVersion: 1,
                createdAt: "2026-08-26T08:00:00.000Z",
                updatedAt: "2026-08-26T08:00:00.000Z",
                format: "docx",
                mimeType:
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                action: "create",
                provider: "officecli",
                sizeBytes: 23_456,
                sha256: "abc123",
                previewCount: 0,
                validationCount: 0,
                artifactRole: "primary",
              },
            };
          }
          assert.equal(command, "fs_describe_workspace_artifacts");
          return {
            files: [
              {
                path: "reports/brief.docx",
                relativePath: "reports/brief.docx",
                fileName: "brief.docx",
                mimeType:
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                previewKind: "document",
                sizeBytes: 23_456,
                mtimeMs: 1_700_000_000_000,
                fileId: "artifact-1",
                previewSupported: true,
              },
            ],
          };
        },
      },
    },
  });
  const { createOfficeRuntimeTools } = loader.loadModule("src/lib/tools/officeRuntimeTools.ts");
  const bundle = createOfficeRuntimeTools({ workdir: "C:/workspace" });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "office-1",
    name: "OfficeRuntime",
    arguments: {
      document: "word",
      action: "create",
      spec_path: "specs/brief.json",
      output_path: "reports/brief.docx",
    },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.kind, "display_file");
  assert.deepEqual(result.details.parsedOutput, { created: true });
  assert.deepEqual(result.details.files, [
    {
      path: "reports/brief.docx",
      relativePath: "reports/brief.docx",
      fileName: "brief.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      previewKind: "document",
      sizeBytes: 23_456,
      mtimeMs: 1_700_000_000_000,
      fileId: "artifact-1",
      previewSupported: true,
      artifact: {
        artifactId: "a2d76d44-a136-4890-9581-bc85b8ac9ef5",
        artifactKind: "document",
        documentType: "word",
        outputPath: "reports/brief.docx",
        currentVersion: 1,
        createdAt: "2026-08-26T08:00:00.000Z",
        updatedAt: "2026-08-26T08:00:00.000Z",
        format: "docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        action: "create",
        provider: "officecli",
        sizeBytes: 23_456,
        sha256: "abc123",
        previewCount: 0,
        validationCount: 0,
        artifactRole: "primary",
      },
    },
  ]);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].command, "office_runtime_execute");
  assert.deepEqual(invocations[1], {
    command: "fs_describe_workspace_artifacts",
    args: {
      workdir: "C:/workspace",
      paths: ["reports/brief.docx"],
    },
  });
});

test("artifact description failures do not change a successful OfficeRuntime result to an error", async () => {
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command) {
          if (command === "office_runtime_execute") {
            return {
              success: true,
              exitCode: 0,
              stdout: "created",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
              timedOut: false,
              cancelled: false,
              durationMs: 125,
              runtime: "officecli",
              runtimePath: "arcforge-officecli.exe",
            };
          }
          throw new Error("descriptor unavailable");
        },
      },
    },
  });
  const { createOfficeRuntimeTools } = loader.loadModule("src/lib/tools/officeRuntimeTools.ts");
  const bundle = createOfficeRuntimeTools({ workdir: "C:/workspace" });
  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "office-2",
    name: "OfficeRuntime",
    arguments: {
      document: "word",
      action: "create",
      spec_path: "brief.json",
      output_path: "brief.docx",
    },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.kind, undefined);
  assert.equal(result.details.previewError, "descriptor unavailable");
  assert.match(result.content[0].text, /generated file preview unavailable/);
});

test("successful validation refreshes the source document card with its artifact status", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "office_runtime_execute") {
            return {
              success: true,
              exitCode: 0,
              stdout: '{"valid":true}',
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
              timedOut: false,
              cancelled: false,
              durationMs: 125,
              runtime: "officecli",
              runtimePath: "arcforge-officecli.exe",
              artifact: {
                artifactId: "a2d76d44-a136-4890-9581-bc85b8ac9ef5",
                artifactKind: "document",
                documentType: "word",
                outputPath: "reports/brief.docx",
                currentVersion: 2,
                createdAt: "2026-08-26T08:00:00.000Z",
                updatedAt: "2026-08-26T08:01:00.000Z",
                format: "docx",
                mimeType:
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                action: "patch",
                provider: "officecli",
                sizeBytes: 23_456,
                sha256: "def456",
                previewCount: 0,
                validationCount: 1,
                latestValidationStatus: "passed",
                artifactRole: "primary",
              },
            };
          }
          assert.equal(command, "fs_describe_workspace_artifacts");
          return {
            files: [
              {
                path: "reports/brief.docx",
                relativePath: "reports/brief.docx",
                fileName: "brief.docx",
                mimeType:
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                previewKind: "document",
                sizeBytes: 23_456,
                mtimeMs: 1_700_000_000_000,
                fileId: "artifact-1",
                previewSupported: true,
              },
            ],
          };
        },
      },
    },
  });
  const { createOfficeRuntimeTools } = loader.loadModule("src/lib/tools/officeRuntimeTools.ts");
  const bundle = createOfficeRuntimeTools({ workdir: "C:/workspace" });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "office-validate",
    name: "OfficeRuntime",
    arguments: {
      document: "word",
      action: "validate",
      input_path: "reports/brief.docx",
    },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.kind, "display_file");
  assert.equal(result.details.files[0].relativePath, "reports/brief.docx");
  assert.equal(result.details.files[0].artifact.currentVersion, 2);
  assert.equal(result.details.files[0].artifact.latestValidationStatus, "passed");
  assert.deepEqual(invocations[1], {
    command: "fs_describe_workspace_artifacts",
    args: {
      workdir: "C:/workspace",
      paths: ["reports/brief.docx"],
    },
  });
});

test("OfficeRuntime Rust bridge enforces workspace paths and bounded execution", () => {
  assert.match(rustSource, /ensure_within_workspace/);
  assert.match(rustSource, /MAX_TIMEOUT_MS/);
  assert.match(rustSource, /STDOUT_LIMIT_BYTES/);
  assert.match(rustSource, /ARCFORGE_OFFICE_RUNTIME_PATH/);
  assert.match(rustSource, /development-python-fallback/);
  assert.match(rustSource, /\("spreadsheet", "code"\)/);
  assert.match(rustSource, /required_path\(&input\.script_path, "scriptPath"\)/);
});

test("Windows desktop builds include all generated sidecars", () => {
  assert.deepEqual(windowsConfig.bundle.resources, [
    "third-party/officecli/LICENSE",
    "third-party/officecli/NOTICE",
    "third-party/officecli/THIRD-PARTY-NOTICES.txt",
  ]);
  assert.match(officeCliLicense, /Apache License\s+Version 2\.0/);
  assert.match(officeCliNotice, /Copyright 2026 OfficeCLI/);
  assert.match(officeCliThirdPartyNotices, /DocumentFormat\.OpenXml \(3\.4\.1\)/);
  assert.deepEqual(windowsConfig.bundle.externalBin, [
    "binaries/arcforge-office-runtime",
    "binaries/arcforge-officecli",
    "binaries/arcforge-gateway",
    "binaries/arcforge-wecom-connector",
  ]);
  assert.match(packageJson.scripts["sidecar:build"], /build-sidecars\.ps1/);
  assert.match(packageJson.scripts["build:desktop"], /sidecar:build/);
  assert.match(packageJson.scripts["dev:desktop"], /sidecar:build/);
  assert.match(sidecarBuildScript, /build-office-sidecar\.ps1/);
  assert.match(sidecarBuildScript, /build-officecli-sidecar\.ps1/);
  assert.match(sidecarBuildScript, /build-gateway-sidecar\.ps1/);
  assert.match(sidecarBuildScript, /build-wecom-connector-sidecar\.ps1/);
  assert.match(buildScript, /PyInstaller/);
  assert.match(buildScript, /arcforge-office-runtime-\$TargetTriple\.exe/);
  assert.match(officeCliBuildScript, /\$officeCliVersion = "1\.0\.144"/);
  assert.match(
    officeCliBuildScript,
    /e780cc6a5385f84b4d54d71b0c179904ed534125ec33fe39b1a8711fa80e387e/,
  );
  assert.match(officeCliBuildScript, /Get-FileHash -LiteralPath \$binaryPath/);
  assert.match(officeCliBuildScript, /arcforge-officecli-\$TargetTriple\.exe/);
  assert.match(gatewayBuildScript, /install --frozen-lockfile/);
  assert.match(gatewayBuildScript, /run build/);
  assert.match(gatewayBuildScript, /arcforge-gateway-\$TargetTriple\.exe/);

  const webBuildOffset = gatewayBuildScript.lastIndexOf("Build-GatewayWebAssets");
  const goBuildOffset = gatewayBuildScript.indexOf("& $resolvedGo build");
  assert.ok(webBuildOffset >= 0 && webBuildOffset < goBuildOffset);
});
