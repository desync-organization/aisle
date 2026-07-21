import type { ZodError } from "zod";

import {
  GLOBAL_UNSUPPORTED_AGENTS,
  InstallPlanError,
  MAX_SKILLS_PER_PLAN,
  MAX_SOURCES_PER_PLAN,
  SKILLS_CLI_MINIMUM_NODE_VERSION,
  SKILLS_CLI_PACKAGE,
  installPlanRequestSchema,
  type InstallMode,
  type InstallPlanOptions,
  type InstallShell,
  type InstallScope,
  type ResolvedGithubSkill,
  type SupportedAgent,
} from "./contracts";

export type InstallStepSelection = Readonly<{
  canonicalSkillId: string;
  revisionId: string;
  name: string;
  normalizedName: string;
  observedCommitSha: string;
  contentDigest: string;
  installerSelector: string;
  selectorVerifiedUnique: true;
  selectorVerifiedAtCommitSha: string;
}>;

export type InstallExecutionStep = Readonly<{
  id: string;
  source: string;
  sourceUrl: string;
  file: "npx";
  args: readonly string[];
  selections: readonly InstallStepSelection[];
}>;

export type InstallPlanCore = Readonly<{
  options: Readonly<{
    agents: readonly SupportedAgent[];
    scope: InstallScope;
    mode: InstallMode;
    shell: InstallShell;
  }>;
  runtime: Readonly<{
    executable: "npx";
    package: typeof SKILLS_CLI_PACKAGE;
    minimumNodeVersion: typeof SKILLS_CLI_MINIMUM_NODE_VERSION;
  }>;
  steps: readonly InstallExecutionStep[];
  selectionCount: number;
  sourceCount: number;
}>;

const globallyUnsupportedAgents = new Set<string>(GLOBAL_UNSUPPORTED_AGENTS);

function invalidInput(error: ZodError): InstallPlanError {
  return new InstallPlanError(
    "INVALID_INPUT",
    "The install plan request does not match the public install contract.",
    error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  );
}

