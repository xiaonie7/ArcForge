import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const review = loader.loadModule("src/lib/artifactReview/types.ts");
const events = loader.loadModule("src/lib/artifactReview/events.ts");
const uploads = loader.loadModule("src/lib/chat/messages/uploadedFiles.ts");

const selection = {
  artifact: { artifactType: "pptx", workdir: "E:/work", path: "deck/out/deck.pptx" },
  selection: { type: "slide", id: "p-05", label: "5 · 市场规模", order: 5, total: 12 },
};

test("selection instruction names the artifact, the unit, and the scope rule", () => {
  const text = review.buildSelectionInstruction(selection);
  assert.match(text, /Artifact review selection/);
  assert.match(text, /deck\/out\/deck\.pptx \(pptx\)/);
  assert.match(text, /slide p-05 \(slide 5 of 12\)/);
  assert.match(text, /Change only this unit/);
  assert.equal(review.selectionTitle(selection), "deck.pptx › 5 · 市场规模");
});

test("user messages carry the selection as hidden context and keep the display text", () => {
  const message = uploads.createUserMessageWithUploads("把标题改短一点", [], 1, selection);
  assert.ok(message);
  assert.match(message.content, /^把标题改短一点\n\nArtifact review selection/);
  assert.equal(uploads.getUserMessageDisplayText(message), "把标题改短一点");
  assert.deepEqual(uploads.getUserMessageSelection(message), selection);

  const stripped = uploads.stripUploadedFilesMessageMetadata(message);
  assert.equal(uploads.getUserMessageSelection(stripped), null);
  assert.equal(stripped.content, message.content);

  const withFiles = uploads.createUserMessageWithUploads(
    "",
    [
      {
        relativePath: "uploads/1/a.png",
        absolutePath: "C:/u/a.png",
        fileName: "a.png",
        kind: "image",
        sizeBytes: 10,
      },
    ],
    1,
    selection,
  );
  assert.match(withFiles.content, /Please inspect the selected files first/);
  assert.match(withFiles.content, /Artifact review selection/);

  assert.equal(uploads.createUserMessageWithUploads("", [], 1, selection), null);
  assert.equal(uploads.getUserMessageSelection({ role: "user", arcForgeSelection: { bad: 1 } }), null);
});

test("artifact change bus delivers to subscribers and matches paths loosely", () => {
  const seen = [];
  const unsubscribe = events.subscribeArtifactChanges((change) => seen.push(change));
  events.emitArtifactChange({
    workdir: "E:/work",
    path: "deck\\out\\deck.pptx",
    artifactType: "pptx",
    changedUnits: [{ type: "slide", id: "p-05" }],
  });
  unsubscribe();
  events.emitArtifactChange({
    workdir: "E:/work",
    path: "deck/out/deck.pptx",
    artifactType: "pptx",
    changedUnits: "all",
  });
  assert.equal(seen.length, 1);
  assert.ok(events.artifactPathsMatch(seen[0].path, "./deck/out/DECK.pptx"));
  assert.ok(!events.artifactPathsMatch(seen[0].path, "deck/out/other.pptx"));
});
