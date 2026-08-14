import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const hostSource = read("../../src/components/cron/AutomationRunToastHost.tsx");
const appSource = read("../../src/App.tsx");
const guiTypesSource = read("../../src/lib/automation/types.ts");
const gatewayTypesSource = read("../../../agent-gateway/web/src/lib/automation/types.ts");
const guiRunViewSource = read("../../src/pages/settings/CronTaskViewModal.tsx");
const gatewayRunViewSource = read(
  "../../../agent-gateway/web/src/pages/settings/CronTaskViewModal.tsx",
);
const i18nSource = read("../../src/i18n/config.ts");

test("desktop listens for final automation run notices at the app root", () => {
  assert.match(hostSource, /automation:run-completed/);
  assert.match(hostSource, /listen<CronRunCompletedEvent>/);
  assert.match(appSource, /<AutomationRunToastHost \/>/);
});

test("run contracts expose delivery state in desktop and gateway clients", () => {
  for (const source of [guiTypesSource, gatewayTypesSource]) {
    assert.match(source, /type DeliveryStatus = "pending" \| "sent" \| "skipped" \| "failed"/);
    assert.match(source, /deliveryStatus\?: DeliveryStatus/);
    assert.match(source, /deliveryError\?: string/);
  }
  for (const source of [guiRunViewSource, gatewayRunViewSource]) {
    assert.match(source, /log\.deliveryStatus/);
    assert.match(source, /log\.deliveryError/);
    assert.match(source, /settings\.cronViewDelivery/);
  }
});

test("run notices distinguish execution and delivery failures in both locales", () => {
  assert.match(hostSource, /item\.deliveryStatus === "failed"/);
  for (const key of [
    "automation.runNoticeSuccess",
    "automation.runNoticeFailure",
    "automation.runNoticeDeliverySent",
    "automation.runNoticeDeliveryFailed",
  ]) {
    assert.equal(i18nSource.split(`"${key}"`).length - 1, 2);
  }
});
