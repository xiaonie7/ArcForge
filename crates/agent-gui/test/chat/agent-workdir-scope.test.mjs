import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  resolveAgentTurnWorkdir,
  resolveGatewayQueuedTurnWorkdir,
  resolveLocalQueuedTurnWorkdir,
} = loader.loadModule("src/pages/chat/runtime/agentWorkdirScope.ts");

const projectDefaults = {
  isAgentMode: true,
  unscopedAgent: false,
  conversationWorkdir: "C:/projects/current",
  defaultWorkdir: "C:/projects/default",
};

test("Agent workdir resolution only allows empty cwd for an explicit unscoped source", () => {
  assert.deepEqual(resolveAgentTurnWorkdir(projectDefaults), {
    workdir: "C:/projects/current",
    allowEmptyWorkdir: false,
  });

  assert.deepEqual(
    resolveAgentTurnWorkdir({
      ...projectDefaults,
      unscopedAgent: true,
    }),
    { workdir: "", allowEmptyWorkdir: true },
  );

  assert.deepEqual(
    resolveAgentTurnWorkdir({
      ...projectDefaults,
      explicitWorkdir: "",
    }),
    { workdir: "", allowEmptyWorkdir: false },
  );

  assert.deepEqual(
    resolveAgentTurnWorkdir({
      ...projectDefaults,
      explicitWorkdir: "",
      allowEmptyWorkdirOverride: true,
    }),
    { workdir: "", allowEmptyWorkdir: true },
  );

  assert.deepEqual(
    resolveAgentTurnWorkdir({
      ...projectDefaults,
      unscopedAgent: true,
      explicitWorkdir: "",
    }),
    { workdir: "", allowEmptyWorkdir: true },
  );

  assert.deepEqual(
    resolveAgentTurnWorkdir({
      ...projectDefaults,
      gatewayWorkdir: "",
    }),
    { workdir: "", allowEmptyWorkdir: false },
  );

  assert.deepEqual(
    resolveAgentTurnWorkdir({
      ...projectDefaults,
      unscopedAgent: true,
      explicitWorkdir: "C:/projects/queued",
    }),
    { workdir: "C:/projects/queued", allowEmptyWorkdir: false },
  );
});

test("trusted channel turns use the same desktop and queued project directories", () => {
  assert.deepEqual(
    resolveAgentTurnWorkdir({
      ...projectDefaults,
      explicitWorkdir: "C:/projects/captured",
      gatewayWorkdir: "C:/projects/remote",
    }),
    { workdir: "C:/projects/captured", allowEmptyWorkdir: false },
  );

  assert.equal(
    resolveGatewayQueuedTurnWorkdir({
      requestedWorkdir: "C:/projects/remote",
      conversationWorkdir: "C:/projects/current",
      displayedWorkdir: "C:/projects/displayed",
      defaultWorkdir: "C:/projects/default",
    }),
    "C:/projects/remote",
  );

  assert.equal(
    resolveGatewayQueuedTurnWorkdir({
      conversationWorkdir: "C:/projects/current",
      displayedWorkdir: "C:/projects/displayed",
      defaultWorkdir: "C:/projects/default",
    }),
    "C:/projects/current",
  );
});

test("queued local turns preserve their captured scope", () => {
  assert.equal(
    resolveLocalQueuedTurnWorkdir({
      isAgentMode: true,
      unscopedAgent: true,
      conversationWorkdir: "C:/projects/current",
      displayedWorkdir: "C:/projects/displayed",
      defaultWorkdir: "C:/projects/default",
    }),
    "",
  );

  assert.equal(
    resolveLocalQueuedTurnWorkdir({
      isAgentMode: true,
      editedWorkdir: "C:/projects/captured",
      unscopedAgent: true,
      conversationWorkdir: undefined,
      displayedWorkdir: "",
      defaultWorkdir: "C:/projects/default",
    }),
    "C:/projects/captured",
  );
});

test("Recent scope is wired to cwd-empty history and the guarded Agent runtime", () => {
  const workspaceSource = readFileSync(
    new URL("../../src/pages/chat/workspace/useWorkspaceProjects.ts", import.meta.url),
    "utf8",
  );
  const pageSource = readFileSync(new URL("../../src/pages/ChatPage.tsx", import.meta.url), "utf8");
  const historyActionsSource = readFileSync(
    new URL("../../src/pages/chat/history/useConversationHistoryActions.ts", import.meta.url),
    "utf8",
  );
  const sidebarSource = readFileSync(
    new URL("../../src/components/chat/ChatHistorySidebar.tsx", import.meta.url),
    "utf8",
  );
  const agentTurnSource = readFileSync(
    new URL("../../src/pages/chat/turns/runAgentConversationTurn.ts", import.meta.url),
    "utf8",
  );
  const queueSource = readFileSync(
    new URL("../../src/pages/chat/queue/useChatTurnQueue.ts", import.meta.url),
    "utf8",
  );

  assert.match(workspaceSource, /isRecentScopeActive\s*\?\s*\{ kind: "unscoped" \}/);
  assert.match(workspaceSource, /startNewConversationActionRef\.current\(\{ workdir: "" \}\)/);
  assert.match(
    historyActionsSource,
    /workdir: options\?\.workdir \?\? getDefaultNewConversationWorkdir\?\.\(\)/,
  );
  assert.match(
    pageSource,
    /const nextWorkdir = isRecentScopeActive \? "" : activeWorkspaceProjectPath\.trim\(\)/,
  );
  assert.match(pageSource, /allowEmptyAgentWorkdir: isAgentMode && isRecentScopeActive/);
  assert.match(sidebarSource, /<RecentScopeRow/);
  assert.match(agentTurnSource, /if \(!effectiveWorkdir && !allowEmptyWorkdir\)/);
  assert.match(
    agentTurnSource,
    /workspaceAccess:\s*allowEmptyWorkdir\s*\?\s*"none"\s*:\s*"full"/,
  );
  assert.match(agentTurnSource, /workdir: effectiveWorkdir,\s*allowEmptyWorkdir,/);
  assert.match(queueSource, /allowEmptyWorkdirOverride: queuedTurn\.allowEmptyWorkdir/);
  assert.match(
    queueSource,
    /const allowEmptyWorkdir =\s*editSlot\?\.allowEmptyWorkdir \?\?\s*\(isAgentExecutionMode\(executionMode\) && allowEmptyAgentWorkdir\)/,
  );
});
