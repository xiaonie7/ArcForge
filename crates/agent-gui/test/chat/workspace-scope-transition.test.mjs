import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  shouldStartConversationForRecentSelection,
  shouldStartConversationForWorkspaceActivation,
} = loader.loadModule("src/pages/chat/workspace/workspaceScopeTransition.ts");

test("entering Recent starts an isolated conversation exactly once per scope transition", () => {
  assert.equal(shouldStartConversationForRecentSelection(false), true);
  assert.equal(shouldStartConversationForRecentSelection(true), false);
});

test("workspace activation never reuses a conversation from Recent or another project", () => {
  const base = {
    forceNewConversation: false,
    isRecentScopeActive: false,
    activeProjectId: "project-a",
    targetProjectId: "project-a",
  };

  assert.equal(shouldStartConversationForWorkspaceActivation(base), false);
  assert.equal(
    shouldStartConversationForWorkspaceActivation({
      ...base,
      isRecentScopeActive: true,
    }),
    true,
  );
  assert.equal(
    shouldStartConversationForWorkspaceActivation({
      ...base,
      targetProjectId: "project-b",
    }),
    true,
  );
  assert.equal(
    shouldStartConversationForWorkspaceActivation({
      ...base,
      forceNewConversation: true,
    }),
    true,
  );
});

test("workspace UI wires both scope transitions to isolated conversation creation", () => {
  const source = readFileSync(
    new URL("../../src/pages/chat/workspace/useWorkspaceProjects.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /if \(!shouldStartConversationForRecentSelection\(isRecentScopeActive\)\)\s*{\s*return;/,
  );
  assert.match(
    source,
    /setIsRecentScopeActive\(true\);\s*prepareComposerForConversationChangeActionRef\.current\(\);\s*startNewConversationActionRef\.current\(\{ workdir: "" \}\);/,
  );
  assert.match(
    source,
    /if \(shouldStartConversation\)\s*{\s*prepareComposerForConversationChangeActionRef\.current\(\);\s*startNewConversationActionRef\.current\(\{ workdir: targetProject\.path \}\);/,
  );
});
