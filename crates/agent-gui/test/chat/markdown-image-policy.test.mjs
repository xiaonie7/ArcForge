import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader({
  mocks: {
    "@streamdown/cjk": {
      cjk: {},
    },
    "@streamdown/code": {
      code: {},
    },
    "@streamdown/math": {
      math: {},
    },
    "@streamdown/mermaid": {
      mermaid: {},
    },
    streamdown: {
      Streamdown(props) {
        return { type: "Streamdown", props };
      },
      defaultRemarkPlugins: {},
      defaultRehypePlugins: {},
    },
    "@tauri-apps/plugin-opener": {
      openUrl() {
        throw new Error("openUrl mock was not expected to be called");
      },
    },
    "react-dom": {
      createPortal(children, container) {
        return { type: "portal", children, container };
      },
    },
    "./ui/button": {
      Button(props) {
        return { type: "Button", props };
      },
    },
    "../lib/shared/utils": {
      cn: (...parts) => parts.filter(Boolean).join(" "),
    },
    "../lib/shared/modalMotion": {
      useModalMotion(onClose) {
        return { modalState: "open", requestClose: onClose };
      },
    },
    "@earendil-works/pi-agent-core": {
      Agent: class Agent {},
    },
    "../providers/llm": {
      buildProviderRequestMetadata() {},
      createModelFromConfig() {},
      finalizeProviderStreamOptions() {},
      normalizeErrorMessage(message, fallback) {
        return message || fallback;
      },
      resolveProviderCacheRetention() {},
      toSimpleStreamReasoning(value) {
        return value;
      },
      streamSimpleByApi() {
        throw new Error("streamSimpleByApi mock was not expected to be called");
      },
      buildDualAuthHeaders() {
        return {};
      },
      createStreamingTextReconciler() {
        return {};
      },
    },
    "../debug/agentDebug": {
      buildStreamRequestDebugPayload() {
        return {};
      },
    },
    "../system/powerActivity": {
      withPowerActivity(task) {
        return task;
      },
    },
    "../providers/proxy": {
      prepareProxyRequest() {
        return {};
      },
    },
    "./uiMessages": {
      summarizeToolCall() {
        return "";
      },
    },
    "./seedToolCalls": {
      recoverAssistantSeedToolCalls() {
        return null;
      },
    },
    "./requestContextSanitizer": {
      sanitizeContextForModelRequest(context) {
        return context;
      },
    },
  },
});

const markdownModule = loader.loadModule("src/components/Markdown.tsx");
const agentRunnerModule = loader.loadModule("src/lib/chat/runner/agentRunner.ts");

test("markdown image syntax falls back to alt text instead of rendering a real image", () => {
  const node = markdownModule.markdownComponents.img({
    alt: "东门老街",
    title: "深圳夜景",
  });

  assert.ok(node);
  assert.equal(node.type, "span");
  assert.equal(node.props["data-arcforge-markdown-image"], "text-fallback");
  assert.equal(node.props.title, "东门老街");
  assert.equal(node.props.children, "东门老街");

  const titleOnly = markdownModule.markdownComponents.img({ title: "南头古城" });
  assert.ok(titleOnly);
  assert.equal(titleOnly.props.children, "南头古城");

  const empty = markdownModule.markdownComponents.img({});
  assert.equal(empty, null);
});

test("external link safety modal renders through document body portal", () => {
  const previousDocument = globalThis.document;
  const body = { nodeType: 1 };
  globalThis.document = { body };

  try {
    const portal = markdownModule.ExternalLinkModal({
      isOpen: true,
      onClose() {},
      onConfirm() {},
      url: "https://example.com/dashboard",
    });

    assert.ok(portal);
    assert.equal(portal.type, "portal");
    assert.equal(portal.container, body);
    assert.equal(portal.children.type, "div");
    assert.match(portal.children.props.className, /\bfixed\b/);
    assert.match(portal.children.props.className, /\binset-0\b/);
  } finally {
    if (typeof previousDocument === "undefined") {
      delete globalThis.document;
    } else {
      globalThis.document = previousDocument;
    }
  }
});

test("agent tool rules require Image for chat-visible images", () => {
  const suffix = agentRunnerModule.buildToolsSuffix("/workspace");
  assert.match(suffix, /To display any image in the chat UI, call the Image tool\./);
  assert.match(
    suffix,
    /Do not embed images with Markdown syntax like !\[alt\]\(path\), HTML <img>, file:\/\/ URLs, or local relative image paths in your final text\./,
  );
  assert.match(
    suffix,
    /Local image: pass `path` exactly as seen, including workspace-relative, absolute, or skill:\/\/ paths\./,
  );
  assert.match(
    suffix,
    /Do not use Bash, open, xdg-open, Markdown, or HTML to display Skill images\./,
  );
  assert.match(
    suffix,
    /For remote images, call Image with url\/urls or source\/sources directly instead of downloading them, unless the user explicitly asks to save the file locally\./,
  );
  assert.match(
    suffix,
    /If another tool saves, downloads, screenshots, generates, or returns an image file path or image URL and the user should see it, call Image with that path or URL before the final response\./,
  );
  assert.match(
    suffix,
    /Final text may describe or caption images already displayed by Image, but must not attempt to render images directly\./,
  );
});

