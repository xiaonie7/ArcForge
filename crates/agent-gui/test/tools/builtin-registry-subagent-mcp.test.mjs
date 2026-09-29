import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import { createFakeStoreIpc } from "../subagents/harness.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const agentRunnerModulePath = path.join(rootDir, "src/lib/chat/runner/agentRunner.ts");

function createAssistant(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5",
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function createAgentToolCall(argumentsValue, id = "call-agent") {
  return { type: "toolCall", id, name: "Agent", arguments: argumentsValue };
}

const DOCS_SERVER = {
  id: "docs",
  enabled: true,
  transport: "stdio",
  command: "mock-mcp-server",
  args: [],
  env: {},
};

const WECOM_PRINCIPAL = {
  principalId: "wecom:user-1",
  channel: "wecom",
  tenantId: "tenant-1",
  botId: "bot-1",
  externalUserId: "user-1",
  chatId: "",
  chatType: "direct",
  externalMessageId: "message-1",
  connectorId: "connector-1",
  channelSessionId: "session-1",
  channelCommand: "",
  authTime: 1_700_000_000_000,
  requestId: "request-1",
};

function createRegistryHarness() {
  const runnerCalls = [];
  const listedServerIds = [];
  const listedServerCommands = [];
  const loader = createTsModuleLoader({
    mocks: {
      [agentRunnerModulePath]: {
        async runAssistantWithTools(params) {
          runnerCalls.push(params);
          params.onTurnStart?.(1);
          const assistant = createAssistant("subagent done");
          return { assistant, messages: [assistant], emittedMessages: [assistant] };
        },
      },
      "@tauri-apps/api/path": {
        async homeDir() {
          return "/Users/test";
        },
      },
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          if (command === "mcp_list_tools") {
            listedServerIds.push((args.servers ?? []).map((server) => server.id));
            listedServerCommands.push((args.servers ?? []).map((server) => server.command));
            return [
              {
                serverId: "docs",
                serverLabel: "Docs",
                name: "search",
                description: "Search docs",
                inputSchema: { type: "object" },
              },
            ];
          }
          if (command === "subagent_worktree_create") {
            return {
              repoRoot: "/repo",
              worktreeRoot: "/tmp/arcforge-subagents/agent-a",
              workdir: "/tmp/arcforge-subagents/agent-a",
              branchName: "arcforge/subagent/agent-a",
              baseRevision: "a".repeat(40),
            };
          }
          if (command === "subagent_worktree_status") {
            return {
              changed: false,
              status: "",
              diffStat: "",
              diff: "",
              diffTruncated: false,
              untrackedFiles: [],
            };
          }
          if (command === "subagent_worktree_cleanup") {
            return {
              worktreeRoot: args.input.worktreeRoot,
              branchName: args.input.branchName,
              removed: true,
              branchDeleted: true,
            };
          }
          if (command === "execution_broker_register_run") {
            return { bindingId: "binding-1", isolationLevel: "workspace_only" };
          }
          if (command === "execution_broker_close_run") return undefined;
          if (command === "subagent_worktree_validate") {
            const runId = args.input.runId;
            const runSpecHash = args.input.runSpecHash;
            return {
              candidate: {
                kind: "candidate_bundle",
                candidateId: `candidate-${runId}`,
                taskId: runId,
                runId,
                runSpecHash,
                candidateHash: "b".repeat(64),
                baseRevision: "a".repeat(40),
                changedPaths: [],
                status: "",
                diffStat: "",
                diff: "",
                diffTruncated: false,
                untrackedFiles: [],
                createdAt: Date.now(),
              },
              validation: {
                kind: "validation_report",
                reportId: `report-${runId}`,
                reportHash: "c".repeat(64),
                taskId: runId,
                runId,
                runSpecHash,
                candidateHash: "b".repeat(64),
                baseRevision: "a".repeat(40),
                status: "passed",
                scope: "structural",
                checks: [],
                testStatus: "not_run",
                createdAt: Date.now(),
              },
            };
          }
          throw new Error(`Unexpected invoke: ${command}`);
        },
      },
    },
  });
  return { loader, runnerCalls, listedServerIds, listedServerCommands };
}

