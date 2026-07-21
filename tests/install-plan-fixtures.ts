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
  branch?: string;
  discoveryPath?: string;
  branchHeadSha?: string;
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
  selectorVerifiedBranch?: string;
  selectorVerifiedDiscoveryPath?: string;
  selectorVerifiedBranchHeadSha?: string;
}>;

/** Synthetic metadata only; no skill body or public catalog row is represented. */
export function installSkillFixture(
  options: SkillFixtureOptions = {},
): ResolvedGithubSkill {
  const name = options.name ?? "fixture-skill";
  const owner = options.owner ?? "fixture-owner";
  const repository = options.repository ?? "fixture-repository";
  const branch = options.branch ?? "main";
  const discoveryPath = options.discoveryPath ?? "skills";
  const branchHeadSha = options.branchHeadSha ?? options.commitSha ?? "a".repeat(40);
  const commitSha = options.commitSha ?? branchHeadSha;

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
      discoveryScope: {
        branch,
        path: discoveryPath,
        branchHeadSha,
      },
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
      verifiedDiscoveryScope: {
        branch: options.selectorVerifiedBranch ?? branch,
        path: options.selectorVerifiedDiscoveryPath ?? discoveryPath,
        branchHeadSha: options.selectorVerifiedBranchHeadSha ?? branchHeadSha,
      },
    },
  };
}

/**
 * Public repository scope snapshots observed during the skills@1.5.19 audit.
 * Eligibility fields remain synthetic test metadata; no skill bodies are copied.
 */
export const auditedPublicScopeFixtures = {
  freshtech: installSkillFixture({
    name: "gsap-scrolltrigger",
    owner: "freshtechbro",
    repository: "claudedesignskills",
    discoveryPath: ".claude/skills",
    branchHeadSha: "1da73febff0c3e1dfefc07f8a5ef8f7d1dfdb6cd",
  }),
  azure: installSkillFixture({
    name: "azure-ai",
    owner: "microsoft",
    repository: "azure-skills",
    discoveryPath: "skills",
    branchHeadSha: "d3e702378432d4d53ca80b2bba0fbb4af83ace24",
  }),
  impeccable: installSkillFixture({
    name: "impeccable",
    owner: "pbakaus",
    repository: "impeccable",
    discoveryPath: ".agents/skills/impeccable",
    branchHeadSha: "4d849eb75f216109ea7053ed21530a11fafcc786",
  }),
} as const;

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
