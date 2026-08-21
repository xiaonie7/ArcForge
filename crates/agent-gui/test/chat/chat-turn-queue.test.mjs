import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const queue = loader.loadModule("src/pages/chat/queue/chatTurnQueue.ts");
const queueHookSource = readFileSync(
  new URL("../../src/pages/chat/queue/useChatTurnQueue.ts", import.meta.url),
  "utf8",
);

function draft(text, segments = [{ type: "text", text }]) {
  return {
    segments,
    text,
    textWithoutLargePastes: text,
    largePastes: [],
    skillMentions: [],
    commitMentions: [],
    gitFileMentions: [],
    isEmpty: text.trim() === "",
  };
}

function turn(id, conversationId, text) {
  return queue.createQueuedChatTurn({
    id,
    conversationId,
    draft: draft(text),
    uploadedFiles: [],
    executionMode: "tools",
    workdir: "/workspace",
    allowEmptyWorkdir: false,
    selectedSystemToolIds: ["shell"],
    runtimeControls: {
      thinkingEnabled: false,
      reasoning: "off",
      nativeWebSearchEnabled: false,
    },
    createdAt: 1,
  });
}

test("queued chat turns preserve explicit empty-workdir authorization", () => {
  const recent = queue.createQueuedChatTurn({
    ...turn("recent", "conversation-recent", "question"),
    workdir: "   ",
    allowEmptyWorkdir: true,
  });

  assert.equal(recent.workdir, "");
  assert.equal(recent.allowEmptyWorkdir, true);
});

test("trusted queued turns retain deeply frozen permission and principal snapshots", () => {
  const permissionProfile = {
    id: "profile-1",
    name: "WeCom default",
    revision: 3,
    policy: {
      executionMode: "tools",
      allowedSkills: ["review"],
      allowedSystemTools: ["search"],
      allowedMcpServers: ["docs"],
      memoryEnabled: false,
    },
    policyHash: "hash-3",
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
  };
  const principal = {
    principalId: "wecom:principal",
    installationId:
      '{"bot_id":"bot-1","channel":"wecom","connector_id":"connector-1","tenant_id":"tenant-1"}',
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
    authTime: 1,
    requestId: "request-1",
  };
  const queued = queue.createQueuedChatTurn({
    ...turn("trusted", "conversation-a", "question"),
    gatewayRequest: {
      requestId: "request-1",
      workerId: "gateway-chat-runtime-worker-1",
      principal,
      permissionProfile,
    },
  });

  assert.notEqual(queued.gatewayRequest.principal, principal);
  assert.notEqual(queued.gatewayRequest.permissionProfile, permissionProfile);
  assert.notEqual(queued.gatewayRequest.permissionProfile.policy, permissionProfile.policy);
  assert.notEqual(
    queued.gatewayRequest.permissionProfile.policy.allowedSkills,
    permissionProfile.policy.allowedSkills,
  );
  assert.ok(Object.isFrozen(queued.gatewayRequest.principal));
  assert.ok(Object.isFrozen(queued.gatewayRequest.permissionProfile));
  assert.ok(Object.isFrozen(queued.gatewayRequest.permissionProfile.policy));
  assert.ok(Object.isFrozen(queued.gatewayRequest.permissionProfile.policy.allowedSkills));
  assert.equal(queued.gatewayRequest.workerId, "gateway-chat-runtime-worker-1");
  assert.deepEqual(queued.gatewayRequest.permissionProfile.policy, {
    executionMode: "tools",
    workdir: "",
    allowEmptyWorkdir: false,
    allowedSkills: ["review"],
    allowedSystemTools: ["search"],
    allowedMcpServers: ["docs"],
    memoryEnabled: false,
    nativeWebSearchEnabled: false,
    maxDurationSeconds: 3_600,
    maxOutputChars: 1_000_000,
  });
  assert.deepEqual(Object.keys(queued.gatewayRequest.permissionProfile).sort(), [
    "id",
    "policy",
    "policyHash",
    "revision",
  ]);

  permissionProfile.policy.allowedSkills.push("later-change");
  assert.deepEqual(queued.gatewayRequest.permissionProfile.policy.allowedSkills, ["review"]);
});

test("gateway queue fields come from the frozen profile without empty-list fallback", () => {
  assert.match(
    queueHookSource,
    /const trustedPolicy = principal \? permissionProfile\?\.policy : undefined/,
  );
  assert.match(queueHookSource, /principal && !trustedPolicy/);
  assert.match(queueHookSource, /trustedPolicy\s*\? trustedPolicy\.executionMode/);
  assert.match(queueHookSource, /trustedPolicy\s*\? trustedPolicy\.workdir/);
  assert.match(
    queueHookSource,
    /trustedPolicy \? trustedPolicy\.allowEmptyWorkdir : allowEmptyAgentWorkdir/,
  );
  assert.match(queueHookSource, /Array\.isArray\(payload\.selectedSystemTools\)/);
  assert.doesNotMatch(
    queueHookSource,
    /selectedSystemToolIds\.length > 0[\s\S]{0,120}settings\.system\.selectedSystemTools/,
  );
});

