import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  buildChannelInstallationId,
  buildTrustedPrincipalSystemPrompt,
  derivePrincipalConversationId,
  normalizeTrustedChannelOrigin,
  resolvePrincipalContext,
} = loader.loadModule("src/lib/security/principalContext.ts");

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
  const installationId =
    '{"bot_id":"bot-1","channel":"wecom","connector_id":"connector-1","tenant_id":"tenant-1"}';
  assert.equal(first.installationId, installationId);
  assert.equal(
    buildChannelInstallationId({
      botId: " bot-1 ",
      channel: "WECOM",
      connectorId: " connector-1 ",
      tenantId: " tenant-1 ",
    }),
    installationId,
  );
  const gatewayKey = [
    installationId,
    "direct",
    "direct",
    "user-1",
    "session-1",
  ].join("\0");
  assert.equal(
    firstConversationId,
    `wecom:${createHash("sha256").update(`conversation|${gatewayKey}`, "utf8").digest("hex")}`,
  );
  assert.equal(second.channelSessionId, "session-2");
  assert.equal(second.channelCommand, "compact");
});

test("connector identity scopes principals and conversations to one installation", async () => {
  const first = await resolvePrincipalContext(trustedOrigin());
  const second = await resolvePrincipalContext(trustedOrigin({ connectorId: "connector-2" }));

  assert.notEqual(first.installationId, second.installationId);
  assert.notEqual(first.principalId, second.principalId);
  assert.notEqual(
    await derivePrincipalConversationId(first),
    await derivePrincipalConversationId(second),
  );
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
  assert.throws(
    () => normalizeTrustedChannelOrigin(trustedOrigin(), "different-request"),
    /request binding/,
  );
});

test("WeCom principal is authenticated identity metadata, not a permission grant", async () => {
  const principal = await resolvePrincipalContext(trustedOrigin({ externalUserId: "alice" }));

  assert.equal(principal.externalUserId, "alice");
  for (const legacyPermissionField of [
    "policyVersion",
    "roles",
    "scopes",
    "allowedToolNames",
    "allowedSkillNames",
    "allowedSkillBaseDirs",
    "allowedDatabaseProfileIds",
    "allowedMcpServerIds",
    "defaultSkillName",
  ]) {
    assert.equal(Object.hasOwn(principal, legacyPermissionField), false, legacyPermissionField);
  }

  const systemPrompt = buildTrustedPrincipalSystemPrompt(principal);
  assert.match(systemPrompt, /external_user_id=alice/);
  assert.match(systemPrompt, /bot_id=bot-1/);
  assert.match(systemPrompt, /not user message content/);
  assert.match(systemPrompt, /authenticated channel metadata/);
});
