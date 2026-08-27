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

test("Skill updates use the current entry without auditing old workspace copies", () => {
  const prompt = skills.buildSkillsSystemPrompt({ rootDir: "/skills", selected: enabledSkills });
  assert.match(prompt, /current enabled Skill entry and its referenced files/);
  assert.match(prompt, /After a Skill update, read the current entry/);
  assert.match(prompt, /auditing old workspace copies \(such as run\/\) is not a prerequisite/);
});

test("historical inspection remains available when requested or required by the current Skill", () => {
  const prompt = skills.buildSkillsSystemPrompt({ rootDir: "/skills", selected: enabledSkills });
  assert.match(prompt, /only for explicitly requested work on past runs/);
  assert.match(prompt, /or when the current Skill explicitly requires them/);
  assert.match(prompt, /within current tool permissions/);
  assert.equal(skills.buildSkillsSystemPrompt({ rootDir: "/skills", selected: [] }), "");
});
