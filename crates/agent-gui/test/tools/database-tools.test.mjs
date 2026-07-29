import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function loadDatabaseTools(handler) {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          return handler(command, args);
        },
      },
    },
  });
  return { module: loader.loadModule("src/lib/tools/databaseTools.ts"), calls };
}

function wecomPrincipal(overrides = {}) {
  return {
    channel: "wecom",
    chatType: "direct",
    scopes: ["database:read"],
    allowedDatabaseProfileIds: ["finance"],
    ...overrides,
  };
}

test("database tools split read and write metadata and keep writes out of cron", () => {
  const { module } = loadDatabaseTools(() => undefined);
  const chat = module.createDatabaseTools({ runtimeScope: "chat" });
  assert.equal(chat.groupId, "database");
  assert.deepEqual(
    chat.tools.map((tool) => tool.name),
    ["DatabaseQuery", "DatabaseExecute"],
  );
  assert.equal(chat.metadataByName.get("DatabaseQuery").isReadOnly, true);
  assert.equal(chat.metadataByName.get("DatabaseExecute").isReadOnly, false);

  const cron = module.createDatabaseTools({ runtimeScope: "cron_auto_prompt" });
  assert.deepEqual(cron.tools.map((tool) => tool.name), ["DatabaseQuery"]);

  const recent = module.createDatabaseTools({ runtimeScope: "chat", workspaceAccess: "none" });
  assert.deepEqual(recent.tools.map((tool) => tool.name), ["DatabaseQuery"]);
});

test("WeCom exposes a saved-profile-only query schema and never exposes writes", () => {
  const { module } = loadDatabaseTools(() => undefined);
  const bundle = module.createDatabaseTools({
    runtimeScope: "chat",
    principal: wecomPrincipal(),
  });

  assert.deepEqual(bundle.tools.map((tool) => tool.name), ["DatabaseQuery"]);
  const query = bundle.tools[0];
  assert.equal(query.parameters.properties.connection, undefined);
  assert.match(query.description, /saved database profile explicitly granted/);
  assert.doesNotMatch(query.description, /connection details are not accepted.*password/i);
});

test("database schemas require typed parameters and saved profiles for writes", () => {
  const { module } = loadDatabaseTools(() => undefined);
  const bundle = module.createDatabaseTools({ runtimeScope: "chat" });
  const query = bundle.tools.find((tool) => tool.name === "DatabaseQuery");
  const execute = bundle.tools.find((tool) => tool.name === "DatabaseExecute");

  assert.deepEqual(
    validateToolArguments(query, {
      type: "toolCall",
      id: "query-list",
      name: "DatabaseQuery",
      arguments: { action: "list_connections" },
    }),
    { action: "list_connections" },
  );
  assert.deepEqual(
    validateToolArguments(query, {
      type: "toolCall",
      id: "query-one",
      name: "DatabaseQuery",
      arguments: {
        action: "query",
        profile_id: "main",
        sql: "SELECT * FROM users WHERE id = $1",
        params: [{ type: "integer", value: "42" }],
      },
    }),
    {
      action: "query",
      profile_id: "main",
      sql: "SELECT * FROM users WHERE id = $1",
      params: [{ type: "integer", value: "42" }],
    },
  );
  assert.throws(
    () =>
      validateToolArguments(execute, {
        type: "toolCall",
        id: "execute-extra",
        name: "DatabaseExecute",
        arguments: {
          profile_id: "main",
          sql: "UPDATE users SET active = $1 WHERE id = $2",
          params: [
            { type: "boolean", value: true },
            { type: "integer", value: "42" },
          ],
          dsn: "postgres://secret",
        },
      }),
    /unexpected property|additional properties|dsn/i,
  );
  assert.throws(
    () =>
      validateToolArguments(execute, {
        type: "toolCall",
        id: "execute-transient",
        name: "DatabaseExecute",
        arguments: {
          connection: { driver: "sqlite", sqlite_path: "C:\\data\\app.sqlite" },
          sql: "DELETE FROM t WHERE id = ?",
        },
      }),
    /unexpected property|additional properties|connection/i,
  );
});

test("list_connections exposes safe summaries only", async () => {
  const { module, calls } = loadDatabaseTools((command) => {
    assert.equal(command, "database_profiles_list");
    return [
      {
        id: "finance",
        name: "Finance",
        driver: "postgresql",
        host: "db.internal",
        port: 5432,
        databaseName: "ledger",
        username: "admin",
        sslMode: "require",
        sqlitePath: "",
        enabled: true,
        allowWrites: false,
        queryTimeoutMs: 15000,
        maxRows: 200,
        maxAffectedRows: 100,
        passwordConfigured: true,
      },
    ];
  });
  const bundle = module.createDatabaseTools({ runtimeScope: "chat" });
  const result = await bundle.executeToolCall({
    id: "db-list",
    name: "DatabaseQuery",
    arguments: { action: "list_connections" },
  });

  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /Finance/);
  assert.doesNotMatch(result.content[0].text, /db\.internal|admin|passwordConfigured/);
  assert.deepEqual(calls, [{ command: "database_profiles_list", args: undefined }]);
});

