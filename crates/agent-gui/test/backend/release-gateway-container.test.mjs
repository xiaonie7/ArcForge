import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const guiRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const repoRoot = path.resolve(guiRoot, "../..");

test("gateway container stores durable state in its writable data directory", () => {
  const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

  assert.match(dockerfile, /install -d[^\n]*\/var\/lib\/arcforge/);
  assert.match(
    dockerfile,
    /ARCFORGE_GATEWAY_STATE_DB=\/var\/lib\/arcforge\/gateway-state\.sqlite3/,
  );
});
