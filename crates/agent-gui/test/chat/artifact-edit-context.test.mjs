import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { prepareArtifactEdit, artifactUndoMessage } = loader.loadModule("src/lib/artifactReview/prepareEdit.ts");
const uploads = loader.loadModule("src/lib/chat/messages/uploadedFiles.ts");
const { buildScopedEditInstruction } = loader.loadModule("src/lib/artifactReview/editScope.ts");
const artifact = { artifactType: "pptx", workdir: "E:/work", path: "deck/out.pptx" };
const selection = { artifact, selection: { type: "element", id: "title", unitId: "p-02", elementType: "title", label: "Title" } };
const scope = { editId: "edit-1", kind: "element", artifact, unitId: "p-02", elementId: "title", manifestPath: "stale.json" };
const context = {
  manifestPath: "deck/deck.json", templatePath: "deck/template.pptx", replacementKind: "svg_element",
  slide: { slideId: "p-02", index: 2, svgPath: "deck/design/p-02.svg" },
  element: { id: "title", snippet: '<text id="title">Current title</text>' },
};
function adapter(overrides = {}) {
  return { type: "pptx", selectionContext: async () => context,
    previewUnit: async () => ({ mimeType: "image/png", data: "YWJj", sizeBytes: 3 }), ...overrides };
}

test("scoped send resolves fresh context and includes a preview only when requested", async () => {
  const calls = [];
  const result = await prepareArtifactEdit({ scope, selection, workdir: "E:/work", includeImage: true,
    adapter: adapter({ selectionContext: async (_file, target) => { calls.push(target); return context; } }) });
  assert.deepEqual(calls, [{ unitId: "p-02", elementId: "title" }]);
  assert.equal(result.scope.manifestPath, "deck/deck.json");
  assert.equal(result.scope.templatePath, "deck/template.pptx");
  assert.match(result.instruction, /Current title/);
  assert.equal(result.preview.mimeType, "image/png");
  assert.equal(scope.manifestPath, "stale.json");
});

test("a different selected target or workspace is rejected before reading runtime context", async () => {
  let calls = 0;
  const reader = adapter({ selectionContext: async () => { calls++; return context; } });
  for (const invalid of [
    { workdir: "E:/other" },
    { scope: { ...scope, elementId: "other" } },
    { scope: { ...scope, unitId: "p-03" } },
    { scope: { ...scope, artifact: { ...artifact, path: "another.pptx" } } },
    { scope: { ...scope, editId: "../invalid" } },
  ]) await assert.rejects(prepareArtifactEdit({ scope, selection, workdir: "E:/work", adapter: reader, ...invalid }), /no longer matches/);
  assert.equal(calls, 0);
});

test("wrong runtime target is rejected and an optional unavailable preview does not block text editing", async () => {
  await assert.rejects(prepareArtifactEdit({ scope, selection, workdir: "E:/work",
    adapter: adapter({ selectionContext: async () => ({ ...context, element: { id: "wrong" } }) }) }), /different edit target/);
  const result = await prepareArtifactEdit({ scope, selection, workdir: "E:/work", includeImage: true,
    adapter: adapter({ previewUnit: async () => { throw new Error("No renderer"); } }) });
  assert.equal(result.preview, undefined);
  assert.match(result.instruction, /Current title/);
});

test("deck scope fetches deck context without accidentally retaining the selected element", async () => {
  let target;
  const result = await prepareArtifactEdit({ scope: { editId: "deck-1", kind: "artifact", artifact }, selection,
    workdir: "E:/work", adapter: adapter({ selectionContext: async (_artifact, value) => {
      target = value; return { manifestPath: "deck/deck.json", replacementKind: "deck", slideCount: 3 };
    } }) });
  assert.deepEqual(target, { unitId: undefined, elementId: undefined });
  assert.match(result.instruction, /whole deck \(3 pages/);
});

test("messages persist the edit scope and use detailed context without exposing it as user display text", () => {
  const tagged = { ...selection, edit: { ...scope, artifact: { ...artifact } } };
  const message = uploads.createUserMessageWithUploads("Shorter", [], 123, tagged,
    buildScopedEditInstruction(scope, context, tagged));
  assert.equal(uploads.getUserMessageDisplayText(message), "Shorter");
  assert.match(message.content, /Current title/);
  assert.match(message.content, /does not expand the scope lock/);
  assert.equal(uploads.getUserMessageSelection(message).edit.editId, "edit-1");
  tagged.edit.artifact.path = "changed.pptx";
  assert.equal(uploads.getUserMessageSelection(message).edit.artifact.path, "deck/out.pptx");
  const stripped = uploads.stripUploadedFilesMessageMetadata(message);
  assert.equal(uploads.getUserMessageSelection(stripped), null);
  assert.match(stripped.content, /Current title/);
});

test("undo context identifies restored content without requesting another model operation", () => {
  const text = artifactUndoMessage(scope, { editId: "edit-1", unitId: "p-02", elementId: "title", afterText: "Original title" });
  assert.match(text, /Original title/);
  assert.match(text, /already been applied/);
  assert.match(text, /do not reapply/);
});

const { summarizeScopedEditTurn, collectScopedEditTurns } = loader.loadModule("src/lib/artifactReview/inlineEdit.ts");
const user = (id = "edit-1", kind = "element") => uploads.createUserMessageWithUploads("Shorter", [], 123, { ...selection, edit: { ...scope, editId: id, kind } });
const assistant = text => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 124 });
const patchResult = (id, text, isError = false) => ({ role: "toolResult", toolName: "OfficeRuntime", isError,
  content: [{ type: "text", text: JSON.stringify({ action: "patched", edit: { edit_id: id, slide_id: "p-02", after_text: text }, deck: {} }) }], timestamp: 125 });

test("outcomes distinguish scope refusal from unconfirmed success and deduplicate corrections", () => {
  assert.equal(summarizeScopedEditTurn([user()], "edit-1"), null);
  const refused = summarizeScopedEditTurn([user(), assistant("SCOPE_TOO_NARROW: page — the title and subtitle must move together")], "edit-1");
  assert.equal(refused.status, "needs_scope");
  assert.equal(refused.suggestedKind, "unit");
  assert.equal(summarizeScopedEditTurn([user(), assistant("Done")], "edit-1").status, "failed");
  assert.equal(summarizeScopedEditTurn([user(), patchResult("edit-1", "Failed", true)], "edit-1").status, "failed");
  const applied = summarizeScopedEditTurn([user(), patchResult("edit-1", "Draft"), patchResult("edit-1", "Final"), assistant("Shortened p-02")], "edit-1");
  assert.equal(applied.status, "applied");
  assert.equal(applied.edits.length, 1);
  assert.equal(applied.edits[0].afterText, "Final");
});

test("history isolates turns and keeps earlier applied edits when a later correction fails", () => {
  const messages = [user(), patchResult("edit-1", "Applied"), patchResult("edit-1", "Failure", true), assistant("The correction failed"),
    { role: "user", content: "Already reverted edit-1", timestamp: 128 }, user("edit-2"), assistant("SCOPE_TOO_NARROW: whole deck")];
  const turns = collectScopedEditTurns(messages);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].outcome.status, "needs_scope");
  assert.equal(turns[1].outcome.status, "applied");
  assert.doesNotMatch(turns[1].details, /Already reverted|whole deck/);
});
