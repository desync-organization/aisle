import type {
  InstallPlanOptions,
  InstallPlanRequest,
  ResolvedGithubSkill,
  SupportedAgent,
} from "@/lib/install-plan";

type SkillFixtureOptions = Readonly<{
  name?: string;
  normalizedName?: string;
  owner?: string;
  repository?: string;
  canonicalSkillId?: string;
  revisionId?: string;
  publication?: ResolvedGithubSkill["publication"];
  availability?: ResolvedGithubSkill["availability"];
  licenseStatus?: ResolvedGithubSkill["license"]["status"];
  licenseExpression?: string | null;
  validation?: ResolvedGithubSkill["trust"]["validation"];
  blocked?: boolean;
  quarantined?: boolean;
  compatibleAgents?: readonly SupportedAgent[];
  commitSha?: string;
  contentDigest?: string;
  selector?: string;
  selectorVerifiedUnique?: boolean;
  selectorVerifiedAtCommitSha?: string;
}>;

/** Synthetic metadata only; no skill body or public catalog row is represented. */
export function installSkillFixture(
  options: SkillFixtureOptions = {},
): ResolvedGithubSkill {
  const name = options.name ?? "fixture-skill";
  const owner = options.owner ?? "fixture-owner";
  const repository = options.repository ?? "fixture-repository";
  const commitSha = options.commitSha ?? "a".repeat(40);

  return {
    canonicalSkillId:
      options.canonicalSkillId ?? `skill:${owner.toLowerCase()}:${repository.toLowerCase()}:${name}`,
    revisionId:
      options.revisionId ?? `revision:${owner.toLowerCase()}:${repository.toLowerCase()}:${name}`,
    name,
    normalizedName: options.normalizedName ?? name,
    source: {
      kind: "github",
      owner,
      repository,
    },
    publication: options.publication ?? "public",
    availability: options.availability ?? "current",
    license: {
      status: options.licenseStatus ?? "verified",
      expression:
        options.licenseExpression === undefined ? "MIT" : options.licenseExpression,
    },
    trust: {
      validation: options.validation ?? "passed",
      blocked: options.blocked ?? false,
      quarantined: options.quarantined ?? false,
    },
    compatibleAgents: [...(options.compatibleAgents ?? ["codex", "claude-code", "cursor"])],
    observed: {
      commitSha,
      contentDigest: options.contentDigest ?? `sha256:${"b".repeat(64)}`,
    },
    installer: {
      selector: options.selector ?? name,
      selectorVerifiedUnique: options.selectorVerifiedUnique ?? true,
      verifiedAtCommitSha: options.selectorVerifiedAtCommitSha ?? commitSha,
    },
  };
}

export function installPlanFixture(
  selections: readonly ResolvedGithubSkill[] = [installSkillFixture()],
  options: Partial<InstallPlanOptions> = {},
): InstallPlanRequest {
  return {
    selections: [...selections],
    options: {
      agents: ["codex"],
      scope: "project",
      mode: "copy",
      shell: "posix",
      ...options,
    },
  };
}
