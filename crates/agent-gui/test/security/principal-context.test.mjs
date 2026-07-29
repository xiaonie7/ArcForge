import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  buildTrustedPrincipalSystemPrompt,
  derivePrincipalConversationId,
  normalizeTrustedChannelOrigin,
  resolvePrincipalContext,
} = loader.loadModule("src/lib/security/principalContext.ts");
const { createBuiltinToolAuthorizationPolicy } = loader.loadModule(
  "src/lib/security/toolAuthorizationPolicy.ts",
);
const { normalizeWeComAccessPolicy, principalCanUseSkill, resolveWeComGrant } = loader.loadModule(
  "src/lib/security/wecomAccessPolicy.ts",
);

function trustedOrigin(overrides = {}) {
  return {
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
    requestId: "request-1",
    authTime: 1_700_000_000,
    ...overrides,
  };
}

test("channel session changes conversation identity without changing principal identity", async () => {
  const first = await resolvePrincipalContext(trustedOrigin());
  const second = await resolvePrincipalContext(
    trustedOrigin({
      channelSessionId: "session-2",
      channelCommand: "compact",
      externalMessageId: "message-2",
      requestId: "request-2",
    }),
  );

  assert.equal(first.principalId, second.principalId);
  const firstConversationId = await derivePrincipalConversationId(first);
  const secondConversationId = await derivePrincipalConversationId(second);
  assert.notEqual(firstConversationId, secondConversationId);
  const gatewayKey = [
    "wecom",
    "tenant-1",
    "bot-1",
    "direct",
    "direct",
    "user-1",
    "session-1",
  ].join("\0");
  assert.equal(
    firstConversationId,
    `wecom:${createHash("sha256").update(`conversation|${gatewayKey}`, "utf8").digest("hex")}`,
  );
  assert.equal(
    firstConversationId,
    "wecom:7625effa3c6fbdc88635b366952b2c80410b5a62dcc5a7aecb37e4c7cb6d0ec2",
  );
  assert.equal(second.channelSessionId, "session-2");
  assert.equal(second.channelCommand, "compact");
});

test("a group chat named direct cannot collide with a direct chat", async () => {
  const direct = await resolvePrincipalContext(trustedOrigin());
  const group = await resolvePrincipalContext(
    trustedOrigin({ chatType: "group", chatId: "direct" }),
  );

  assert.notEqual(direct.principalId, group.principalId);
  assert.notEqual(
    await derivePrincipalConversationId(direct),
    await derivePrincipalConversationId(group),
  );
});

test("trusted channel session and command fields are strictly validated", () => {
  assert.throws(
    () => normalizeTrustedChannelOrigin(trustedOrigin({ channelSessionId: "" })),
    /channel_session_id/,
  );
  assert.throws(
    () => normalizeTrustedChannelOrigin(trustedOrigin({ channelSessionId: "x".repeat(129) })),
    /channel_session_id/,
  );
  assert.throws(
    () => normalizeTrustedChannelOrigin(trustedOrigin({ channelCommand: "shell" })),
    /Unsupported trusted channel command/,
  );
  assert.throws(
    () => normalizeTrustedChannelOrigin(trustedOrigin({ channelCommand: 123 })),
    /channel_command/,
  );
});

test("WeCom principals carry the external user id without default MCP access", async () => {
  const principal = await resolvePrincipalContext(trustedOrigin({ externalUserId: "alice" }));
  assert.equal(principal.externalUserId, "alice");
  assert.equal(principal.policyVersion, 3);
  assert.equal(principal.scopes.includes("mcp:invoke"), false);
  assert.deepEqual(principal.scopes, ["interaction:respond"]);
  assert.equal(principal.defaultSkillName, "");
  assert.deepEqual(principal.allowedDatabaseProfileIds, []);
  const policy = createBuiltinToolAuthorizationPolicy(principal);
  const decision = policy.authorize({
    toolName: "mcp_docs_search",
    metadata: {
      groupId: "mcp",
      kind: "mcp",
      isReadOnly: false,
      displayCategory: "mcp",
    },
    principal,
  });
  assert.equal(decision.allowed, false);
  const systemPrompt = buildTrustedPrincipalSystemPrompt(principal);
  assert.match(systemPrompt, /external_user_id=alice/);
  assert.match(systemPrompt, /not user message content/);
});

test("WeCom ACL is default-deny for read tools and requires an exact identity tuple", async () => {
  const accessPolicy = {
    rules: [
      {
        tenantId: "tenant-1",
        botId: "bot-1",
        externalUserId: "alice",
        scopes: ["tool:read"],
        allowedToolNames: ["Read"],
      },
    ],
  };
  const unmatched = await resolvePrincipalContext(
    trustedOrigin({ externalUserId: "bob" }),
    undefined,
    accessPolicy,
  );
  const unmatchedPolicy = createBuiltinToolAuthorizationPolicy(unmatched);
  const readMetadata = {
    groupId: "fs",
    kind: "read",
    isReadOnly: true,
    displayCategory: "file",
  };
  assert.equal(
    unmatchedPolicy.authorize({ toolName: "Read", metadata: readMetadata, principal: unmatched })
      .allowed,
    false,
  );

  const matched = await resolvePrincipalContext(
    trustedOrigin({ externalUserId: "alice" }),
    undefined,
    accessPolicy,
  );
  const matchedPolicy = createBuiltinToolAuthorizationPolicy(matched);
  assert.equal(matched.scopes.includes("tool:read"), true);
  assert.equal(
    matchedPolicy.authorize({ toolName: "Read", metadata: readMetadata, principal: matched })
      .allowed,
    true,
  );
  assert.equal(
    matchedPolicy.authorize({
      toolName: "List",
      metadata: { ...readMetadata, kind: "list", displayCategory: "search" },
      principal: matched,
    }).allowed,
    false,
  );
});

