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

test("display files deduplicate by path and prefer the newest artifact revision", () => {
  const file = (version) => ({
    path: "reports/usage.xlsx",
    relativePath: "reports/usage.xlsx",
    fileName: "usage.xlsx",
    sizeBytes: 23_456,
    mtimeMs: 1_700_000_000_000,
    previewSupported: true,
    ...(version === undefined
      ? {}
      : {
          artifact: {
            artifactId: "artifact-1",
            artifactKind: "document",
            documentType: "spreadsheet",
            outputPath: "reports/usage.xlsx",
            currentVersion: version,
            createdAt: "2026-08-27T00:00:00.000Z",
            updatedAt: "2026-08-27T00:00:00.000Z",
            format: "xlsx",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            action: "patch",
            provider: "arcforge",
            sizeBytes: 23_456,
            sha256: `hash-${version}`,
            previewCount: 0,
            validationCount: 0,
            artifactRole: "primary",
          },
        }),
  });
  const item = (id, name, details) => ({
    toolCall: { type: "toolCall", id, name, arguments: {} },
    toolResult: {
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [],
      details: { kind: "display_file", files: [details] },
      isError: false,
      timestamp: 1,
    },
  });
  const explicit = item("present", "PresentFile", file());
  const older = item("office-1", "OfficeRuntime", file(1));
  const newer = item("office-2", "OfficeRuntime", file(2));

  const deduped = displayFiles.dedupeDisplayFilesByToolTrace([explicit, newer, older]);
  assert.deepEqual(deduped.get(explicit), []);
  assert.deepEqual(deduped.get(older), []);
  assert.equal(deduped.get(newer)[0].artifact.currentVersion, 2);
});

test("preview artifacts rank by their source revision", () => {
  const makeItem = (id, sourceVersion) => ({
    toolCall: { type: "toolCall", id, name: "OfficeRuntime", arguments: {} },
    toolResult: {
      role: "toolResult",
      toolCallId: id,
      toolName: "OfficeRuntime",
      content: [],
      isError: false,
      timestamp: sourceVersion,
      details: {
        kind: "display_file",
        files: [
          {
            path: "report.png",
            relativePath: "report.png",
            fileName: "report.png",
            sizeBytes: 1,
            mtimeMs: 1,
            previewSupported: true,
            artifact: {
              artifactId: "artifact-1",
              currentVersion: 5,
              sourceVersion,
              artifactRole: "preview",
            },
          },
        ],
      },
    },
  });
  const v4 = makeItem("render-4", 4);
  const v3 = makeItem("render-3", 3);
  const deduped = displayFiles.dedupeDisplayFilesByToolTrace([v4, v3]);

  assert.equal(deduped.get(v4)[0].artifact.sourceVersion, 4);
  assert.deepEqual(deduped.get(v3), []);
});
