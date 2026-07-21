import { createHash } from "node:crypto";

import type { InstallShell } from "./contracts";
import { resolveInstallPlanCore, type InstallPlanCore } from "./planner";
import { renderShellCommands, type ShellCommands } from "./shells";

export * from "./contracts";
export * from "./planner";
export * from "./shells";

export type InstallPlan = InstallPlanCore &
  Readonly<{
    id: string;
    command: string;
    commands: ShellCommands;
    semantics: Readonly<{
      atomic: false;
      processLevelFailFast: true;
      failFastBoundary: "process-exit-status-only";
      runtimeCompletenessVerified: false;
      sourceRevisionEnforced: false;
      pathScopeEnforced: true;
      allSelectorsRuntimeEnforced: false;
      partialInstallPossible: true;
      agentFailureMayExitZero: true;
      mutableSourceRacePossible: true;
    }>;
    warnings: readonly string[];
  }>;

const warnings = [
  "Installation is best-effort and non-atomic; earlier discovery-scope steps are not rolled back if a later process fails.",
  "The pinned CLI can exit successfully after an individual agent install fails or after only a subset of requested names matches.",
  "The generated GitHub URL enforces the verified branch/path discovery scope, but it does not enforce the observed commit SHA.",
  "The source branch is mutable and can move after the backend preflight but before the CLI clone begins.",
] as const;

function contentAddress(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function createInstallPlan(input: unknown): InstallPlan {
  const core = resolveInstallPlanCore(input);
  const commands = renderShellCommands(core.steps);
  const shell: InstallShell = core.options.shell;

  const addressedPayload = {
    ...core,
    commands,
    semantics: {
      atomic: false,
      processLevelFailFast: true,
      failFastBoundary: "process-exit-status-only",
      runtimeCompletenessVerified: false,
      sourceRevisionEnforced: false,
      pathScopeEnforced: true,
      allSelectorsRuntimeEnforced: false,
      partialInstallPossible: true,
      agentFailureMayExitZero: true,
      mutableSourceRacePossible: true,
    },
    warnings,
  } as const;

  return {
    id: contentAddress(addressedPayload),
    ...addressedPayload,
    command: commands[shell],
  };
}
