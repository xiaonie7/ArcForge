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
    tenantId: "tenant-1",
    botId: "bot-1",
    externalUserId: "user-1",
    chatType: "direct",
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

test("WeCom exposes the same database tools and query schema as desktop chat", () => {
  const { module } = loadDatabaseTools(() => undefined);
  const desktop = module.createDatabaseTools({ runtimeScope: "chat" });
  const wecom = module.createDatabaseTools({
    runtimeScope: "chat",
    principal: wecomPrincipal(),
  });

  assert.deepEqual(
    wecom.tools.map((tool) => tool.name),
    desktop.tools.map((tool) => tool.name),
  );
  const desktopQuery = desktop.tools.find((tool) => tool.name === "DatabaseQuery");
  const wecomQuery = wecom.tools.find((tool) => tool.name === "DatabaseQuery");
  assert.deepEqual(wecomQuery.parameters, desktopQuery.parameters);
  assert.ok(wecomQuery.parameters.properties.connection);
  assert.ok(wecom.tools.some((tool) => tool.name === "DatabaseExecute"));
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

test("WeCom list_connections returns every enabled profile without an ACL filter", async () => {
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
    // Legacy grant-shaped fields must not alter the channel's database view.
    principal: wecomPrincipal({ allowedDatabaseProfileIds: ["finance", "disabled"] }),
  });
  const result = await bundle.executeToolCall({
    id: "db-list-wecom",
    name: "DatabaseQuery",
    arguments: { action: "list_connections" },
  });

  assert.equal(result.isError, false);
  assert.deepEqual(result.details.connections.map((profile) => profile.id), ["finance", "hr"]);
  assert.match(result.content[0].text, /Finance/);
  assert.match(result.content[0].text, /HR/);
  assert.doesNotMatch(result.content[0].text, /Disabled/);
  assert.equal(calls.length, 1);
});

test("WeCom accepts transient reads and saved-profile writes through the normal IPC path", async () => {
  const { module, calls } = loadDatabaseTools((command) => {
    if (command === "database_query") {
      return {
        profileId: "",
        columns: [{ name: "one", dataType: "INT" }],
        rows: [[{ type: "integer", value: "1" }]],
        rowCount: 1,
        truncated: false,
        durationMs: 1,
      };
    }
    assert.equal(command, "database_execute");
    return { profileId: "finance", affectedRows: 1, durationMs: 2 };
  });
  const bundle = module.createDatabaseTools({
    runtimeScope: "chat",
    principal: wecomPrincipal({
      chatType: "group",
      scopes: [],
      allowedDatabaseProfileIds: [],
    }),
  });
  const queryCall = {
    id: "db-query-wecom",
    name: "DatabaseQuery",
    arguments: {
      action: "query",
      connection: {
        driver: "mysql",
        host: "db.internal",
        database_name: "ledger",
        username: "reader",
        password: "must-not-survive",
      },
      sql: "SELECT 1",
    },
  };
  const queryResult = await bundle.executeToolCall(queryCall);
  const writeResult = await bundle.executeToolCall({
    id: "db-write-wecom",
    name: "DatabaseExecute",
    arguments: { profile_id: "finance", sql: "DELETE FROM ledger WHERE id = 1" },
  });

  assert.equal(queryResult.isError, false);
  assert.equal(writeResult.isError, false);
  assert.equal(queryCall.arguments.connection.password, "[redacted credential]");
  assert.deepEqual(
    calls.map((call) => call.command),
    ["database_query", "database_execute"],
  );
  assert.equal(calls[0].args.input.connection.password, "must-not-survive");
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
