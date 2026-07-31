import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function withWindow(value, task) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value,
  });
  try {
    return task();
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "window", previous);
    } else {
      delete globalThis.window;
    }
  }
}

test("updater runtime detection only enables native Tauri windows", () => {
  const loader = createTsModuleLoader();
  const { isTauriRuntime } = loader.loadModule("src/lib/updater.ts");

  assert.equal(withWindow({}, () => isTauriRuntime()), false);
  assert.equal(withWindow({ __TAURI_INTERNALS__: {} }, () => isTauriRuntime()), true);
  assert.equal(withWindow({ __TAURI__: {} }, () => isTauriRuntime()), true);
});

test("updater errors retain actionable messages", () => {
  const loader = createTsModuleLoader();
  const { formatUpdaterError } = loader.loadModule("src/lib/updater.ts");

  assert.equal(
    formatUpdaterError(new Error("signature verification failed")),
    "signature verification failed",
  );
  assert.equal(formatUpdaterError("network unavailable"), "network unavailable");
  assert.equal(formatUpdaterError(null), "Unknown updater error");
});
