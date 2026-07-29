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
  hasTrustedPrincipal: false,
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
    { workdir: "", allowEmptyWorkdir: true },
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

test("trusted channel turns never inherit desktop or queued project directories", () => {
  assert.deepEqual(
    resolveAgentTurnWorkdir({
      ...projectDefaults,
      hasTrustedPrincipal: true,
      explicitWorkdir: "C:/projects/should-not-leak",
      gatewayWorkdir: "C:/projects/remote",
    }),
    { workdir: "", allowEmptyWorkdir: true },
  );

  assert.equal(
    resolveGatewayQueuedTurnWorkdir({
      hasTrustedPrincipal: true,
      requestedWorkdir: "C:/projects/remote",
      conversationWorkdir: "C:/projects/current",
      displayedWorkdir: "C:/projects/displayed",
      defaultWorkdir: "C:/projects/default",
    }),
    "",
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
  const sidebarSource = readFileSync(
    new URL("../../src/components/chat/ChatHistorySidebar.tsx", import.meta.url),
    "utf8",
  );
  const agentTurnSource = readFileSync(
    new URL("../../src/pages/chat/turns/runAgentConversationTurn.ts", import.meta.url),
    "utf8",
  );

  assert.match(workspaceSource, /isRecentScopeActive\s*\?\s*\{ kind: "unscoped" \}/);
  assert.match(workspaceSource, /startNewConversationActionRef\.current\(\{ workdir: "" \}\)/);
  assert.match(pageSource, /allowEmptyAgentWorkdir: isAgentMode && isRecentScopeActive/);
  assert.match(sidebarSource, /<RecentScopeRow/);
  assert.match(agentTurnSource, /if \(!effectiveWorkdir && !allowEmptyWorkdir\)/);
  assert.match(agentTurnSource, /workdir: effectiveWorkdir,\s*allowEmptyWorkdir,/);
});