test("gateway queued turns retain the runtime worker that owns the native lease", () => {
  assert.match(queueHookSource, /const gatewayWorkerId = workerId\.trim\(\)/);
  assert.match(queueHookSource, /!gatewayWorkerId/);
  assert.match(
    queueHookSource,
    /gatewayRequest:\s*\{[\s\S]{0,500}workerId: gatewayWorkerId/,
  );
});

test("stale remote leases are dropped instead of entering an endless queue retry", () => {
  assert.equal(
    queue.isRemoteChatLeaseInactiveError(
      new Error("remote chat request lease is no longer active"),
    ),
    true,
  );
  assert.equal(queue.isRemoteChatLeaseInactiveError("temporary model failure"), false);
  assert.match(
    queueHookSource,
    /gatewayLeaseInactive = isRemoteChatLeaseInactiveError\(error\)/,
  );
  assert.match(
    queueHookSource,
    /if \(!gatewayLeaseInactive\) \{[\s\S]{0,250}appendQueuedChatTurn\(current, queuedTurn\)/,
  );
});

test("queued chat turns append, promote, remove, and take the next turn", () => {
  const first = turn("a1", "conversation-a", "first");
  const second = turn("a2", "conversation-a", "second");

  const appended = queue.appendQueuedChatTurn(queue.appendQueuedChatTurn([], first), second);
  assert.deepEqual(
    appended.map((item) => item.id),
    ["a1", "a2"],
  );

  const promoted = queue.promoteQueuedChatTurn(appended, "a2");
  assert.deepEqual(
    promoted.map((item) => item.id),
    ["a2", "a1"],
  );

  const taken = queue.takeNextQueuedChatTurn(promoted, "conversation-a");
  assert.equal(taken.item.id, "a2");
  assert.deepEqual(
    taken.queue.map((item) => item.id),
    ["a1"],
  );

  assert.deepEqual(queue.removeQueuedChatTurn(taken.queue, "a1"), []);
});

test("queued chat turn movement stays scoped to the same conversation", () => {
  const mixed = [
    turn("a1", "conversation-a", "a one"),
    turn("b1", "conversation-b", "b one"),
    turn("a2", "conversation-a", "a two"),
  ];

  const moved = queue.moveQueuedChatTurn(mixed, "a2", "up");
  assert.deepEqual(
    moved.map((item) => item.id),
    ["a2", "b1", "a1"],
  );
});

test("edited queued chat turns return to their original priority slot", () => {
  const first = turn("a1", "conversation-a", "first");
  const second = turn("a2", "conversation-a", "second");
  const third = turn("a3", "conversation-a", "third");
  const editedSecond = turn("a2", "conversation-a", "edited second");

  const reinserted = queue.insertQueuedChatTurnAtSlot([first, third], editedSecond, {
    conversationId: "conversation-a",
    previousId: "a1",
    nextId: "a3",
    index: 1,
  });

  assert.deepEqual(
    reinserted.map((item) => item.id),
    ["a1", "a2", "a3"],
  );
  assert.equal(reinserted[1].draft.text, "edited second");
});

test("edited queued chat turns keep their scoped priority when anchors disappear", () => {
  const remaining = turn("a4", "conversation-a", "remaining");
  const editedSecond = turn("a2", "conversation-a", "edited second");

  const reinserted = queue.insertQueuedChatTurnAtSlot([remaining], editedSecond, {
    conversationId: "conversation-a",
    previousId: "missing-previous",
    nextId: null,
    index: 1,
  });

  assert.deepEqual(
    reinserted.map((item) => item.id),
    ["a4", "a2"],
  );
});

test("queued chat turn preview keeps structured draft hints compact", () => {
  const richDraft = draft("hello long paste", [
    { type: "text", text: "hello " },
    {
      type: "largePaste",
      paste: {
        id: "paste-1",
        label: "pasted.txt",
        text: "large paste body",
        charCount: 16,
        lineCount: 1,
        preview: "large paste body",
      },
    },
    {
      type: "skillMention",
      skill: {
        name: "reviewer",
        description: "",
        skillFile: "SKILL.md",
        baseDir: "/skills/reviewer",
      },
    },
  ]);

  assert.equal(queue.buildQueuedChatTurnPreview(richDraft), "hello pasted.txt$reviewer");
  assert.equal(queue.queuedChatTurnHasContent(richDraft, []), true);
  assert.equal(queue.queuedChatTurnHasContent(draft(""), [{ fileName: "a.txt" }]), true);
});

test("trusted channel commands have a queue label without becoming message content", () => {
  assert.equal(queue.buildQueuedGatewayDisplayMessage("", "compact"), "/compact");
  assert.equal(queue.buildQueuedGatewayDisplayMessage("  hello  ", "compact"), "hello");
  assert.equal(queue.buildQueuedGatewayDisplayMessage("", ""), "");
});