function normalizeSkillName(name: string): string {
  return name
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function canonicalSource(skill: ResolvedGithubSkill): string {
  return `${skill.source.owner.toLowerCase()}/${skill.source.repository.toLowerCase()}`;
}

function assertScopeIsSupported(options: InstallPlanOptions): void {
  if (options.scope !== "global") return;

  const unsupported = options.agents.filter((agent) => globallyUnsupportedAgents.has(agent));
  if (unsupported.length > 0) {
    throw new InstallPlanError(
      "UNSUPPORTED_GLOBAL_SCOPE",
      `Global installation is not supported for: ${unsupported.sort().join(", ")}.`,
    );
  }
}

function assertEligible(
  skill: ResolvedGithubSkill,
  agents: readonly SupportedAgent[],
  index: number,
): void {
  const field = (name: string) => [{ path: `selections.${index}.${name}`, message: "rejected" }];

  if (skill.publication !== "public") {
    throw new InstallPlanError(
      "NOT_PUBLIC",
      "Every install selection must be confirmed public.",
      field("publication"),
    );
  }
  if (skill.availability !== "current") {
    throw new InstallPlanError(
      "NOT_CURRENT",
      "Withdrawn or superseded revisions cannot be installed.",
      field("availability"),
    );
  }
  if (skill.trust.blocked) {
    throw new InstallPlanError(
      "BLOCKED",
      "A blocked revision cannot be installed.",
      field("trust.blocked"),
    );
  }
  if (skill.trust.quarantined) {
    throw new InstallPlanError(
      "QUARANTINED",
      "A quarantined revision cannot be installed.",
      field("trust.quarantined"),
    );
  }
  if (skill.trust.validation !== "passed") {
    throw new InstallPlanError(
      "VALIDATION_REQUIRED",
      "Every revision must pass catalog validation before installation.",
      field("trust.validation"),
    );
  }
  if (skill.license.status !== "verified" || skill.license.expression === null) {
    throw new InstallPlanError(
      "UNLICENSED",
      "Every install selection must have verified license evidence.",
      field("license"),
    );
  }
  if (!skill.installer.selectorVerifiedUnique) {
    throw new InstallPlanError(
      "SELECTOR_NOT_UNIQUE",
      "The CLI skill selector must be unique within its repository at the scanned revision.",
      field("installer.selectorVerifiedUnique"),
    );
  }
  if (
    skill.installer.selector !== skill.name ||
    skill.installer.verifiedAtCommitSha !== skill.observed.commitSha
  ) {
    throw new InstallPlanError(
      "SELECTOR_EVIDENCE_MISMATCH",
      "Installer selector evidence must match the selected name and observed revision.",
      field("installer"),
    );
  }

  const compatibleAgents = new Set(skill.compatibleAgents);
  const incompatibleAgents = agents.filter((agent) => !compatibleAgents.has(agent));
  if (incompatibleAgents.length > 0) {
    throw new InstallPlanError(
      "INCOMPATIBLE_AGENT",
      `The revision is not compatible with: ${incompatibleAgents.join(", ")}.`,
      field("compatibleAgents"),
    );
  }
}

function assertNoSelectionConflicts(selections: readonly ResolvedGithubSkill[]): void {
  const revisions = new Set<string>();
  const canonicalRevisions = new Map<string, string>();
  const normalizedNames = new Map<string, string>();

  selections.forEach((skill, index) => {
    if (skill.normalizedName !== normalizeSkillName(skill.name)) {
      throw new InstallPlanError(
        "INVALID_INPUT",
        "A resolved normalized name does not match its public skill name.",
        [{ path: `selections.${index}.normalizedName`, message: "normalization mismatch" }],
      );
    }

    if (revisions.has(skill.revisionId)) {
      throw new InstallPlanError(
        "DUPLICATE_SELECTION",
        "The same resolved revision was selected more than once.",
        [{ path: `selections.${index}.revisionId`, message: "duplicate revision" }],
      );
    }
    revisions.add(skill.revisionId);

    const previousRevision = canonicalRevisions.get(skill.canonicalSkillId);
    if (previousRevision !== undefined) {
      throw new InstallPlanError(
        "CONFLICTING_REVISION",
        "A canonical skill cannot resolve to multiple revisions in one plan.",
        [{ path: `selections.${index}.canonicalSkillId`, message: "conflicting revision" }],
      );
    }
    canonicalRevisions.set(skill.canonicalSkillId, skill.revisionId);

    const source = canonicalSource(skill);
    const previousSource = normalizedNames.get(skill.normalizedName);
    if (previousSource !== undefined) {
      throw new InstallPlanError(
        "NORMALIZED_NAME_CONFLICT",
        previousSource === source
          ? "A normalized skill name was selected more than once from the same source."
          : "The same normalized skill name cannot be installed from multiple sources.",
        [{ path: `selections.${index}.normalizedName`, message: "normalized name conflict" }],
      );
    }
    normalizedNames.set(skill.normalizedName, source);
  });
}

function createArgs(
  source: string,
  selections: readonly ResolvedGithubSkill[],
  options: Readonly<{ agents: readonly SupportedAgent[]; scope: InstallScope; mode: InstallMode }>,
): readonly string[] {
  const args: string[] = [
    "--yes",
    SKILLS_CLI_PACKAGE,
    "add",
    source,
    "--full-depth",
  ];

  for (const selection of selections) {
    args.push("--skill", selection.name);
  }
  for (const agent of options.agents) {
    args.push("--agent", agent);
  }
  if (options.scope === "global") {
    args.push("--global");
  }
  // The pinned CLI uses symlink mode by default and does not expose a
  // --symlink flag. Keeping the choice explicit in options avoids prompting.
  if (options.mode === "copy") {
    args.push("--copy");
  }
  args.push("--yes");

  return args;
}

export function resolveInstallPlanCore(input: unknown): InstallPlanCore {
  const parsed = installPlanRequestSchema.safeParse(input);
  if (!parsed.success) throw invalidInput(parsed.error);

  const { selections, options } = parsed.data;
  if (selections.length === 0) {
    throw new InstallPlanError("EMPTY_SELECTION", "Select at least one public skill.");
  }
  if (selections.length > MAX_SKILLS_PER_PLAN) {
    throw new InstallPlanError(
      "SELECTION_LIMIT_EXCEEDED",
      `A plan can contain at most ${MAX_SKILLS_PER_PLAN} skills.`,
    );
  }

  assertScopeIsSupported(options);
  assertNoSelectionConflicts(selections);

  const agents = [...options.agents].sort();
  selections.forEach((skill, index) => assertEligible(skill, agents, index));

  const grouped = new Map<string, ResolvedGithubSkill[]>();
  for (const selection of selections) {
    const source = canonicalSource(selection);
    const group = grouped.get(source) ?? [];
    group.push(selection);
    grouped.set(source, group);
  }

  if (grouped.size > MAX_SOURCES_PER_PLAN) {
    throw new InstallPlanError(
      "SOURCE_LIMIT_EXCEEDED",
      `A plan can contain at most ${MAX_SOURCES_PER_PLAN} GitHub sources.`,
    );
  }

  const normalizedOptions = {
    agents,
    scope: options.scope,
    mode: options.mode,
    shell: options.shell,
  } as const;

  const steps = [...grouped.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([source, sourceSelections], index): InstallExecutionStep => {
      const orderedSelections = [...sourceSelections].sort((left, right) =>
        left.normalizedName === right.normalizedName
          ? left.revisionId < right.revisionId
            ? -1
            : left.revisionId > right.revisionId
              ? 1
              : 0
          : left.normalizedName < right.normalizedName
            ? -1
            : 1,
      );

      return {
        id: `step-${String(index + 1).padStart(2, "0")}`,
        source,
        sourceUrl: `https://github.com/${source}`,
        file: "npx",
        args: createArgs(source, orderedSelections, normalizedOptions),
        selections: orderedSelections.map((selection) => ({
          canonicalSkillId: selection.canonicalSkillId,
          revisionId: selection.revisionId,
          name: selection.name,
          normalizedName: selection.normalizedName,
          observedCommitSha: selection.observed.commitSha,
          contentDigest: selection.observed.contentDigest,
          installerSelector: selection.installer.selector,
          selectorVerifiedUnique: true,
          selectorVerifiedAtCommitSha: selection.installer.verifiedAtCommitSha,
        })),
      };
    });

  return {
    options: normalizedOptions,
    runtime: {
      executable: "npx",
      package: SKILLS_CLI_PACKAGE,
      minimumNodeVersion: SKILLS_CLI_MINIMUM_NODE_VERSION,
    },
    steps,
    selectionCount: selections.length,
    sourceCount: steps.length,
  };
}