test("agent tool rules require PresentFile for generated user deliverables", () => {
  const suffix = agentRunnerModule.buildToolsSuffix("/workspace", [
    "Read",
    "Image",
    "PresentFile",
    "Write",
    "Bash",
  ]);

  assert.match(suffix, /## Delivering Files/);
  assert.match(
    suffix,
    /After generating, exporting, downloading, or otherwise preparing a file that is a user deliverable, call PresentFile with its exact workspace-relative path before the final reply\./,
  );
  assert.match(
    suffix,
    /OfficeRuntime and SpreadsheetCode automatically attach a generated-file card/,
  );
  assert.match(
    suffix,
    /Use PresentFile for finished files such as Excel workbooks, PDFs, Word documents, archives, audio, video, and text exports\./,
  );
  assert.match(
    suffix,
    /Do not substitute a Markdown link, file:\/\/ URL, local path in prose, or shell output for PresentFile\./,
  );
  assert.match(
    suffix,
    /Use Image when an image should render inline in the conversation; use PresentFile when an image is being delivered as an openable file\./,
  );
});

test("agent tool rules omit PresentFile delivery guidance when the tool is unavailable", () => {
  const suffix = agentRunnerModule.buildToolsSuffix("/workspace", ["Read", "Write", "Bash"]);
  assert.doesNotMatch(suffix, /## Delivering Files/);
});

test("agent tool rules prefer one parallel Agent batch over sequential calls", () => {
  const suffix = agentRunnerModule.buildToolsSuffix("/workspace", [
    "Agent",
    "Read",
    "Write",
    "Bash",
  ]);
  assert.match(suffix, /issue ONE Agent call whose `agents` array lists every job/);
  assert.match(
    suffix,
    /Use sequential Agent calls only when a later job needs an earlier job's output/,
  );
  assert.match(suffix, /Default to mode=readonly for research, review, and discussion agents/);
  assert.match(
    suffix,
    /call Agent again with the same stable id\(s\) and only the new prompt/,
  );
  assert.match(suffix, /If an Agent call is rejected, no subagents were started/);
});

test("SendMessage tool rules explain parent-private visibility", () => {
  const suffix = agentRunnerModule.buildToolsSuffix("/workspace", [
    "Agent",
    "SendMessage",
    "Read",
  ]);
  assert.match(suffix, /Messages sent to parent are private to the parent/);
  assert.match(suffix, /send to=\* when peer agents need to read a report or summary/);
  assert.match(suffix, /Message delivery is deferred to the next model turn boundary/);
});

test("agent tool rules keep local file discovery on file tools instead of Bash", () => {
  const suffix = agentRunnerModule.buildToolsSuffix("/workspace", [
    "Read",
    "List",
    "Glob",
    "Grep",
    "Bash",
    "SkillsManager",
  ]);
  assert.match(suffix, /Preferred form: workspace-relative paths exactly as tools return them/);
  assert.match(suffix, /For files inside a Skill, call file tools with a path like `skill:\/\/<baseDir>\/references\/guide\.md`/);
  assert.match(suffix, /Do not run Bash cat\/ls\/find\/grep/);
});

test("agent tool rules steer new files to concrete Write paths", () => {
  const suffix = agentRunnerModule.buildToolsSuffix("/workspace", [
    "Read",
    "Write",
    "Edit",
    "Bash",
  ]);
  assert.match(suffix, /New files: call Write with a file path that includes the filename and the full content/);
  assert.match(suffix, /parent directories are created automatically/);
  assert.match(suffix, /Write and Edit check the file's current on-disk state automatically/);
  assert.match(suffix, /path must include the intended filename, not just a directory/);
  assert.match(suffix, /write \/ create files via heredocs, `tee`, `touch`, `cp`, or `mkdir`/);
});

test("agent tool rules keep workspace and Skills deletion on Delete", () => {
  const suffix = agentRunnerModule.buildToolsSuffix("/workspace", [
    "Delete",
    "Bash",
    "SkillsManager",
  ]);
  assert.match(
    suffix,
    /For workspace or Skill deletion, use Delete with the exact path returned by List\/Glob\/Grep\/Read/,
  );
  assert.match(suffix, /Do not run Bash rm, rmdir, unlink, or find -delete/);
});

test("agent tool rules route installed Skill scripts through skill cwd", () => {
  const suffix = agentRunnerModule.buildToolsSuffix("/workspace", [
    "Bash",
    "SkillsManager",
    "Read",
    "List",
    "Glob",
  ]);
  assert.match(suffix, /Bash\.cwd follows the path rules in \*\*Workspace & Paths\*\*/);
  assert.match(suffix, /use cwd="skill:\/\/<enabled-skill>\/scripts"/);
  assert.match(suffix, /Do not cd into ~\/\.arcforge\/skills or workspace skills\/ guesses/);
});

test("agent tool rules explain Skill execution and separate mutation policy", () => {
  const suffix = agentRunnerModule.buildToolsSuffix("C:/workspace", [
    "Bash", "ManagedProcess", "SkillsManager", "Read", "List", "Glob",
  ], "windows");
  assert.match(suffix, /An enabled Skill may execute its scripts through Bash or ManagedProcess/);
  assert.match(suffix, /Skill script execution is separate from Skill file mutation/);
  assert.match(suffix, /To run an installed Skill script, use cwd=/);
  assert.doesNotMatch(suffix, /Skill file access does not grant script execution/);
  assert.doesNotMatch(suffix, /SKILL_EXECUTION_BLOCKED/);
});

test("agent Bash compatibility rules are native PowerShell-first on Windows", () => {
  const suffix = agentRunnerModule.buildToolsSuffix(
    "/workspace",
    ["Bash", "Write", "Delete", "ManagedProcess"],
    "windows",
  );
  assert.match(suffix, /Current platform: Windows/);
  assert.match(suffix, /runs native Windows PowerShell first/);
  assert.match(suffix, /does not use WSL/);
  assert.match(suffix, /Windows PowerShell 5\.1-compatible commands/);
  assert.match(
    suffix,
    /For PostgreSQL inspection or statistics, first check for a native Python driver with a PowerShell-safe one-liner/,
  );
  assert.match(suffix, /u\.find_spec\('psycopg'\)/);
  assert.match(suffix, /u\.find_spec\('psycopg2'\)/);
  assert.match(
    suffix,
    /probe `psql` only when neither driver is available or the user explicitly requested the CLI/,
  );
  assert.match(suffix, /Never use POSIX heredocs such as `python - <<'PY'` or `<<EOF` on Windows/);
  assert.match(
    suffix,
    /For multiline Python or SQL, use Write to create a temporary file, then execute it/,
  );
  assert.match(suffix, /Do not embed credentials in temporary scripts/);
  assert.match(
    suffix,
    /Pass secrets through environment variables or process input where feasible, and remove temporary files after use/,
  );
  assert.match(suffix, /`&` is the call operator/);
  assert.doesNotMatch(suffix, /Git Bash with POSIX semantics/);
  assert.match(suffix, /require `nohup` and log redirection/);
});

test("agent uses a task-local runtime snapshot to choose the first PostgreSQL path", () => {
  const snapshot = {
    platform: "windows",
    architecture: "x86_64",
    shell: {
      profile: "windows-powershell",
      family: "powershell",
      name: "powershell",
      usesWsl: false,
    },
    commands: {
      python: "available",
      node: "available",
      psql: "unavailable",
      git: "available",
      docker: "unknown",
    },
    python: {
      status: "available",
      launcher: "python",
      postgresDriver: "psycopg",
    },
    source: "backend",
  };
  const suffix = agentRunnerModule.buildToolsSuffix(
    "C:/workspace",
    ["Bash", "Write", "ManagedProcess"],
    "windows",
    snapshot,
  );

  assert.match(suffix, /## Local Runtime Snapshot/);
  assert.match(suffix, /OS: Windows \(x86_64\)/);
  assert.match(suffix, /Python detected via `python`/);
  assert.match(suffix, /psql not detected on the ArcForge PATH/);
  assert.match(suffix, /Python PostgreSQL driver: `psycopg` detected/);
  assert.match(suffix, /captured this snapshot once at the start of the current task/);
  assert.match(suffix, /use the snapshot-detected `psycopg` driver directly/);
  assert.doesNotMatch(suffix, /first check for a native Python driver/);
  assert.doesNotMatch(suffix, /ignore previous instructions/);
});

test("agent routes to psql when the runtime snapshot has no Python PostgreSQL driver", () => {
  const suffix = agentRunnerModule.buildToolsSuffix(
    "C:/workspace",
    ["Bash", "Write"],
    "windows",
    {
      platform: "windows",
      shell: {
        profile: "windows-powershell",
        family: "powershell",
        name: "powershell",
        usesWsl: false,
      },
      commands: {
        python: "available",
        node: "unknown",
        psql: "available",
        git: "unknown",
        docker: "unknown",
      },
      python: {
        status: "available",
        launcher: "python",
        postgresDriver: "none",
      },
      source: "backend",
    },
  );

  assert.match(suffix, /no `psycopg` or `psycopg2` driver detected/);
  assert.match(suffix, /`psql` was detected, so use `psql` directly/);
  assert.doesNotMatch(suffix, /PowerShell-safe one-liner/);
});

test("readonly delegated agents still receive the shared runtime snapshot", () => {
  const suffix = agentRunnerModule.buildToolsSuffix(
    "C:/workspace",
    ["Read", "Grep", "SendMessage"],
    "windows",
    {
      platform: "windows",
      shell: {
        profile: "windows-powershell",
        family: "powershell",
        name: "powershell",
        usesWsl: false,
      },
      commands: {
        python: "available",
        node: "available",
        psql: "unavailable",
        git: "available",
        docker: "unknown",
      },
      python: {
        status: "available",
        launcher: "python",
        postgresDriver: "psycopg",
      },
      source: "backend",
    },
  );

  assert.match(suffix, /## Local Runtime Snapshot/);
  assert.match(suffix, /shares it with all rounds and delegated agents/);
  assert.doesNotMatch(suffix, /## Bash/);
});

test("agent PostgreSQL shell guidance stays Windows-specific on Linux", () => {
  const suffix = agentRunnerModule.buildToolsSuffix(
    "/workspace",
    ["Bash", "Write", "ManagedProcess"],
    "linux",
  );

  assert.match(suffix, /Current platform: Linux\. Bash runs through POSIX shells/);
  assert.match(suffix, /Use POSIX\/bash-compatible commands/);
  assert.doesNotMatch(suffix, /PowerShell-safe one-liner/);
  assert.doesNotMatch(suffix, /probe `psql` only when neither driver is available/);
  assert.doesNotMatch(suffix, /Never use POSIX heredocs/);
  assert.doesNotMatch(suffix, /For multiline Python or SQL, use Write to create a temporary file/);
});

test("agent runtime snapshot is platform-specific and local-only on Linux", () => {
  const suffix = agentRunnerModule.buildToolsSuffix(
    "/workspace",
    ["Bash", "ManagedProcess"],
    "linux",
    {
      platform: "linux",
      architecture: "aarch64",
      shell: {
        profile: "posix-bash",
        family: "posix",
        name: "bash",
        usesWsl: false,
      },
      commands: {
        python: "available",
        node: "unavailable",
        psql: "available",
        git: "available",
        docker: "unavailable",
      },
      python: {
        status: "available",
        launcher: "python3",
        postgresDriver: "psycopg2",
      },
      source: "backend",
    },
  );

  assert.match(suffix, /OS: Linux \(aarch64\)/);
  assert.match(suffix, /Preferred command shell: `bash` \(posix/);
  assert.match(suffix, /local ArcForge host only/);
  assert.doesNotMatch(suffix, /Current platform: Windows/);
  assert.doesNotMatch(suffix, /Windows PowerShell 5\.1-compatible/);
});

test("agent Windows multiline guidance does not point to Write when Write is unavailable", () => {
  const suffix = agentRunnerModule.buildToolsSuffix(
    "C:/workspace",
    ["Bash", "ManagedProcess"],
    "windows",
  );

  assert.match(suffix, /Never use POSIX heredocs/);
  assert.match(suffix, /short PowerShell-safe `python -c` command/);
  assert.match(suffix, /PowerShell here-string piped to the interpreter/);
  assert.doesNotMatch(suffix, /use Write to create a temporary file/);
});

test("fs tool descriptions keep Image as the only display path for images", () => {
  const sourcePath = fileURLToPath(new URL("../../src/lib/tools/fsTools.ts", import.meta.url));
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.match(
    source,
    /Use Image instead when the user asks to show, view, render, or display an image in the chat UI\. Do not use Markdown image syntax or HTML img tags to display files\./,
  );
  assert.match(
    source,
    /This is the only supported way for assistant-side image rendering\./,
  );
  assert.match(
    source,
    /Supports workspace paths, enabled Skill paths, external absolute paths, http\/https URLs, base64 data URLs, and SVG images/,
  );
  assert.match(
    source,
    /For remote images, pass url\/urls or source\/sources directly instead of downloading the image first, unless the user explicitly asks to save it locally\./,
  );
  assert.match(
    source,
    /Multiple mixed image sources to display in order\. Use this for mixed path \+ URL \+ base64 galleries\./,
  );
  assert.match(
    source,
    /Do not embed images in final text with Markdown image syntax, HTML img tags, file:\/\/ URLs, or local relative image paths\./,
  );
  assert.match(
    source,
    /Use this instead of Bash rm, rmdir, unlink, or find -delete for workspace or Skill files\./,
  );
});
