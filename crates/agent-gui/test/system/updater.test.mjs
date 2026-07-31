import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const guiRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const repoRoot = path.resolve(guiRoot, "../..");

function cargoLockVersion(packageName) {
  const cargoLock = readFileSync(path.join(repoRoot, "Cargo.lock"), "utf8");
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cargoLock.match(
    new RegExp(`\\[\\[package\\]\\]\\r?\\nname = "${escapedName}"\\r?\\nversion = "([^"]+)"`),
  );
  assert.ok(match, `${packageName} is missing from Cargo.lock`);
  return match[1];
}

function majorMinor(version) {
  return version.replace(/^[^\d]*/, "").split(".").slice(0, 2).join(".");
}

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

test("Tauri updater and process packages use matching JS and Rust minor versions", () => {
  const packageJson = JSON.parse(readFileSync(path.join(guiRoot, "package.json"), "utf8"));
  const plugins = [
    ["@tauri-apps/plugin-process", "tauri-plugin-process"],
    ["@tauri-apps/plugin-updater", "tauri-plugin-updater"],
  ];

  for (const [jsPackage, rustPackage] of plugins) {
    const jsVersion = packageJson.dependencies[jsPackage];
    assert.equal(
      majorMinor(cargoLockVersion(rustPackage)),
      majorMinor(jsVersion),
      `${jsPackage} and ${rustPackage} must use the same major/minor version`,
    );
  }
});
