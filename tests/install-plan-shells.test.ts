import { describe, expect, it } from "vitest";

import {
  InstallPlanError,
  createInstallPlan,
  quoteCmdArgument,
  quotePosixArgument,
  quotePowerShellArgument,
} from "@/lib/install-plan";
import { installPlanFixture, installSkillFixture } from "./install-plan-fixtures";

describe("install command rendering", () => {
  it("quotes spaces, apostrophes, and punctuation for each supported shell", () => {
    expect(quotePosixArgument("space & it's safe")).toBe("'space & it'\"'\"'s safe'");
    expect(quotePowerShellArgument("space & it's safe")).toBe("'space & it''s safe'");
    expect(quoteCmdArgument("space & (punctuation); safe")).toBe(
      '"space & (punctuation); safe"',
    );
  });

  it.each(["%PATH%", "!delayed!", 'quote"break']) (
    "rejects cmd expansion or quote hazards: %s",
    (argument) => {
      expect(() => quoteCmdArgument(argument)).toThrowError(InstallPlanError);
    },
  );

  it.each([quotePosixArgument, quotePowerShellArgument, quoteCmdArgument])(
    "rejects control characters before rendering",
    (quote) => {
      expect(() => quote("safe\nunsafe")).toThrowError(InstallPlanError);
    },
  );

  it("renders one single-line pasteable command per shell", () => {
    const plan = createInstallPlan(
      installPlanFixture([
        installSkillFixture({ name: "one", owner: "alpha", repository: "repo" }),
        installSkillFixture({ name: "two", owner: "beta", repository: "repo" }),
      ]),
    );

    expect(Object.keys(plan.commands)).toEqual([
      "posix",
      "powershell7",
      "powershell51",
      "cmd",
    ]);
    Object.values(plan.commands).forEach((command) => {
      expect(command).not.toMatch(/[\r\n]/);
    });

    expect(plan.commands.posix).toContain("'npx' '--yes' 'skills@1.5.19'");
    expect(plan.commands.posix).toContain(" && ");
    expect(plan.commands.powershell7).toContain("& 'npx' '--yes' 'skills@1.5.19'");
    expect(plan.commands.powershell7).toContain(" && ");
    expect(plan.commands.powershell51).toMatch(/^& \{ /);
    expect(plan.commands.powershell51).toContain("$LASTEXITCODE -ne 0");
    expect(plan.commands.powershell51).not.toContain(" && ");
    expect(plan.commands.cmd).toContain('"npx" "--yes" "skills@1.5.19"');
    expect(plan.commands.cmd).toContain(" && ");
  });

  it("selects the requested shell without changing the other renderings", () => {
    const plan = createInstallPlan(
      installPlanFixture(undefined, { shell: "powershell51" }),
    );
    expect(plan.command).toBe(plan.commands.powershell51);
  });

  it("never emits bulk, pipe-to-shell, unsupported symlink, or observed-revision text", () => {
    const plan = createInstallPlan(installPlanFixture());
    const rendered = Object.values(plan.commands).join("\n");

    expect(rendered).not.toContain("--all");
    expect(rendered).not.toContain("curl");
    expect(rendered).not.toContain("--symlink");
    expect(rendered).not.toContain("a".repeat(40));
    expect(rendered).not.toContain("b".repeat(64));
    expect(plan.semantics).toEqual({
      atomic: false,
      processLevelFailFast: true,
      failFastBoundary: "process-exit-status-only",
      runtimeCompletenessVerified: false,
      sourceRevisionEnforced: false,
      partialInstallPossible: true,
      agentFailureMayExitZero: true,
    });
    expect(plan.warnings).toHaveLength(3);
  });
});