async function buildRegistry(
  harness,
  {
    withSubagentRuntime,
    storeIpc,
    workspaceAccess,
    principal,
    allowedSystemTools,
    memoryEnabled,
    selectedSystemToolIds = [],
    visualReview,
  } = {},
) {
  const { loader } = harness;
  const { buildBuiltinToolRegistry } = loader.loadModule("src/lib/tools/builtinRegistry.ts");
  const { createFileToolState } = loader.loadModule("src/lib/tools/fileToolState.ts");
  const mcpSettingsHolder = { value: { selected: ["docs"], servers: [DOCS_SERVER] } };
  const baseParams = {
    workdir: "/tmp/arcforge-subagent-registry-test",
    providerId: "codex",
    fileState: createFileToolState(),
    skillsEnabled: true,
    runtimeScope: "chat",
    workspaceAccess,
    principal,
    conversationId: principal ? "wecom:conversation-1" : "conversation-1",
    selectedSystemToolIds,
    visualReview,
    allowedSystemTools,
    memoryEnabled,
    getMcpSettings: () => mcpSettingsHolder.value,
    remoteWebTunnelsEnabled: true,
    tunnelProjectPathKey: "/tmp/arcforge-subagent-registry-test",
    sshManagerRemoteAllowed: true,
    associatedSshHostIds: ["host-1"],
    sshHosts: [
      {
        id: "host-1",
        name: "Test host",
        description: "",
        host: "ssh.example.test",
        port: 22,
        username: "tester",
        authType: "password",
        password: "",
        privateKey: "",
        privateKeyPath: "",
        privateKeyPassphrase: "",
        proxy: {
          type: "socks5",
          url: "",
          port: 1080,
          username: "",
          password: "",
        },
      },
    ],
  };
  if (!withSubagentRuntime) {
    return { registry: await buildBuiltinToolRegistry(baseParams), mcpSettingsHolder };
  }

  const storeModule = loader.loadModule("src/lib/subagents/store.ts");
  const schedulerModule = loader.loadModule("src/lib/subagents/scheduler.ts");
  const ipc = storeIpc ?? createFakeStoreIpc();
  const store = storeModule.createSubagentConversationStore({
    conversationId: "conversation-1",
    ipc,
  });
  const registry = await buildBuiltinToolRegistry({
    ...baseParams,
    subagentRuntime: {
      providerId: "codex",
      model: "gpt-5",
      runtime: { baseUrl: "https://api.example.test/v1", apiKey: "test-key" },
      sessionId: "parent-session",
      templates: [
        {
          id: "reviewer",
          name: "Reviewer",
          description: "Review code paths",
          prompt: "Focus on concrete defects.",
        },
      ],
      store,
      scheduler: schedulerModule.createSubagentScheduler(),
    },
  });
  return { registry, store, ipc, mcpSettingsHolder };
}

test("registry without a subagent runtime exposes neither Agent nor SendMessage", async () => {
  const harness = createRegistryHarness();
  const { registry } = await buildRegistry(harness, { withSubagentRuntime: false });
  const names = registry.tools.map((tool) => tool.name);
  assert.ok(!names.includes("Agent"));
  assert.ok(!names.includes("SendMessage"));
  // Sanity: the base surface is otherwise intact.
  assert.ok(names.includes("Read"));
  assert.ok(names.includes("mcp_docs_search"));
});

test("only the first safe native tools prefer strict JSON-schema sampling", async () => {
  const harness = createRegistryHarness();
  const { registry } = await buildRegistry(harness, { withSubagentRuntime: false });
  const readTool = registry.tools.find((tool) => tool.name === "Read");
  const writeTool = registry.tools.find((tool) => tool.name === "Write");
  const editTool = registry.tools.find((tool) => tool.name === "Edit");
  const mcpTool = registry.tools.find((tool) => tool.name === "mcp_docs_search");

  assert.deepEqual(writeTool?.constrainedSampling, {
    type: "json_schema",
    strict: "prefer",
  });
  assert.deepEqual(editTool?.constrainedSampling, writeTool?.constrainedSampling);
  assert.equal(readTool?.constrainedSampling, undefined);
  assert.equal(mcpTool?.constrainedSampling, undefined);
  assert.deepEqual(
    editTool?.prepareArguments?.({
      path: "notes.txt",
      old_string: "old",
      new_string: "new",
      expected_replacements: null,
      replace_all: null,
    }),
    {
      path: "notes.txt",
      old_string: "old",
      new_string: "new",
    },
  );
});

test("registry with a subagent runtime exposes Agent and the parent SendMessage", async () => {
  const harness = createRegistryHarness();
  const { registry } = await buildRegistry(harness, { withSubagentRuntime: true });
  const names = registry.tools.map((tool) => tool.name);
  assert.ok(names.includes("Agent"));
  assert.ok(names.includes("SendMessage"));
  assert.equal(registry.metadataByName.get("Agent").groupId, "subagent");
  assert.equal(registry.metadataByName.get("Agent").isReadOnly, false);
  assert.equal(registry.metadataByName.get("SendMessage").isReadOnly, true);
  assert.ok(registry.hasTool("agent"));
});

