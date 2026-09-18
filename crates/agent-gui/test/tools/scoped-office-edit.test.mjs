import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const artifact = { artifactType: "pptx", workdir: "E:/work", path: "deck/out.pptx" };
const scope = { editId: "turn-1", kind: "element", artifact, unitId: "p-02", elementId: "title", manifestPath: "deck/deck.json", templatePath: "deck/template.pptx" };
const args = { document: "presentation", action: "patch", spec_path: "deck/deck.json", output_path: "deck/out.pptx", slide_id: "p-02", element_id: "title", replacement: '<text id="title">Edited</text>' };
function harness(editScope = scope) {
  const calls = [], changes = [];
  let payload = { action: "patched", edit: { edit_id: "turn-1", slide_id: "p-02", element_id: "title", scope: "element", kind: "svg_element" }, deck: { changed_slide_ids: ["p-02"] } };
  let success = true;
  const loader = createTsModuleLoader({ mocks: { "@tauri-apps/api/core": { async invoke(command, input) {
    if (command !== "office_runtime_execute") throw new Error("No preview in this harness");
    calls.push(input.input);
    return { success, stdout: JSON.stringify(payload), stderr: success ? "" : "failed", durationMs: 1 };
  } } } });
  loader.loadModule("src/lib/artifactReview/events.ts").subscribeArtifactChanges(change => changes.push(change));
  const bundle = loader.loadModule("src/lib/tools/officeRuntimeTools.ts").createOfficeRuntimeTools({ workdir: "E:/work", editScope });
  return { calls, changes, bundle, loader,
    result(value, ok = true) { payload = value; success = ok; },
    call(arguments_ = args, name = "OfficeRuntime") { return bundle.executeToolCall({ id: "call", type: "toolCall", name, arguments: arguments_ }); } };
}

test("element scope blocks scope and tool escapes before invoking the runtime", async () => {
  const h = harness();
  assert.deepEqual(h.bundle.tools.map(tool => tool.name), ["OfficeRuntime"]);
  for (const override of [
    { action: "create" }, { document: "word" }, { slide_id: "p-03" }, { element_id: "body" },
    { element_id: undefined }, { output_path: "other.pptx" }, { spec_path: "other.json" },
    { input_path: "other-template.pptx" }, { edit_id: "other" }, { revert: "old-edit" },
  ]) assert.equal((await h.call({ ...args, ...override })).isError, true, JSON.stringify(override));
  assert.equal((await h.call({ script_path: "escape.py", output_path: "escape.xlsx" }, "SpreadsheetCode")).isError, true);
  assert.equal(h.calls.length, 0);
});

test("accepted corrections retain their edit id and template; page edits cannot split the undo target", async () => {
  const h = harness();
  assert.equal((await h.call()).isError, false);
  assert.equal((await h.call()).isError, false);
  assert.deepEqual(h.calls.map(call => call.edit.editId), ["turn-1", "turn-1"]);
  assert.equal(h.calls[0].inputPath, scope.templatePath);
  assert.equal(args.edit_id, undefined, "caller-owned arguments remain unchanged");
  assert.deepEqual(h.changes[0].changedUnits, [{ type: "slide", id: "p-02" }]);
  const page = harness({ ...scope, kind: "unit", elementId: undefined });
  assert.equal((await page.call()).isError, true);
  assert.equal((await page.call({ ...args, element_id: undefined })).isError, false);
});

test("inspection and validation stay linked; rendering only writes the reserved preview", async () => {
  const h = harness();
  for (const arguments_ of [
    { document: "presentation", action: "inspect", input_path: artifact.path },
    { document: "presentation", action: "validate", spec_path: scope.manifestPath },
    { document: "presentation", action: "render", input_path: artifact.path },
  ]) assert.equal((await h.call(arguments_)).isError, false);
  assert.equal(h.calls[1].inputPath, scope.templatePath);
  assert.equal(h.calls[2].outputPath, ".arcforge-review/turn-1.png");
  for (const arguments_ of [
    { document: "presentation", action: "inspect", input_path: "unrelated.pptx" },
    { document: "presentation", action: "validate", spec_path: "other.json" },
    { document: "presentation", action: "render", input_path: artifact.path, output_path: "design/page.svg" },
  ]) assert.equal((await h.call(arguments_)).isError, true);
  assert.equal(h.calls.length, 3);
});

test("shared inputs invalidate all previews; failed writes publish no success event", async () => {
  const h = harness();
  h.result({ action: "patched", deck: { changed_slide_ids: [], shared_inputs_changed: true } });
  await h.call();
  assert.equal(h.changes[0].changedUnits, "all");
  h.result({ action: "patched", deck: { changed_slide_ids: ["p-02"] } }, false);
  assert.equal((await h.call()).isError, true);
  assert.equal(h.changes.length, 1);
});

test("scoped registry excludes every alternate write path and rejects direct calls", async () => {
  const h = harness();
  const { buildBuiltinToolRegistry } = h.loader.loadModule("src/lib/tools/builtinRegistry.ts");
  const { createFileToolState } = h.loader.loadModule("src/lib/tools/fileToolState.ts");
  const registry = await buildBuiltinToolRegistry({ workdir: "E:/work", editScope: scope,
    providerId: "codex", fileState: createFileToolState(), skillsEnabled: true, runtimeScope: "chat", selectedSystemToolIds: [],
    getMcpSettings: () => { throw new Error("A scoped turn must not load MCP tools"); },
    subagentRuntime: { store: { ready() { throw new Error("Must not start agents"); } } },
    askUserQuestionConversationId: "review", todoState: {},
  });
  assert.equal(registry.hasTool("Read"), true);
  assert.equal(registry.hasTool("OfficeRuntime"), true);
  for (const name of ["Write", "Edit", "Shell", "Bash", "Agent", "SpreadsheetCode", "McpManager", "ManagedProcess", "Cron", "AskUserQuestion", "TodoWrite"]) {
    assert.equal(registry.hasTool(name), false, name);
    assert.equal((await registry.executeToolCall({ id: name, name, type: "toolCall", arguments: {} })).isError, true);
  }
  const invalidSkill = await registry.executeToolCall({ id: "skill", name: "SkillsManager", type: "toolCall", arguments: { action: "install" } });
  assert.equal(invalidSkill.isError, true);
  assert.equal(h.calls.length, 0);
});