test("WeCom list_connections returns only enabled profiles in the ACL allowlist", async () => {
  const { module, calls } = loadDatabaseTools((command) => {
    assert.equal(command, "database_profiles_list");
    return [
      {
        id: "finance",
        name: "Finance",
        driver: "postgresql",
        databaseName: "ledger",
        enabled: true,
        allowWrites: true,
      },
      {
        id: "hr",
        name: "HR",
        driver: "mysql",
        databaseName: "people",
        enabled: true,
        allowWrites: false,
      },
      {
        id: "disabled",
        name: "Disabled",
        driver: "sqlite",
        databaseName: "archive",
        enabled: false,
        allowWrites: false,
      },
    ];
  });
  const bundle = module.createDatabaseTools({
    runtimeScope: "chat",
    principal: wecomPrincipal({ allowedDatabaseProfileIds: ["finance", "disabled"] }),
  });
  const result = await bundle.executeToolCall({
    id: "db-list-wecom",
    name: "DatabaseQuery",
    arguments: { action: "list_connections" },
  });

  assert.equal(result.isError, false);
  assert.deepEqual(result.details.connections.map((profile) => profile.id), ["finance"]);
  assert.doesNotMatch(result.content[0].text, /HR|Disabled/);
  assert.equal(calls.length, 1);
});

test("WeCom rejects unauthorized database arguments before invoking IPC", async () => {
  const cases = [
    {
      label: "group chat",
      principal: wecomPrincipal({ chatType: "group" }),
      arguments: { action: "list_connections" },
    },
    {
      label: "missing scope",
      principal: wecomPrincipal({ scopes: [] }),
      arguments: { action: "list_connections" },
    },
    {
      label: "empty profile grant",
      principal: wecomPrincipal({ allowedDatabaseProfileIds: [] }),
      arguments: { action: "list_connections" },
    },
    {
      label: "ad-hoc connection",
      principal: wecomPrincipal(),
      arguments: {
        action: "query",
        connection: { driver: "mysql", password: "must-not-survive" },
        sql: "SELECT 1",
      },
    },
    {
      label: "missing profile",
      principal: wecomPrincipal(),
      arguments: { action: "query", sql: "SELECT 1" },
    },
    {
      label: "profile outside allowlist",
      principal: wecomPrincipal(),
      arguments: { action: "query", profile_id: "hr", sql: "SELECT 1" },
    },
  ];

  for (const item of cases) {
    const { module, calls } = loadDatabaseTools(() => {
      throw new Error(`IPC must not run for ${item.label}`);
    });
    const bundle = module.createDatabaseTools({
      runtimeScope: "chat",
      principal: item.principal,
    });
    const toolCall = {
      id: `db-denied-${item.label}`,
      name: "DatabaseQuery",
      arguments: item.arguments,
    };
    const result = await bundle.executeToolCall(toolCall);
    assert.equal(result.isError, true, item.label);
    assert.match(result.content[0].text, /blocked/i, item.label);
    assert.equal(calls.length, 0, item.label);
    if (item.label === "ad-hoc connection") {
      assert.equal(toolCall.arguments.connection.password, "[redacted credential]");
    }
  }

  const { module, calls } = loadDatabaseTools(() => {
    throw new Error("database_execute IPC must not run");
  });
  const bundle = module.createDatabaseTools({
    runtimeScope: "chat",
    principal: wecomPrincipal(),
  });
  const writeResult = await bundle.executeToolCall({
    id: "db-write-wecom",
    name: "DatabaseExecute",
    arguments: { profile_id: "finance", sql: "DELETE FROM ledger WHERE id = 1" },
  });
  assert.equal(writeResult.isError, true);
  assert.match(writeResult.content[0].text, /writes are disabled for WeCom/i);
  assert.equal(calls.length, 0);
});

