import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";
import { Type } from "typebox";

import { redactDatabaseToolArgumentsInPlace } from "../security/databaseToolSecrets";
import { type BuiltinToolBundle, createBuiltinMetadataMap } from "./builtinTypes";
import type { SystemToolRuntimeScope } from "./systemToolOptions";

const DATABASE_QUERY_TOOL_NAME = "DatabaseQuery";
const DATABASE_EXECUTE_TOOL_NAME = "DatabaseExecute";

type DatabaseProfileSummary = {
  id: string;
  name: string;
  driver: "sqlite" | "postgresql" | "mysql";
  databaseName: string;
  enabled: boolean;
  allowWrites: boolean;
  passwordConfigured: boolean;
};

type DatabaseQueryResponse = {
  profileId: string;
  columns: Array<{ name: string; dataType: string }>;
  rows: Array<
    Array<{
      type: string;
      value?: unknown;
      truncated?: boolean;
    }>
  >;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
};

type DatabaseExecuteResponse = {
  profileId: string;
  affectedRows: number;
  durationMs: number;
};

type DatabaseBackendError = {
  code?: string;
  message?: string;
};

const DATABASE_PARAMETER = Type.Union([
  Type.Object({ type: Type.Literal("null") }, { additionalProperties: false }),
  Type.Object(
    { type: Type.Literal("boolean"), value: Type.Boolean() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("integer"),
      value: Type.String({ description: "Signed 64-bit integer in decimal notation." }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("float"), value: Type.Number() },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("text"), value: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("bytes_base64"), value: Type.String() },
    { additionalProperties: false },
  ),
]);

const DATABASE_CONNECTION = Type.Object(
  {
    driver: Type.Union([Type.Literal("sqlite"), Type.Literal("postgresql"), Type.Literal("mysql")]),
    host: Type.Optional(Type.String()),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
    database_name: Type.Optional(Type.String()),
    username: Type.Optional(Type.String()),
    password: Type.Optional(
      Type.String({
        writeOnly: true,
        description:
          "Password explicitly supplied by the user or an enabled Skill. Used only for this call.",
      }),
    ),
    ssl_mode: Type.Optional(
      Type.Union([
        Type.Literal("disable"),
        Type.Literal("prefer"),
        Type.Literal("require"),
        Type.Literal("verify_ca"),
        Type.Literal("verify_full"),
      ]),
    ),
    sqlite_path: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

function createDatabaseQueryTool(): Tool {
  return {
    name: DATABASE_QUERY_TOOL_NAME,
    description:
      "Read from a database connection configured by the user in ArcForge. Use action=list_connections " +
      "first when the profile id is unknown. The backend enforces one read-only statement, a read-only " +
      "database transaction, bound parameters, timeout, row, cell, and payload limits. A connection " +
      "explicitly provided by the user or an enabled Skill may be passed with connection and is used " +
      "only for this call; never repeat its password in output. PostgreSQL uses " +
      "$1, $2 placeholders; MySQL and SQLite use ? placeholders. Never place values directly into SQL.",
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("list_connections"),
          Type.Literal("list_tables"),
          Type.Literal("describe_table"),
          Type.Literal("query"),
        ]),
        profile_id: Type.Optional(
          Type.String({
            description:
              "Configured connection id. Use either profile_id or connection; omit both only for list_connections.",
          }),
        ),
        connection: Type.Optional(DATABASE_CONNECTION),
        sql: Type.Optional(
          Type.String({ description: "One read-only SQL statement for action=query." }),
        ),
        params: Type.Optional(
          Type.Array(DATABASE_PARAMETER, {
            maxItems: 100,
            description: "Typed positional values bound by the database driver.",
          }),
        ),
        schema: Type.Optional(Type.String({ description: "Optional schema for catalog actions." })),
        table: Type.Optional(
          Type.String({ description: "Required table name for action=describe_table." }),
        ),
        max_rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
        timeout_ms: Type.Optional(Type.Integer({ minimum: 1000, maximum: 60000 })),
      },
      { additionalProperties: false },
    ),
  };
}

const databaseExecuteTool: Tool = {
  name: DATABASE_EXECUTE_TOOL_NAME,
  description:
    "Execute one parameterized INSERT, UPDATE, or DELETE against a user-configured database. This tool " +
    "works only in a workspace-scoped chat and only with a saved profile whose Allow writes switch is on. " +
    "Temporary user or Skill connections are read-only and cannot be used by this tool. " +
    "UPDATE and DELETE require a WHERE clause. DDL, stored procedures, grants, and multiple statements " +
    "are rejected. The transaction is rolled back if the affected-row safety limit is exceeded. " +
    "PostgreSQL uses $1, $2 placeholders; MySQL and SQLite use ? placeholders.",
  parameters: Type.Object(
    {
      profile_id: Type.String({
        description: "Saved connection id with Allow writes enabled.",
      }),
      sql: Type.String({ description: "One INSERT, UPDATE, or DELETE statement." }),
      params: Type.Optional(Type.Array(DATABASE_PARAMETER, { maxItems: 100 })),
      max_affected_rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
      timeout_ms: Type.Optional(Type.Integer({ minimum: 1000, maximum: 60000 })),
    },
    { additionalProperties: false },
  ),
};

