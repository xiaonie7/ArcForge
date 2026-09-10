import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const artifact = { artifactType: "pptx", workdir: "E:/work", path: "deck/deck.pptx" };
const selection = {
  artifact,
  selection: { type: "element", id: "title-1", unitId: "p-05", unitLabel: "Slide 5", elementType: "title" },
};
const draft = {
  segments: [{ type: "text", text: "Shorten this title" }],
  text: "Shorten this title",
  textWithoutLargePastes: "Shorten this title",
  largePastes: [],
  skillMentions: [{ name: "presentations", skillFile: "skills/presentations/SKILL.md" }],
  commitMentions: [],
  gitFileMentions: [],
  codeMentions: [],
  isEmpty: false,
};

function allNodes(node) {
  if (!node || typeof node !== "object") return [];
  const children = [node.props?.children].flat(Infinity);
  return [node, ...children.flatMap(allNodes)];
}

function harness(overrides = {}) {
  let cursor = 0;
  const slots = [];
  const cleanups = [];
  const react = {
    useRef(value) {
      const index = cursor++;
      return slots[index] ??= { current: value };
    },
    useState(value) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = value;
      return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
    },
    useEffect(effect) {
      const index = cursor++;
      if (!(index in slots)) {
        slots[index] = true;
        cleanups.push(effect());
      }
    },
    useCallback(callback) { return callback; },
  };
  const loader = createTsModuleLoader({
    mocks: {
      react,
      "../../i18n": { useLocale: () => ({ locale: "en-US" }) },
      "../chat/MentionComposer": { MentionComposer: "MentionComposer" },
      "../../pages/chat/transcript/ChatTranscript": { ChatTranscript: "ChatTranscript" },
    },
  });
  const { ReviewChatPanel } = loader.loadModule("src/components/artifact-review/ReviewChatPanel.tsx");
  const history = [{ key: "review-only-history" }];
  const props = {
    threadId: "review-thread",
    artifact,
    selection,
    runtime: { state: { historyRenderItems: history }, isSending: false, compactionStatus: { phase: "idle" } },
    liveTranscriptStore: { reviewOnly: true },
    hasModels: true,
    isAgentMode: true,
    onSend: async () => true,
    onStop() {},
    onOpenSettings() {},
    ...overrides,
  };
  let tree;
  const editor = {
    clearCount: 0,
    getDraft: () => draft,
    clear() { editor.clearCount++; },
  };
  function render() {
    cursor = 0;
    tree = ReviewChatPanel(props);
    const composer = allNodes(tree).find((node) => node.type === "MentionComposer");
    composer.props.ref.current = editor;
    return tree;
  }
  function find(type, predicate = () => true) {
    return allNodes(tree).find((node) => node.type === type && predicate(node.props));
  }
  render();
  find("MentionComposer").props.onEmptyChange(false);
  render();
  return {
    props, editor, render, find,
    unmount: () => cleanups.forEach((cleanup) => cleanup?.()),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("review sends its own structured draft and keeps the selected context after success", async () => {
  const sent = [];
  const panel = harness({ onSend: async (value) => { sent.push(value); return true; } });
  const transcript = panel.find("ChatTranscript");
  assert.equal(transcript.props.conversationId, "review-thread");
  assert.equal(transcript.props.historyItems, panel.props.runtime.state.historyRenderItems);
  assert.equal(transcript.props.liveTranscriptStore, panel.props.liveTranscriptStore);
  assert.equal(transcript.props.compact, true);
  panel.find("MentionComposer").props.onSend();
  await flush();
  assert.deepEqual(sent, [draft]);
  assert.equal(panel.editor.clearCount, 1);
  panel.render();
  assert.ok(panel.find("p", (props) => props.children === "deck.pptx › Slide 5 › title title-1"));
  assert.equal(panel.find("button", (props) => props.children === "Send").props.disabled, true);
});

test("review prevents duplicate submission before React receives the running state", async () => {
  let finish;
  let calls = 0;
  const panel = harness({ onSend: () => { calls++; return new Promise((resolve) => { finish = resolve; }); } });
  const send = panel.find("MentionComposer").props.onSend;
  send();
  send();
  assert.equal(calls, 1);
  assert.equal(panel.editor.clearCount, 0);
  panel.render();
  assert.equal(panel.find("MentionComposer").props.disabled, true);
  finish(true);
  await flush();
  assert.equal(panel.editor.clearCount, 1);
});

test("failed or rejected review sends preserve the draft and restore editing", async () => {
  const panel = harness({ onSend: async () => false });
  panel.find("MentionComposer").props.onSend();
  await flush();
  panel.render();
  assert.equal(panel.editor.clearCount, 0);
  assert.equal(panel.find("MentionComposer").props.disabled, false);
  panel.props.onSend = async () => { throw new Error("Review connection failed"); };
  panel.render();
  panel.find("MentionComposer").props.onSend();
  await flush();
  panel.render();
  assert.equal(panel.editor.clearCount, 0);
  assert.ok(panel.find("p", (props) => props.children === "Review connection failed"));
});

test("switching selections preserves the draft and stopping targets the review callback", () => {
  let stopped = 0;
  const panel = harness({ onStop: () => { stopped++; } });
  panel.props.selection = { artifact, selection: { type: "slide", id: "p-06", label: "Slide 6" } };
  panel.props.runtime = { ...panel.props.runtime, isSending: true };
  panel.render();
  assert.equal(panel.editor.clearCount, 0);
  assert.equal(panel.find("MentionComposer").props.disabled, true);
  assert.ok(panel.find("p", (props) => props.children === "deck.pptx › Slide 6"));
  panel.find("button", (props) => props.children === "Stop").props.onClick();
  assert.equal(stopped, 1);
});

test("a send completing after the review panel closes cannot clear another editor", async () => {
  let finish;
  const panel = harness({ onSend: () => new Promise((resolve) => { finish = resolve; }) });
  panel.find("MentionComposer").props.onSend();
  panel.unmount();
  finish(true);
  await flush();
  assert.equal(panel.editor.clearCount, 0);
});

test("unready reviews cannot send and expose loading or retry controls", async () => {
  let calls = 0;
  const panel = harness({ threadId: null, runtime: null, loading: true, onSend: async () => { calls++; return true; } });
  assert.equal(panel.find("MentionComposer").props.disabled, true);
  panel.find("MentionComposer").props.onSend();
  await flush();
  assert.equal(calls, 0);
  assert.ok(panel.find("p", (props) => props.children === "Opening review chat…"));
  let retries = 0;
  panel.props.loading = false;
  panel.props.errorMessage = "Could not open review";
  panel.props.onRetry = () => { retries++; };
  panel.render();
  panel.find("button", (props) => props.children === "Retry").props.onClick();
  assert.equal(retries, 1);
});