test("a WeCom principal cannot access desktop MCP or automation management", async () => {
  const desktop = await buildRegistry(createRegistryHarness(), { withSubagentRuntime: true });
  const wecom = await buildRegistry(createRegistryHarness(), {
    withSubagentRuntime: true,
    principal: WECOM_PRINCIPAL,
  });

  const desktopNames = desktop.registry.tools.map((tool) => tool.name);
  const wecomNames = wecom.registry.tools.map((tool) => tool.name);
  assert.ok(desktopNames.includes("McpManager"));
  assert.ok(!wecomNames.includes("McpManager"));
  assert.ok(desktopNames.includes("CronTaskManager"));
  assert.ok(!wecomNames.includes("CronTaskManager"));
  for (const name of [
    "Read",
    "Write",
    "Bash",
    "DatabaseExecute",
    "MemoryManager",
    "SkillsManager",
    "TunnelManager",
    "SSHManager",
    "ReadTerminal",
    "Agent",
    "mcp_docs_search",
  ]) {
    assert.ok(wecomNames.includes(name), `${name} must remain available to WeCom`);
  }
});

test("an empty channel system allowlist cannot recover the MCP manager escape hatch", async () => {
  const { registry } = await buildRegistry(createRegistryHarness(), {
    withSubagentRuntime: true,
    principal: WECOM_PRINCIPAL,
    allowedSystemTools: [],
    selectedSystemToolIds: ["http_get_test"],
  });
  const names = registry.tools.map((tool) => tool.name);

  for (const denied of [
    "Read",
    "Write",
    "Bash",
    "DatabaseQuery",
    "CronTaskManager",
    "Agent",
    "AskUserQuestion",
    "HttpGetTest",
  ]) {
    assert.ok(!names.includes(denied), `${denied} must be denied`);
  }
  for (const independentlyControlled of [
    "SkillsManager",
    "MemoryManager",
    "mcp_docs_search",
  ]) {
    assert.ok(names.includes(independentlyControlled), `${independentlyControlled} has its own gate`);
  }
  assert.ok(!names.includes("McpManager"));
});

test("channel system allowlist accepts catalog ids, runtime groups, and custom ids", async () => {
  const { registry } = await buildRegistry(createRegistryHarness(), {
    allowedSystemTools: ["read", "office", "http_get_test"],
    selectedSystemToolIds: ["http_get_test"],
  });
  const names = registry.tools.map((tool) => tool.name);

  assert.ok(names.includes("Read"));
  assert.ok(names.includes("OfficeRuntime"));
  assert.ok(names.includes("SpreadsheetCode"));
  assert.ok(names.includes("HttpGetTest"));
  assert.ok(!names.includes("Write"));
  assert.ok(!names.includes("Bash"));
});

test("memoryEnabled false removes MemoryManager regardless of system allowlist", async () => {
  const { registry } = await buildRegistry(createRegistryHarness(), {
    allowedSystemTools: ["memory_manager"],
    memoryEnabled: false,
  });

  assert.equal(registry.hasTool("MemoryManager"), false);
});

test("workspaceAccess none keeps resource tools but excludes every workdir-bound surface", async () => {
  const harness = createRegistryHarness();
  const { registry } = await buildRegistry(harness, {
    withSubagentRuntime: true,
    workspaceAccess: "none",
  });
  const names = registry.tools.map((tool) => tool.name);

  assert.ok(names.includes("SkillsManager"));
  assert.ok(names.includes("DatabaseQuery"));
  assert.ok(names.includes("mcp_docs_search"));
  for (const name of [
    "Read",
    "List",
    "Glob",
    "Grep",
    "Bash",
    "ManagedProcess",
    "CronManager",
    "McpManager",
    "MemoryManager",
    "TunnelManager",
    "SSHManager",
    "Terminal",
    "ReadTerminal",
    "DatabaseExecute",
    "Agent",
    "AgentBatch",
    "SendMessage",
  ]) {
    assert.ok(!names.includes(name), `${name} must not be registered without a workspace`);
  }
});

test("Agent tool description embeds the hydrated roster and enabled templates", async () => {
  const harness = createRegistryHarness();
  const storeIpc = createFakeStoreIpc();
  storeIpc.seedIdentity({
    parentConversationId: "conversation-1",
    agentId: "historian",
    name: "Historian",
    role: "History research",
    identityPrompt: "",
    lastMode: "readonly",
    createdAt: 1,
    updatedAt: 2,
  });
  storeIpc.seedRun({
    run: {
      id: "run-1",
      parentConversationId: "conversation-1",
      parentToolCallId: "call-old",
      agentId: "historian",
      agentIndex: 0,
      agentTotal: 1,
      prompt: "study the era",
      mode: "readonly",
      status: "completed",
      providerId: "codex",
      model: "gpt-5",
      contextSchemaVersion: 2,
      activeSegmentIndex: 0,
      totalSegmentCount: 1,
      totalMessageCount: 2,
      roundCount: 1,
      toolCallCount: 0,
      compactionCount: 0,
      summary: "Era catalogued.",
      startedAt: 1,
      updatedAt: 2,
    },
    segments: [],
  });

  const { registry } = await buildRegistry(harness, { withSubagentRuntime: true, storeIpc });
  const agentTool = registry.tools.find((tool) => tool.name === "Agent");
  assert.match(
    agentTool.description,
    /id=historian name=Historian role=History research mode=readonly status=completed summary=Era catalogued\./,
  );
  assert.match(agentTool.description, /reviewer \(Reviewer\) - Review code paths/);
});