function asArguments(toolCall: ToolCall) {
  if (
    !toolCall.arguments ||
    typeof toolCall.arguments !== "object" ||
    Array.isArray(toolCall.arguments)
  ) {
    throw new Error(`${toolCall.name} arguments must be an object.`);
  }
  return toolCall.arguments as Record<string, unknown>;
}

function databaseErrorMessage(error: unknown) {
  if (error && typeof error === "object") {
    const value = error as DatabaseBackendError;
    if (
      typeof value.code === "string" &&
      /^DB_[A-Z_]+$/.test(value.code) &&
      typeof value.message === "string" &&
      value.message.trim()
    ) {
      return `${value.code}: ${value.message}`;
    }
  }
  if (typeof error === "string") {
    try {
      const value = JSON.parse(error) as DatabaseBackendError;
      if (
        typeof value.code === "string" &&
        /^DB_[A-Z_]+$/.test(value.code) &&
        typeof value.message === "string" &&
        value.message.trim()
      ) {
        return `${value.code}: ${value.message}`;
      }
    } catch {
      // Unexpected IPC strings may contain driver context, so fail closed.
    }
  }
  return "DB_INTERNAL: The database operation failed.";
}

function resultMessage(
  toolCall: ToolCall,
  text: string,
  details: Record<string, unknown>,
  isError = false,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    details,
    isError,
    timestamp: Date.now(),
  };
}

function mapConnection(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const connection = value as Record<string, unknown>;
  return {
    driver: connection.driver,
    host: connection.host,
    port: connection.port,
    databaseName: connection.database_name,
    username: connection.username,
    password: connection.password,
    sslMode: connection.ssl_mode,
    sqlitePath: connection.sqlite_path,
  };
}

async function executeDatabaseQuery(toolCall: ToolCall): Promise<ToolResultMessage> {
  const args = asArguments(toolCall);
  // Keep an execution-only copy, then scrub the ToolCall object that is
  // retained by the runner and eventually written to chat history.
  const transientConnection = mapConnection(args.connection);
  redactDatabaseToolArgumentsInPlace(toolCall.name, args);
  if (args.action === "list_connections") {
    const profiles = await invoke<DatabaseProfileSummary[]>("database_profiles_list");
    const summaries = profiles
      .filter((profile) => profile.enabled)
      .map(({ id, name, driver, databaseName, allowWrites }) => ({
        id,
        name,
        driver,
        databaseName,
        allowWrites,
      }));
    return resultMessage(toolCall, JSON.stringify({ connections: summaries }, null, 2), {
      connections: summaries,
    });
  }

  const result = await invoke<DatabaseQueryResponse>("database_query", {
    input: {
      profileId: args.profile_id,
      connection: transientConnection,
      action: args.action,
      sql: args.sql,
      params: args.params,
      schema: args.schema,
      table: args.table,
      maxRows: args.max_rows,
      timeoutMs: args.timeout_ms,
    },
  });
  return resultMessage(toolCall, JSON.stringify(result, null, 2), {
    kind: "database_query",
    ...result,
  });
}

async function executeDatabaseWrite(toolCall: ToolCall): Promise<ToolResultMessage> {
  const args = asArguments(toolCall);
  const result = await invoke<DatabaseExecuteResponse>("database_execute", {
    input: {
      profileId: args.profile_id,
      sql: args.sql,
      params: args.params,
      maxAffectedRows: args.max_affected_rows,
      timeoutMs: args.timeout_ms,
    },
  });
  return resultMessage(toolCall, JSON.stringify(result, null, 2), {
    kind: "database_execute",
    ...result,
  });
}

export function createDatabaseTools(params: {
  runtimeScope: SystemToolRuntimeScope;
  workspaceAccess?: "full" | "none";
}): BuiltinToolBundle {
  const databaseQueryTool = createDatabaseQueryTool();
  const allowWrites = params.runtimeScope === "chat" && params.workspaceAccess !== "none";
  const tools = allowWrites ? [databaseQueryTool, databaseExecuteTool] : [databaseQueryTool];

  return {
    groupId: "database",
    tools,
    async executeToolCall(toolCall, signal) {
      if (signal?.aborted) return resultMessage(toolCall, "Cancelled", {}, true);
      try {
        if (toolCall.name === DATABASE_QUERY_TOOL_NAME) return await executeDatabaseQuery(toolCall);
        if (toolCall.name === DATABASE_EXECUTE_TOOL_NAME)
          return await executeDatabaseWrite(toolCall);
        return resultMessage(toolCall, `Unknown tool: ${toolCall.name}`, {}, true);
      } catch (error) {
        return resultMessage(toolCall, databaseErrorMessage(error), {}, true);
      }
    },
    metadataByName: createBuiltinMetadataMap(
      tools.map((tool) => [
        tool.name,
        {
          groupId: "database" as const,
          kind: tool.name === DATABASE_QUERY_TOOL_NAME ? "database_query" : "database_execute",
          isReadOnly: tool.name === DATABASE_QUERY_TOOL_NAME,
          displayCategory: "system" as const,
        },
      ]),
    ),
  };
}
