import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);
const buildScript = readFileSync(
  new URL("../../scripts/build-office-sidecar.ps1", import.meta.url),
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
  assert.match(toolSource, /tools: \[officeRuntimeTool, spreadsheetCodeTool\]/);
  assert.match(toolSource, /scriptPath: args\.script_path/);
  assert.match(toolSource, /office_runtime_execute/);
  assert.match(toolSource, /office_runtime_cancel/);
  assert.match(registrySource, /createOfficeRuntimeTools/);
  assert.match(registrySource, /createOfficeRuntimeTools\(\{ workdir: params\.workdir \}\)/);
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
  assert.deepEqual(windowsConfig.bundle.externalBin, [
    "binaries/arcforge-office-runtime",
    "binaries/arcforge-gateway",
    "binaries/arcforge-wecom-connector",
  ]);
  assert.match(packageJson.scripts["sidecar:build"], /build-sidecars\.ps1/);
  assert.match(packageJson.scripts["build:desktop"], /sidecar:build/);
  assert.match(packageJson.scripts["dev:desktop"], /sidecar:build/);
  assert.match(sidecarBuildScript, /build-office-sidecar\.ps1/);
  assert.match(sidecarBuildScript, /build-gateway-sidecar\.ps1/);
  assert.match(sidecarBuildScript, /build-wecom-connector-sidecar\.ps1/);
  assert.match(buildScript, /PyInstaller/);
  assert.match(buildScript, /arcforge-office-runtime-\$TargetTriple\.exe/);
  assert.match(gatewayBuildScript, /install --frozen-lockfile/);
  assert.match(gatewayBuildScript, /run build/);
  assert.match(gatewayBuildScript, /arcforge-gateway-\$TargetTriple\.exe/);

  const webBuildOffset = gatewayBuildScript.lastIndexOf("Build-GatewayWebAssets");
  const goBuildOffset = gatewayBuildScript.indexOf("& $resolvedGo build");
  assert.ok(webBuildOffset >= 0 && webBuildOffset < goBuildOffset);
});
