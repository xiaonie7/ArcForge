import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  REDACTED_DATABASE_PASSWORD,
  redactDatabaseSecretsForPersistence,
  redactDatabaseToolArguments,
} = loader.loadModule("src/lib/security/databaseToolSecrets.ts");

test("database argument redaction copies only transient password fields", () => {
  const input = {
    action: "query",
    connection: {
      driver: "postgresql",
      host: "db.internal",
      password: "secret-value",
    },
    sql: "SELECT 1",
  };
  const redacted = redactDatabaseToolArguments("DatabaseQuery", input);

  assert.notEqual(redacted, input);
  assert.equal(redacted.connection.password, REDACTED_DATABASE_PASSWORD);
  assert.equal(input.connection.password, "secret-value");
  assert.equal(redacted.connection.host, "db.internal");
  assert.equal(redactDatabaseToolArguments("Read", input), input);
});

test("history redaction scrubs database ToolCalls without changing user or Skill text", () => {
  const messages = [
    { role: "user", content: "password=keep-as-user-authored-context" },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "db-1",
          name: "DatabaseQuery",
          arguments: {
            action: "query",
            connection: { driver: "mysql", password: "tool-secret" },
            sql: "SELECT 1",
          },
        },
      ],
    },
  ];
  const redacted = redactDatabaseSecretsForPersistence(messages);

  assert.equal(redacted[0].content, messages[0].content);
  assert.equal(
    redacted[1].content[0].arguments.connection.password,
    REDACTED_DATABASE_PASSWORD,
  );
  assert.equal(messages[1].content[0].arguments.connection.password, "tool-secret");
});

test("Gateway previews, local tool cards, and history persistence use database redaction", () => {
  const gatewaySource = readFileSync(
    new URL("../../src/pages/chat/turns/gatewayToolPreview.ts", import.meta.url),
    "utf8",
  );
  const uiSource = readFileSync(
    new URL("../../src/lib/chat/messages/uiMessages.ts", import.meta.url),
    "utf8",
  );
  const historySource = readFileSync(
    new URL("../../src/lib/chat/history/chatHistory.ts", import.meta.url),
    "utf8",
  );

  assert.match(gatewaySource, /redactDatabaseToolArguments\(toolCall\.name/);
  assert.match(uiSource, /redactDatabaseToolArguments\(toolCall\.name/);
  assert.match(historySource, /redactDatabaseSecretsForPersistence\(segment\.messages\)/);
});
