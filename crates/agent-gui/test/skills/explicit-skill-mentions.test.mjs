import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const skills = loader.loadModule("src/lib/skills/index.ts");

const enabledSkills = [
  {
    name: "code-review",
    description: "Review local code changes",
    skillFile: "code-review/SKILL.md",
    baseDir: "code-review",
  },
  {
    name: "release_notes",
    description: "Prepare release notes",
    skillFile: "release_notes/SKILL.md",
    baseDir: "release_notes",
  },
];

test("extractSkillMentionNamesFromText finds explicit skill tokens without treating common env vars as skills", () => {
  assert.deepEqual(
    skills.extractSkillMentionNamesFromText(
      "Use /code-review and /release_notes, keep /usr/bin literal and ignore price/tags.",
    ),
    ["code-review", "release_notes"],
  );
  assert.deepEqual(skills.extractSkillMentionNamesFromText("/arcforge-code-review"), [
    "arcforge-code-review",
  ]);
  // "$" is no longer a skill mention marker.
  assert.deepEqual(
    skills.extractSkillMentionNamesFromText("Use $code-review and $release_notes."),
    [],
  );
});

test("resolveExplicitSkillMentions only returns enabled skills and deduplicates structured/text mentions", () => {
  assert.deepEqual(
    skills.resolveExplicitSkillMentions({
      text: "/disabled /release_notes /code-review /code-review",
      structured: [
        {
          name: "code-review",
          skillFile: "code-review/SKILL.md",
          baseDir: "code-review",
        },
      ],
      enabledSkills,
    }),
    [enabledSkills[0], enabledSkills[1]],
  );
});

test("buildSkillsSystemPrompt marks explicit mentions without granting disabled skills", () => {
  const prompt = skills.buildSkillsSystemPrompt({
    rootDir: "/skills",
    selected: enabledSkills,
    explicit: [
      enabledSkills[0],
      {
        name: "disabled",
        description: "Should not be available",
        skillFile: "disabled/SKILL.md",
        baseDir: "disabled",
      },
    ],
  });

  assert.match(prompt, /Explicitly mentioned this turn:/);
  assert.match(prompt, /- code-review \(skillFile: code-review\/SKILL\.md, baseDir: code-review\)/);
  assert.doesNotMatch(prompt, /disabled\/SKILL\.md/);
  assert.ok(prompt.includes("`/` mentions never grant access to disabled Skills"));
  assert.match(prompt, /skill:\/\/<baseDir>\/\.\.\./);
  assert.doesNotMatch(prompt, /root=["']skills["']/);
  assert.doesNotMatch(prompt, /Read\(root=/);
});

test("trusted channel Skill routing prefers an explicit allowed mention over the ACL default", () => {
  const resolution = skills.resolveAuthorizedSkillRoute({
    text: "/code-review check this change",
    defaultSkillName: "release_notes",
    installedSkills: enabledSkills,
    principal: {
      scopes: ["skill:use"],
      allowedSkillNames: ["code-review", "release_notes"],
      allowedSkillBaseDirs: [],
    },
  });

  assert.equal(resolution.kind, "matched");
  assert.equal(resolution.source, "explicit");
  assert.equal(resolution.skill, enabledSkills[0]);
});

test("an explicit denied Skill never falls back to the allowed default", () => {
  const resolution = skills.resolveAuthorizedSkillRoute({
    text: "/code-review check this change",
    defaultSkillName: "release_notes",
    installedSkills: enabledSkills,
    principal: {
      scopes: ["skill:use"],
      allowedSkillNames: ["release_notes"],
      allowedSkillBaseDirs: [],
    },
  });

  assert.deepEqual(resolution, {
    kind: "denied",
    source: "explicit",
    requestedName: "code-review",
  });
});

test("trusted channel Skill routing accepts an ACL base-directory grant", () => {
  const resolution = skills.resolveAuthorizedSkillRoute({
    text: "prepare the report",
    defaultSkillName: "release_notes",
    installedSkills: enabledSkills,
    principal: {
      scopes: ["skill:use"],
      allowedSkillNames: [],
      allowedSkillBaseDirs: ["release_notes/"],
    },
  });

  assert.equal(resolution.kind, "matched");
  assert.equal(resolution.source, "default");
  assert.equal(resolution.skill, enabledSkills[1]);
});

test("routed Skill entry preloading reads every chunk and uses a non-progressive prompt", async () => {
  const reads = [];
  const routedLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          assert.equal(command, "system_read_skill_text");
          reads.push(args);
          if (args.offset === 0) return { content: "first\nsecond\n", truncated: true };
          return { content: "third", truncated: false };
        },
      },
    },
  });
  const routedSkills = routedLoader.loadModule("src/lib/skills/index.ts");
  const content = await routedSkills.readCompleteSkillText("code-review/SKILL.md");
  const prompt = routedSkills.buildPreloadedRoutedSkillSystemPrompt({
    skill: enabledSkills[0],
    content,
  });

  assert.equal(content, "first\nsecond\nthird");
  assert.deepEqual(
    reads.map(({ path, offset, length }) => ({ path, offset, length })),
    [
      { path: "code-review/SKILL.md", offset: 0, length: 10_000 },
      { path: "code-review/SKILL.md", offset: 2, length: 10_000 },
    ],
  );
  assert.match(prompt, /first\nsecond\nthird/);
  assert.match(prompt, /Do not search a workspace/);
  assert.match(prompt, /Do not call SkillsManager/);
  assert.doesNotMatch(prompt, /SkillsManager\(action=read\)/);
});
