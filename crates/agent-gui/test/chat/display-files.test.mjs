import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const displayFiles = loader.loadModule("src/lib/chat/messages/displayFiles.ts");

function toolItem(details, { isError = false, settled = true } = {}) {
  return {
    toolCall: {
      type: "toolCall",
      id: "present-file-1",
      name: "PresentFile",
      arguments: { path: "reports/usage.xlsx" },
    },
    toolResult: settled
      ? {
          role: "toolResult",
          toolCallId: "present-file-1",
          toolName: "PresentFile",
          content: [],
          details,
          isError,
          timestamp: 1,
        }
      : undefined,
  };
}

test("display-file details become native generated-file entries", () => {
  const file = {
    path: "reports/usage.xlsx",
    relativePath: "reports/usage.xlsx",
    fileName: "usage.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    previewKind: "spreadsheet",
    sizeBytes: 23_456,
    mtimeMs: 1_700_000_000_000,
    fileId: "file-1",
    previewSupported: true,
  };

  assert.deepEqual(
    displayFiles.getDisplayFilesFromToolTrace(
      toolItem({ kind: "display_file", files: [file] }),
    ),
    [file],
  );
});

test("failed, unsettled, wrong-kind, and malformed results do not render file cards", () => {
  assert.equal(
    displayFiles.getDisplayFilesFromToolTrace(
      toolItem({ kind: "display_file", files: [] }, { isError: true }),
    ),
    null,
  );
  assert.equal(
    displayFiles.getDisplayFilesFromToolTrace(
      toolItem({ kind: "display_file", files: [] }, { settled: false }),
    ),
    null,
  );
  assert.equal(
    displayFiles.getDisplayFilesFromToolTrace(toolItem({ kind: "write", files: [] })),
    null,
  );
  assert.equal(
    displayFiles.getDisplayFilesFromToolTrace(
      toolItem({
        kind: "display_file",
        files: [{ path: "usage.xlsx", fileName: "usage.xlsx" }],
      }),
    ),
    null,
  );
});