test("query and execute map model snake_case arguments to backend camelCase", async () => {
  const { module, calls } = loadDatabaseTools((command) => {
    if (command === "database_query") {
      return {
        profileId: "main",
        columns: [{ name: "id", dataType: "INT8" }],
        rows: [[{ type: "integer", value: "7" }]],
        rowCount: 1,
        truncated: false,
        durationMs: 3,
      };
    }
    return { profileId: "main", affectedRows: 1, durationMs: 4 };
  });
  const bundle = module.createDatabaseTools({ runtimeScope: "chat" });

  const queryResult = await bundle.executeToolCall({
    id: "db-query",
    name: "DatabaseQuery",
    arguments: {
      action: "query",
      profile_id: "main",
      sql: "SELECT id FROM t LIMIT $1",
      params: [{ type: "integer", value: "1" }],
      max_rows: 10,
      timeout_ms: 5000,
    },
  });
  const writeResult = await bundle.executeToolCall({
    id: "db-write",
    name: "DatabaseExecute",
    arguments: {
      profile_id: "main",
      sql: "DELETE FROM t WHERE id = $1",
      params: [{ type: "integer", value: "7" }],
      max_affected_rows: 2,
    },
  });

  assert.equal(queryResult.isError, false);
  assert.equal(writeResult.isError, false);
  assert.deepEqual(calls, [
    {
      command: "database_query",
      args: {
        input: {
          profileId: "main",
          connection: undefined,
          action: "query",
          sql: "SELECT id FROM t LIMIT $1",
          params: [{ type: "integer", value: "1" }],
          schema: undefined,
          table: undefined,
          maxRows: 10,
          timeoutMs: 5000,
        },
      },
    },
    {
      command: "database_execute",
      args: {
        input: {
          profileId: "main",
          sql: "DELETE FROM t WHERE id = $1",
          params: [{ type: "integer", value: "7" }],
          maxAffectedRows: 2,
          timeoutMs: undefined,
        },
      },
    },
  ]);
});

test("temporary user or Skill connections are execution-only and scrubbed in place", async () => {
  const { module, calls } = loadDatabaseTools(() => ({
    profileId: "ephemeral",
    columns: [{ name: "value", dataType: "INT" }],
    rows: [[{ type: "integer", value: "1" }]],
    rowCount: 1,
    truncated: false,
    durationMs: 2,
  }));
  const bundle = module.createDatabaseTools({ runtimeScope: "chat" });
  const toolCall = {
    id: "db-ephemeral",
    name: "DatabaseQuery",
    arguments: {
      action: "query",
      connection: {
        driver: "mysql",
        host: "db.internal",
        port: 3306,
        database_name: "sales",
        username: "reader",
        password: "never-echo-this",
        ssl_mode: "require",
      },
      sql: "SELECT 1",
    },
  };
  const result = await bundle.executeToolCall(toolCall);

  assert.equal(result.isError, false);
  assert.doesNotMatch(result.content[0].text, /never-echo-this|db\.internal|reader/);
  assert.equal(toolCall.arguments.connection.password, "[redacted credential]");
  assert.deepEqual(calls[0], {
    command: "database_query",
    args: {
      input: {
        profileId: undefined,
        connection: {
          driver: "mysql",
          host: "db.internal",
          port: 3306,
          databaseName: "sales",
          username: "reader",
          password: "never-echo-this",
          sslMode: "require",
          sqlitePath: undefined,
        },
        action: "query",
        sql: "SELECT 1",
        params: undefined,
        schema: undefined,
        table: undefined,
        maxRows: undefined,
        timeoutMs: undefined,
      },
    },
  });
});

test("database backend errors remain structured and aborts never invoke", async () => {
  const { module, calls } = loadDatabaseTools(() => {
    throw { code: "DB_TIMEOUT", message: "The database operation timed out." };
  });
  const bundle = module.createDatabaseTools({ runtimeScope: "chat" });
  const result = await bundle.executeToolCall({
    id: "db-error",
    name: "DatabaseQuery",
    arguments: { action: "query", profile_id: "main", sql: "SELECT 1" },
  });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "DB_TIMEOUT: The database operation timed out.");

  const controller = new AbortController();
  controller.abort();
  const aborted = await bundle.executeToolCall(
    { id: "db-abort", name: "DatabaseQuery", arguments: { action: "list_connections" } },
    controller.signal,
  );
  assert.equal(aborted.isError, true);
  assert.equal(aborted.content[0].text, "Cancelled");
  assert.equal(calls.length, 1);
});

test("unstructured IPC errors fail closed without exposing driver context", async () => {
  const { module } = loadDatabaseTools(() => {
    throw "connection failed for postgres://reader:secret@db.internal/app";
  });
  const bundle = module.createDatabaseTools({ runtimeScope: "chat" });
  const result = await bundle.executeToolCall({
    id: "db-raw-error",
    name: "DatabaseQuery",
    arguments: { action: "query", profile_id: "main", sql: "SELECT 1" },
  });

  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "DB_INTERNAL: The database operation failed.");
  assert.doesNotMatch(result.content[0].text, /reader|secret|db\.internal/);
});
