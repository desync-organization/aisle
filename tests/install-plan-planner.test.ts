import { describe, expect, it } from "vitest";

import {
  InstallPlanError,
  MAX_SKILLS_PER_PLAN,
  MAX_SOURCES_PER_PLAN,
  createInstallPlan,
  type InstallPlanErrorCode,
  type InstallPlanOptions,
  type ResolvedGithubSkill,
  type SupportedAgent,
} from "@/lib/install-plan";
import {
  auditedPublicScopeFixtures,
  installPlanFixture,
  installSkillFixture,
} from "./install-plan-fixtures";

function expectPlanError(input: unknown, code: InstallPlanErrorCode): void {
  try {
    createInstallPlan(input);
    throw new Error("Expected createInstallPlan to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(InstallPlanError);
    expect((error as InstallPlanError).code).toBe(code);
  }
}

describe("install plan resolution", () => {
  it("groups one exact discovery scope into one argv-first step and sorts skills and agents", () => {
    const plan = createInstallPlan(
      installPlanFixture(
        [
          installSkillFixture({ name: "beta", repository: "FrontEnd" }),
          installSkillFixture({ name: "alpha", repository: "FrontEnd" }),
        ],
        { agents: ["codex", "claude-code"] },
      ),
    );

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      id: "step-01",
      source: "fixture-owner/frontend",
      sourceUrl: "https://github.com/fixture-owner/frontend/tree/main/skills",
      discoveryScope: {
        branch: "main",
        path: "skills",
        branchHeadSha: "a".repeat(40),
      },
      file: "npx",
      args: [
        "--yes",
        "skills@1.5.19",
        "add",
        "https://github.com/fixture-owner/frontend/tree/main/skills",
        "--full-depth",
        "--skill",
        "alpha",
        "--skill",
        "beta",
        "--agent",
        "claude-code",
        "--agent",
        "codex",
        "--copy",
        "--yes",
      ],
    });
    expect(plan.steps[0]?.selections.map((selection) => selection.name)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("keeps different branch/path scopes in one repository in separate processes", () => {
    const plan = createInstallPlan(
      installPlanFixture([
        installSkillFixture({ name: "claude-skill", discoveryPath: ".claude/skills" }),
        installSkillFixture({ name: "agent-skill", discoveryPath: ".agents/skills" }),
      ]),
    );

    expect(plan.steps.map((step) => step.sourceUrl)).toEqual([
      "https://github.com/fixture-owner/fixture-repository/tree/main/.agents/skills",
      "https://github.com/fixture-owner/fixture-repository/tree/main/.claude/skills",
    ]);
    expect(plan.steps.every((step) => step.selections.length === 1)).toBe(true);
  });

  it("renders the audited Freshtech, Azure, and Impeccable branch/path scopes", () => {
    const plan = createInstallPlan(
      installPlanFixture(Object.values(auditedPublicScopeFixtures)),
    );

    expect(plan.steps.map((step) => step.sourceUrl)).toEqual([
      "https://github.com/freshtechbro/claudedesignskills/tree/main/.claude/skills",
      "https://github.com/microsoft/azure-skills/tree/main/skills",
      "https://github.com/pbakaus/impeccable/tree/main/.agents/skills/impeccable",
    ]);
  });

  it("forces full-depth discovery on every CLI process", () => {
    const plan = createInstallPlan(
      installPlanFixture([
        installSkillFixture({ name: "one", repository: "first" }),
        installSkillFixture({ name: "two", repository: "second" }),
      ]),
    );

    expect(plan.steps).toHaveLength(2);
    for (const step of plan.steps) {
      expect(step.args.filter((argument) => argument === "--full-depth")).toHaveLength(1);
    }
  });

  it("groups and orders mixed repositories deterministically", () => {
    const left = installSkillFixture({ name: "lint", owner: "ZedOrg", repository: "Tools" });
    const right = installSkillFixture({ name: "deploy", owner: "AlphaOrg", repository: "Cloud" });

    const first = createInstallPlan(
      installPlanFixture([left, right], { agents: ["cursor", "codex"] }),
    );
    const second = createInstallPlan(
      installPlanFixture([right, left], { agents: ["codex", "cursor"] }),
    );

    expect(first).toEqual(second);
    expect(first.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.steps.map((step) => step.source)).toEqual([
      "alphaorg/cloud",
      "zedorg/tools",
    ]);
  });

  it("uses explicit global/copy flags and the CLI defaults for project/symlink", () => {
    const globalCopy = createInstallPlan(
      installPlanFixture(undefined, { scope: "global", mode: "copy" }),
    );
    expect(globalCopy.steps[0]?.args).toContain("--global");
    expect(globalCopy.steps[0]?.args).toContain("--copy");

    const projectSymlink = createInstallPlan(
      installPlanFixture(undefined, { scope: "project", mode: "symlink" }),
    );
    expect(projectSymlink.steps[0]?.args).not.toContain("--global");
    expect(projectSymlink.steps[0]?.args).not.toContain("--copy");
    expect(projectSymlink.steps[0]?.args).not.toContain("--symlink");
    expect(projectSymlink.options).toMatchObject({ scope: "project", mode: "symlink" });
  });

  it.each<
    [string, Parameters<typeof installSkillFixture>[0], InstallPlanErrorCode]
  >([
    ["non-public", { publication: "private" }, "NOT_PUBLIC"],
    ["withdrawn", { availability: "withdrawn" }, "NOT_CURRENT"],
    ["blocked", { blocked: true }, "BLOCKED"],
    ["quarantined", { quarantined: true }, "QUARANTINED"],
    ["unvalidated", { validation: "pending" }, "VALIDATION_REQUIRED"],
    ["unlicensed", { licenseStatus: "missing", licenseExpression: null }, "UNLICENSED"],
  ])("rejects %s revisions", (_label, overrides, code) => {
    expectPlanError(installPlanFixture([installSkillFixture(overrides)]), code);
  });

  it("rejects agents outside a revision's compatibility evidence", () => {
    expectPlanError(
      installPlanFixture(
        [installSkillFixture({ compatibleAgents: ["codex"] })],
        { agents: ["cursor"] },
      ),
      "INCOMPATIBLE_AGENT",
    );
  });

  it("rejects global scope for agents without a global skills directory", () => {
    expectPlanError(
      installPlanFixture(
        [installSkillFixture({ compatibleAgents: ["eve"] })],
        { agents: ["eve"], scope: "global" },
      ),
      "UNSUPPORTED_GLOBAL_SCOPE",
    );
  });

  it("rejects an upstream duplicate name even when only one catalog row is selected", () => {
    expectPlanError(
      installPlanFixture([
        installSkillFixture({
          selectorVerifiedUnique: false,
        }),
      ]),
      "SELECTOR_NOT_UNIQUE",
    );
  });

  it.each([
    installSkillFixture({ selector: "other-selector" }),
  ])("rejects selector evidence not tied to the selected name", (selection) => {
    expectPlanError(installPlanFixture([selection]), "SELECTOR_EVIDENCE_MISMATCH");
  });

  it.each([
    installSkillFixture({
      branchHeadSha: "a".repeat(40),
      commitSha: "c".repeat(40),
    }),
    installSkillFixture({ selectorVerifiedBranch: "release" }),
    installSkillFixture({ selectorVerifiedDiscoveryPath: ".claude/skills" }),
    installSkillFixture({ selectorVerifiedBranchHeadSha: "c".repeat(40) }),
  ])("rejects discovery evidence not bound to the observed exact scope", (selection) => {
    expectPlanError(
      installPlanFixture([selection]),
      "DISCOVERY_SCOPE_EVIDENCE_MISMATCH",
    );
  });

  it("rejects conflicting branch-head observations for one scope", () => {
    expectPlanError(
      installPlanFixture([
        installSkillFixture({ name: "one", branchHeadSha: "a".repeat(40) }),
        installSkillFixture({ name: "two", branchHeadSha: "c".repeat(40) }),
      ]),
      "DISCOVERY_SCOPE_EVIDENCE_MISMATCH",
    );
  });

  it("rejects duplicate revisions and canonical revision conflicts", () => {
    const duplicate = installSkillFixture();
    expectPlanError(installPlanFixture([duplicate, duplicate]), "DUPLICATE_SELECTION");

    expectPlanError(
      installPlanFixture([
        installSkillFixture({ name: "first", canonicalSkillId: "skill:shared", revisionId: "rev:1" }),
        installSkillFixture({ name: "second", canonicalSkillId: "skill:shared", revisionId: "rev:2" }),
      ]),
      "CONFLICTING_REVISION",
    );
  });

  it("rejects normalized-name conflicts across repositories", () => {
    expectPlanError(
      installPlanFixture([
        installSkillFixture({ name: "shared", repository: "one" }),
        installSkillFixture({ name: "shared", repository: "two" }),
      ]),
      "NORMALIZED_NAME_CONFLICT",
    );
  });

  it("rejects empty, excessive-selection, and excessive-source plans", () => {
    expectPlanError(installPlanFixture([]), "EMPTY_SELECTION");

    const tooManySkills = Array.from({ length: MAX_SKILLS_PER_PLAN + 1 }, (_, index) =>
      installSkillFixture({ name: `skill-${index}` }),
    );
    expectPlanError(installPlanFixture(tooManySkills), "SELECTION_LIMIT_EXCEEDED");

    const tooManySources = Array.from({ length: MAX_SOURCES_PER_PLAN + 1 }, (_, index) =>
      installSkillFixture({ name: `skill-${index}`, repository: `repo-${index}` }),
    );
    expectPlanError(installPlanFixture(tooManySources), "SOURCE_LIMIT_EXCEEDED");
  });

  it("rejects plans that exceed the conservative pasteable-command cap", () => {
    const agents: SupportedAgent[] = [
      "antigravity-cli",
      "autohand-code",
      "claude-code",
      "codearts-agent",
      "command-code",
      "github-copilot",
      "hermes-agent",
      "mistral-vibe",
    ];
    const selections: ResolvedGithubSkill[] = Array.from(
      { length: MAX_SKILLS_PER_PLAN },
      (_, index) =>
        installSkillFixture({
          name: `skill-${index}-${"x".repeat(48)}`,
          repository: `repo-${index % MAX_SOURCES_PER_PLAN}`,
          compatibleAgents: agents,
        }),
    );
    const options: Partial<InstallPlanOptions> = { agents };

    expectPlanError(installPlanFixture(selections, options), "COMMAND_TOO_LONG");
  });
});
