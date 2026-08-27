import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const extraction = loader.loadModule("src/lib/memory/prompts/extraction.ts");
const shared = loader.loadModule("src/lib/memory/prompts/shared.ts");
const manager = loader.loadModule("src/lib/memory/prompts/managerTool.ts");
const injection = loader.loadModule("src/lib/memory/prompts/injection.ts");
const {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionInstructionPrompt,
  buildExistingCandidatesBlock,
  buildRecentRejectionsBlock,
  buildAlreadyWrittenBlock,
  buildWorkspaceMutationsBlock,
  buildConversationSummaryBlock,
  buildReviewerModeLines,
} = extraction;

test("system prompt forbids mutations and requires exactly one submission", () => {
  assert.ok(EXTRACTION_SYSTEM_PROMPT.includes("read-only"));
  assert.ok(EXTRACTION_SYSTEM_PROMPT.includes("SubmitMemoryPlan exactly once"));
});

test("instruction prompt contains the load-bearing sections", () => {
  const prompt = buildExtractionInstructionPrompt({
    localDate: "2026-07-04",
    workdir: "/Users/dev/project",
  });
  assert.ok(prompt.includes("Project-scope gate"));
  assert.ok(prompt.includes("<workspace-mutations-this-turn>"));
  assert.ok(prompt.includes("Classification decision tree"));
  assert.ok(prompt.includes("append_daily"));
  assert.ok(prompt.includes("2026-07-04"));
  // conflict arbitration appears exactly once (single-source regression)
  assert.equal(prompt.match(/Conflict resolution \(in order\)/g)?.length, 1);
});

test("no workdir → project scope is closed off", () => {
  const prompt = buildExtractionInstructionPrompt({ localDate: "2026-07-04" });
  assert.ok(prompt.includes('Do not use scope="project"'));
});

test("no hardcoded status sentinels anywhere in the prompts", () => {
  const prompt = buildExtractionInstructionPrompt({
    localDate: "2026-07-04",
    workdir: "/w",
  });
  for (const text of [prompt, EXTRACTION_SYSTEM_PROMPT]) {
    assert.ok(!text.includes("记忆整理完成"));
    assert.ok(!text.includes("本轮无需更新记忆"));
  }
});

test("reviewer modes differ and embed into the prompt", () => {
  const strict = buildReviewerModeLines("strict");
  const lenient = buildReviewerModeLines("lenient");
  assert.ok(strict.includes("STRICT"));
  assert.ok(lenient.includes("LENIENT"));
  assert.notEqual(strict, lenient);
  const prompt = buildExtractionInstructionPrompt({
    localDate: "2026-07-04",
    reviewerMode: "strict",
  });
  assert.ok(prompt.includes("Extraction mode: STRICT."));
  const defaulted = buildExtractionInstructionPrompt({ localDate: "2026-07-04" });
  assert.ok(defaulted.includes("Extraction mode: STANDARD."));
});

test("context blocks render entries and (none) fallbacks", () => {
  assert.ok(buildExistingCandidatesBlock([]).includes("- (none)"));
  const candidates = buildExistingCandidatesBlock(
    [
      {
        slug: "user-editor",
        memoryType: "user",
        scope: "global",
        description: "编辑器偏好",
        unreviewed: true,
        confidence: "medium",
        updatedAt: Date.now() - 86_400_000,
      },
    ],
    Date.now(),
  );
  assert.ok(candidates.includes("user-editor"));
  assert.ok(candidates.includes("unreviewed"));
  assert.ok(candidates.includes("1d ago"));

  const rejections = buildRecentRejectionsBlock([
    { slug: "user-noise", rejectedAt: Date.now(), reason: 'said "别记这个"' },
  ]);
  assert.ok(rejections.includes("user-noise"));
  assert.ok(rejections.includes("别记这个"));

  assert.ok(buildAlreadyWrittenBlock(["a-slug"]).includes("- a-slug"));
  assert.ok(buildWorkspaceMutationsBlock([]).includes("- (none)"));
  assert.ok(buildWorkspaceMutationsBlock(["Edit src/a.ts"]).includes("- Edit src/a.ts"));
  assert.equal(buildConversationSummaryBlock(undefined), null);
  assert.ok(buildConversationSummaryBlock("earlier summary").includes("earlier summary"));
});

test("shared policy constants stay single-sourced and contract-aligned", () => {
  assert.ok(shared.MEMORY_CONFIDENCE_CONTRACT_LINE.includes(">=5 characters"));
  assert.ok(shared.PROJECT_MEMORY_WRITE_EVIDENCE_GATE.includes("HARD precondition"));
  assert.ok(shared.MEMORY_SKIP_LIST_ITEMS.some((item) => item.includes("secrets, credentials")));
  assert.ok(
    shared.MEMORY_SKIP_LIST_ITEMS.some((item) => item.includes("one-off Skill execution artifacts")),
  );
});

test("all extraction modes reject transient Skill recipes before classifying durable memory", () => {
  for (const reviewerMode of ["strict", "standard", "lenient"]) {
    const prompt = buildExtractionInstructionPrompt({
      localDate: "2026-08-27",
      workdir: "/w",
      reviewerMode,
    });
    const policy = shared.MEMORY_TRANSIENT_EXECUTION_POLICY;
    assert.equal(prompt.split(policy).length - 1, 1);
    assert.ok(prompt.indexOf(policy) < prompt.indexOf("Classification decision tree"));
    assert.match(prompt, /A successful workspace write or workaround alone does not make them reusable/);
    assert.match(prompt, /Save an explicitly stated stable workflow preference/);
    assert.match(prompt, /record the outcome, not a reusable invocation recipe/);
    assert.ok(prompt.includes('Workflow corrections ("以后跑测试前先 lint")'));
  }
});

test("visible memory writes and hidden extraction share the transient execution rule", () => {
  for (const text of [
    manager.MEMORY_MANAGER_TOOL_DESCRIPTION,
    injection.buildMemoryToolsSuffixSection(),
  ]) {
    assert.equal(text.split(shared.MEMORY_TRANSIENT_EXECUTION_POLICY).length - 1, 1);
    assert.match(text, /one-off copied\/generated runners/);
    assert.match(text, /cached scope\/authorization results/);
  }
});

test("memory authority and operational drift boundaries reach the extraction prompt once", () => {
  const prompt = buildExtractionInstructionPrompt({
    localDate: "2026-08-27",
    workdir: "/w",
  });
  for (const policy of [
    shared.MEMORY_AUTHORITY_BOUNDARY_POLICY,
    shared.MEMORY_OPERATIONAL_DRIFT_POLICY,
  ]) {
    assert.equal(prompt.split(policy).length - 1, 1);
  }
  assert.ok(
    prompt.includes("Current user statements and corrections win over remembered facts/preferences"),
  );
  assert.ok(!prompt.includes("Current user message wins over all memory"));
});

test("shared precedence is limited to memory and cannot grant tool or Skill permissions", () => {
  assert.ok(!shared.MEMORY_PRECEDENCE_CHAIN.includes("current user message >"));
  assert.match(shared.MEMORY_AUTHORITY_BOUNDARY_POLICY, /not commands or authorization/);
  assert.match(shared.MEMORY_AUTHORITY_BOUNDARY_POLICY, /not an instruction hierarchy/);
  assert.match(
    shared.MEMORY_AUTHORITY_BOUNDARY_POLICY,
    /cannot override current system\/developer instructions, tool permissions/,
  );
  assert.match(
    shared.MEMORY_AUTHORITY_BOUNDARY_POLICY,
    /Skill's current execution and safety rules/,
  );
});