test("worktree children get the candidate fs/shell surface but no resource or manager tools", async () => {
  const harness = createRegistryHarness();
  const { registry } = await buildRegistry(harness, { withSubagentRuntime: true });

  const result = await registry.executeToolCall(
    createAgentToolCall({
      agents: [{ id: "agent-a", prompt: "Use docs if useful.", mode: "worktree" }],
    }),
  );
  assert.equal(result.isError, false, JSON.stringify(result));
  // MCP tools listed once for the parent registry and once for the child.
  assert.deepEqual(harness.listedServerIds, [["docs"], ["docs"]]);
  assert.equal(harness.runnerCalls.length, 1);
  const names = harness.runnerCalls[0].tools.map((tool) => tool.name);

  assert.ok(names.includes("Read"));
  assert.ok(names.includes("Write"));
  assert.ok(names.includes("Bash"));
  assert.ok(names.includes("SendMessage"));

  assert.ok(!names.includes("Agent"));
  assert.ok(!names.includes("SkillsManager"));
  assert.ok(!names.includes("McpManager"));
  assert.ok(!names.includes("mcp_docs_search"));
  assert.ok(!names.includes("MemoryManager"));
  assert.ok(!names.includes("CronTaskManager"));
  assert.ok(!names.includes("ReadTerminal"));

  // The child executed inside the isolated worktree workdir.
  assert.equal(harness.runnerCalls[0].workdir, "/tmp/arcforge-subagents/agent-a");
});

test("subagent registries list MCP servers from live settings, not turn-start snapshots", async () => {
  const harness = createRegistryHarness();
  const { registry, mcpSettingsHolder } = await buildRegistry(harness, {
    withSubagentRuntime: true,
  });

  // The config changes after the parent registry was built (e.g. the model
  // just ran McpManager update); the child registry must see the new config
  // instead of rolling the server back to the turn-start snapshot.
  mcpSettingsHolder.value = {
    selected: ["docs"],
    servers: [{ ...DOCS_SERVER, command: "mock-mcp-server-v2" }],
  };

  const result = await registry.executeToolCall(
    createAgentToolCall({
      agents: [{ id: "agent-live", prompt: "Use docs if useful.", mode: "worktree" }],
    }),
  );
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.deepEqual(harness.listedServerCommands, [["mock-mcp-server"], ["mock-mcp-server-v2"]]);
});

test("read-only children inherit MCP business tools but no write, shell, or manager tools", async () => {
  const harness = createRegistryHarness();
  const { registry } = await buildRegistry(harness, { withSubagentRuntime: true });

  const result = await registry.executeToolCall(
    createAgentToolCall({
      agents: [{ id: "agent-b", prompt: "Search docs if useful.", mode: "readonly" }],
    }),
  );
  assert.equal(result.isError, false);
  assert.equal(harness.runnerCalls.length, 1);
  const names = harness.runnerCalls[0].tools.map((tool) => tool.name);

  assert.ok(names.includes("Read"));
  assert.ok(names.includes("mcp_docs_search"));
  assert.ok(names.includes("SendMessage"));

  assert.ok(!names.includes("Write"));
  assert.ok(!names.includes("Bash"));
  assert.ok(!names.includes("Agent"));
  assert.ok(!names.includes("McpManager"));
  // Parent memory is read-write, so readonly children do not receive it.
  assert.ok(!names.includes("MemoryManager"));
});

test("VisualReview is registered only when a review model runtime is provided", async () => {
  const review = {
    providerId: "codex",
    model: "gpt-5",
    source: "configured",
    runtime: { baseUrl: "https://api.openai.com/v1", apiKey: "key" },
  };
  const { registry: withReview } = await buildRegistry(createRegistryHarness(), {
    visualReview: review,
  });
  const withNames = withReview.tools.map((tool) => tool.name);
  assert.ok(withNames.includes("VisualReview"));
  assert.equal(withReview.metadataByName.get("VisualReview")?.isReadOnly, true);

  const { registry: withoutReview } = await buildRegistry(createRegistryHarness());
  assert.ok(!withoutReview.tools.map((tool) => tool.name).includes("VisualReview"));

  const { registry: readOnlyWorkspace } = await buildRegistry(createRegistryHarness(), {
    visualReview: review,
    workspaceAccess: "none",
  });
  assert.ok(!readOnlyWorkspace.tools.map((tool) => tool.name).includes("VisualReview"));
});