test("WeCom grants DatabaseQuery only to direct chats with scope and profile resources", async () => {
  const principal = await resolvePrincipalContext(
    trustedOrigin({ externalUserId: "alice" }),
    undefined,
    {
      rules: [
        {
          tenantId: "tenant-1",
          botId: "bot-1",
          externalUserId: "alice",
          scopes: ["database:read"],
          allowedDatabaseProfileIds: ["finance-readonly"],
        },
      ],
    },
  );
  const policy = createBuiltinToolAuthorizationPolicy(principal);
  const queryInput = {
    toolName: "DatabaseQuery",
    metadata: {
      groupId: "database",
      kind: "database_query",
      isReadOnly: true,
      displayCategory: "system",
    },
    principal,
  };
  assert.equal(policy.isToolVisible(queryInput), true);
  assert.equal(policy.authorize(queryInput).allowed, true);

  const executeInput = {
    toolName: "DatabaseExecute",
    metadata: { ...queryInput.metadata, kind: "database_execute", isReadOnly: false },
    principal,
  };
  assert.equal(policy.isToolVisible(executeInput), false);
  assert.match(policy.authorize(executeInput).reason, /disabled for WeCom/);

  for (const deniedPrincipal of [
    { ...principal, chatType: "group" },
    { ...principal, scopes: [] },
    { ...principal, allowedDatabaseProfileIds: [] },
  ]) {
    const deniedPolicy = createBuiltinToolAuthorizationPolicy(deniedPrincipal);
    assert.equal(
      deniedPolicy.authorize({ ...queryInput, principal: deniedPrincipal }).allowed,
      false,
    );
  }
});

test("WeCom ACL independently grants Skill and MCP resources", async () => {
  const principal = await resolvePrincipalContext(
    trustedOrigin({ externalUserId: "alice" }),
    undefined,
    {
      rules: [
        {
          tenantId: "tenant-1",
          botId: "bot-1",
          externalUserId: "alice",
          roles: ["finance-reader"],
          scopes: ["skill:use", "mcp:invoke"],
          allowedSkillNames: ["finance-report"],
          allowedSkillBaseDirs: ["finance-report/"],
          allowedMcpServerIds: ["finance-db"],
        },
      ],
    },
  );

  assert.equal(principal.roles.includes("finance-reader"), true);
  assert.equal(principalCanUseSkill(principal, { name: "finance-report" }), true);
  assert.equal(principalCanUseSkill(principal, { name: "hr-report" }), false);

  const policy = createBuiltinToolAuthorizationPolicy(principal);
  const mcpMetadata = {
    groupId: "mcp",
    kind: "mcp",
    isReadOnly: false,
    displayCategory: "mcp",
  };
  assert.equal(
    policy.authorize({
      toolName: "mcp_finance_db_query",
      metadata: { ...mcpMetadata, resourceId: "finance-db" },
      principal,
    }).allowed,
    true,
  );
  assert.equal(
    policy.authorize({
      toolName: "mcp_hr_db_query",
      metadata: { ...mcpMetadata, resourceId: "hr-db" },
      principal,
    }).allowed,
    false,
  );
});

test("WeCom ACL grants database profiles and fails closed on conflicting default Skills", () => {
  const origin = { tenantId: "tenant-1", botId: "bot-1", externalUserId: "alice" };
  const grant = resolveWeComGrant(origin, {
    rules: [
      {
        ...origin,
        scopes: ["skill:use", "database:read"],
        allowedSkillNames: ["finance-report"],
        defaultSkillName: "finance-report",
        allowedDatabaseProfileIds: ["finance-readonly", "finance-readonly"],
      },
      {
        ...origin,
        scopes: ["skill:use", "database:read"],
        allowedSkillNames: ["hr-report"],
        defaultSkillName: "hr-report",
        allowedDatabaseProfileIds: ["hr-readonly"],
      },
    ],
  });

  assert.equal(grant.defaultSkillName, "");
  assert.deepEqual(grant.allowedDatabaseProfileIds, ["finance-readonly", "hr-readonly"]);
  assert.equal(grant.scopes.includes("database:read"), true);
});

test("WeCom ACL retains a default Skill only when the exact name is allowed", () => {
  const normalized = normalizeWeComAccessPolicy({
    rules: [
      {
        tenantId: "tenant-1",
        botId: "bot-1",
        externalUserId: "alice",
        allowedSkillNames: ["finance-report"],
        defaultSkillName: "Finance-Report",
      },
      {
        tenantId: "tenant-1",
        botId: "bot-1",
        externalUserId: "bob",
        allowedSkillNames: ["finance-report"],
        defaultSkillName: " finance-report ",
      },
    ],
  });

  assert.equal(normalized.rules[0].defaultSkillName, "");
  assert.equal(normalized.rules[1].defaultSkillName, "finance-report");
});

test("malformed or wildcard WeCom ACL rules fail closed", () => {
  const normalized = normalizeWeComAccessPolicy({
    rules: [
      { tenantId: "*", botId: "bot-1", externalUserId: "alice", scopes: ["tool:read"] },
      { tenantId: "tenant-1", botId: "", externalUserId: "alice", scopes: ["tool:read"] },
      {
        tenantId: "tenant-1",
        botId: "bot-1",
        externalUserId: "alice",
        scopes: ["tool:read", "shell:execute"],
      },
    ],
  });
  // A literal asterisk never behaves as a wildcard; unsupported scopes are removed.
  assert.equal(normalized.rules.length, 2);
  assert.deepEqual(normalized.rules[1].scopes, ["tool:read"]);
});
