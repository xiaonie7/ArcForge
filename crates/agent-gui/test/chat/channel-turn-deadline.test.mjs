import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { ChannelTurnTimeoutError, createChannelTurnDeadline } = loader.loadModule(
  "src/pages/chat/runtime/channelTurnDeadline.ts",
);

test("channel turn deadline rejects a preflight operation and invokes cancellation", async () => {
  const cancellations = [];
  const deadline = createChannelTurnDeadline({
    maxDurationSeconds: 0.01,
    onTimeout(error) {
      cancellations.push(error);
    },
  });

  await assert.rejects(
    deadline.run(new Promise(() => {})),
    (error) =>
      error instanceof ChannelTurnTimeoutError &&
      error.message === "Channel run timed out after 0.01 seconds",
  );
  assert.equal(deadline.isTimedOut(), true);
  assert.equal(cancellations.length, 1);
  assert.equal(cancellations[0], deadline.error);
  deadline.clear();
});

test("clearing a channel turn deadline prevents later cancellation", async () => {
  let cancellationCount = 0;
  const deadline = createChannelTurnDeadline({
    maxDurationSeconds: 0.01,
    onTimeout() {
      cancellationCount += 1;
    },
  });
  deadline.clear();

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(cancellationCount, 0);
  assert.equal(deadline.isTimedOut(), false);
  assert.equal(await deadline.run(Promise.resolve("completed")), "completed");
});
