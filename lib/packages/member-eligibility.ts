import { and, desc, eq, sql } from "drizzle-orm";

import { normalizeSkillPath, normalizeSourceUrl } from "../catalog/normalization";
import { installSpecSchema } from "../catalog/source-contract";
import type { CatalogDatabase } from "../db/client";
import {
  auditRecords,
  catalogSources,
  repositories,
  skillRevisions,
  skills,
  sourceListings,
  trustAssessments,
} from "../db/schema";

type CatalogTransaction = Parameters<Parameters<CatalogDatabase["transaction"]>[0]>[0];

export const packageAdmissibleCoverageStates = ["current"] as const;
const packageAdmissibleLicenses = new Set(["MIT", "Apache-2.0"]);

export type PackageMemberEligibilityCode =
  | "MEMBER_NOT_FOUND"
  | "REVISION_MISMATCH"
  | "LICENSE_EVIDENCE_MISMATCH"
  | "TRUST_NOT_ELIGIBLE"
  | "PROVENANCE_MISMATCH";

export class PackageMemberEligibilityError extends Error {
  constructor(readonly code: PackageMemberEligibilityCode, message: string) {
    super(message);
    this.name = "PackageMemberEligibilityError";
  }
}

export type PackageMemberEligibilityBinding = Readonly<{
  repositoryUrl: string;
  skillPath: string;
  upstreamSkillName: string;
  observedHead: string;
  observedLicense: string;
  licenseEvidenceClass: "repository-license" | "skill-local-license" | "skill-frontmatter";
  licenseEvidencePath: string;
  publisherClass: "official" | "community";
  skillId?: string;
  revisionId?: string;
}>;

export type EligiblePackageMember = Readonly<{
  skillId: string;
  revisionId: string;
  name: string;
  description: string | null;
  sourceUrl: string;
  skillPath: string;
  immutableRef: string;
  contentHash: string;
  installSpec: Record<string, unknown>;
  license: string;
  revisionMetadata: Record<string, unknown> | null;
  officialProvenance: boolean;
  repositoryOwner: string;
  repositoryName: string;
  repositoryDefaultBranch: string | null;
  trustState: "pass" | "warn";
}>;

type PersistedLicenseEvidence = Readonly<{
  path: string;
  sha256: string;
  source: string;
  sourceUrl?: string;
  immutableRef?: string;
}>;

function fail(code: PackageMemberEligibilityCode, message: string): never {
  throw new PackageMemberEligibilityError(code, message);
}

function readLicenseEvidence(
  metadata: Record<string, unknown> | null,
): PersistedLicenseEvidence | null {
  const value = metadata?.licenseEvidence;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const evidence = value as Record<string, unknown>;
  if (
    typeof evidence.path !== "string" ||
    typeof evidence.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(evidence.sha256) ||
    typeof evidence.source !== "string" ||
    (evidence.sourceUrl !== undefined && typeof evidence.sourceUrl !== "string") ||
    (evidence.immutableRef !== undefined && typeof evidence.immutableRef !== "string")
  ) {
    return null;
  }
  return {
    path: evidence.path,
    sha256: evidence.sha256,
    source: evidence.source,
    ...(typeof evidence.sourceUrl === "string" ? { sourceUrl: evidence.sourceUrl } : {}),
    ...(typeof evidence.immutableRef === "string" ? { immutableRef: evidence.immutableRef } : {}),
  };
}

function hasCompleteInventory(
  metadata: Record<string, unknown> | null,
  contentHash: string,
): boolean {
  const value = metadata?.fileInventory;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const inventory = value as Record<string, unknown>;
  return (
    inventory.schemaVersion === 1 &&
    inventory.complete === true &&
    typeof inventory.fileCount === "number" &&
    Number.isSafeInteger(inventory.fileCount) &&
    inventory.fileCount > 0 &&
    inventory.aggregateSha256 === contentHash
  );
}

function hasCertifiedSourceObservation(skillId: string, revisionId: string) {
  return sql<boolean>`(
    (
      ${catalogSources.freshnessPolicy} = 'retain'
      and exists (
        select 1
        from skill_category_observations package_observation
        join sync_runs package_observation_run
          on package_observation_run.id = package_observation.observed_run_id
          and package_observation_run.source_id = ${sourceListings.sourceId}
        where package_observation.source_listing_id = ${sourceListings.id}
          and package_observation.skill_id = ${skillId}
          and package_observation.revision_id = ${revisionId}
          and package_observation.source_hash = ${sourceListings.sourceHash}
          and package_observation_run.status in ('succeeded', 'partial')
          and package_observation_run.finished_at is not null
      )
    )
    or (
      ${catalogSources.freshnessPolicy} = 'latest-completed-observation'
      and ${sourceListings.lastCompletedObservationRunId} is not null
      and exists (
        select 1
        from skill_category_observations package_certified_observation
        where package_certified_observation.source_listing_id = ${sourceListings.id}
          and package_certified_observation.observed_run_id = ${sourceListings.lastCompletedObservationRunId}
          and package_certified_observation.skill_id = ${skillId}
          and package_certified_observation.revision_id = ${revisionId}
          and package_certified_observation.source_hash = ${sourceListings.sourceHash}
      )
      and ${sourceListings.lastCompletedObservationRunId} = (
        select package_completed_run.id
        from sync_runs package_completed_run
        where package_completed_run.source_id = ${sourceListings.sourceId}
          and package_completed_run.observation_sweep_complete = 1
          and package_completed_run.finished_at is not null
          and package_completed_run.status in ('succeeded', 'partial')
        order by package_completed_run.finished_at desc,
          package_completed_run.started_at desc,
          package_completed_run.id desc
        limit 1
      )
    )
  )`;
}

function licenseEvidenceMatches(
  binding: PackageMemberEligibilityBinding,
  evidence: PersistedLicenseEvidence,
  repositoryUrl: string,
  skillPath: string,
): boolean {
  if (binding.licenseEvidenceClass === "repository-license") {
    return (
      evidence.source === "repository-root-license-text" &&
      evidence.path === binding.licenseEvidencePath &&
      evidence.sourceUrl !== undefined &&
      normalizeSourceUrl(evidence.sourceUrl) === repositoryUrl &&
      evidence.immutableRef === binding.observedHead
    );
  }
  if (binding.licenseEvidenceClass === "skill-frontmatter") {
    const expectedManifestPath = skillPath === "." ? "SKILL.md" : `${skillPath}/SKILL.md`;
    return (
      evidence.source === "frontmatter-spdx" &&
      evidence.path === "SKILL.md" &&
      binding.licenseEvidencePath === expectedManifestPath
    );
  }
  const repositoryEvidencePath = skillPath === "." ? evidence.path : `${skillPath}/${evidence.path}`;
  return (
    evidence.source === "license-text-fingerprint" &&
    repositoryEvidencePath === binding.licenseEvidencePath
  );
}

export async function resolveEligiblePackageMember(
  transaction: CatalogTransaction,
  input: PackageMemberEligibilityBinding,
): Promise<EligiblePackageMember> {
  const repositoryUrl = normalizeSourceUrl(input.repositoryUrl);
  const repositoryCoordinates = new URL(repositoryUrl).pathname.split("/").filter(Boolean);
  if (repositoryCoordinates.length !== 2 || new URL(repositoryUrl).hostname !== "github.com") {
    fail("PROVENANCE_MISMATCH", "Package repository evidence is not one canonical public GitHub origin.");
  }
  const [expectedOwner, expectedRepository] = repositoryCoordinates as [string, string];
  const skillPath = normalizeSkillPath(input.skillPath);
  if (
    !/^[a-f0-9]{40}$/.test(input.observedHead) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.upstreamSkillName) ||
    !packageAdmissibleLicenses.has(input.observedLicense)
  ) {
    fail("REVISION_MISMATCH", "Package member identity or observed head is malformed.");
  }

  const identityConditions = [
    eq(repositories.provider, "github"),
    eq(repositories.normalizedUrl, repositoryUrl),
    eq(repositories.visibility, "public"),
    eq(skills.provider, "github"),
    eq(skills.sourceUrl, repositoryUrl),
    eq(skills.skillPath, skillPath),
    eq(skills.upstreamName, input.upstreamSkillName),
    eq(skillRevisions.isCurrent, true),
  ];
  if (input.skillId) identityConditions.push(eq(skills.id, input.skillId));
  if (input.revisionId) identityConditions.push(eq(skillRevisions.id, input.revisionId));
  const candidates = await transaction
    .select({
      repositoryOwner: repositories.owner,
      repositoryName: repositories.name,
      repositoryVisibility: repositories.visibility,
      repositoryDefaultBranch: repositories.defaultBranch,
      skillId: skills.id,
      sourceUrl: skills.sourceUrl,
      skillPath: skills.skillPath,
      name: skills.upstreamName,
      description: skills.upstreamDescription,
      lifecycle: skills.lifecycle,
      public: skills.public,
      internal: skills.internal,
      officialProvenance: skills.officialProvenance,
      revisionId: skillRevisions.id,
      immutableRef: skillRevisions.immutableRef,
      contentHash: skillRevisions.contentHash,
      upstreamHash: skillRevisions.upstreamHash,
      installSpec: skillRevisions.installSpecJson,
      license: skillRevisions.license,
      metadata: skillRevisions.metadataJson,
      isCurrent: skillRevisions.isCurrent,
    })
    .from(repositories)
    .innerJoin(skills, eq(skills.repositoryId, repositories.id))
    .innerJoin(skillRevisions, eq(skillRevisions.skillId, skills.id))
    .where(and(...identityConditions))
    .limit(2);
  if (candidates.length !== 1) {
    fail(
      "MEMBER_NOT_FOUND",
      "The exact public repository, SKILL.md path, name, skill, and revision did not resolve uniquely.",
    );
  }
  const candidate = candidates[0]!;
  if (
    candidate.repositoryOwner?.toLowerCase() !== expectedOwner ||
    candidate.repositoryName?.toLowerCase() !== expectedRepository ||
    candidate.repositoryVisibility !== "public" ||
    candidate.public !== true ||
    candidate.internal !== false ||
    candidate.lifecycle !== "current" ||
    candidate.isCurrent !== true
  ) {
    fail(
      "PROVENANCE_MISMATCH",
      "The catalog member no longer has the required public current repository provenance.",
    );
  }
  if (
    candidate.immutableRef !== input.observedHead ||
    candidate.upstreamHash !== input.observedHead ||
    !/^[a-f0-9]{64}$/.test(candidate.contentHash) ||
    !hasCompleteInventory(candidate.metadata, candidate.contentHash)
  ) {
    fail(
      "REVISION_MISMATCH",
      "The current revision is not bound to the expected head and complete artifact inventory.",
    );
  }
  const installSpec = installSpecSchema.safeParse(candidate.installSpec);
  if (
    !installSpec.success ||
    installSpec.data.kind !== "source" ||
    normalizeSourceUrl(installSpec.data.sourceUrl) !== repositoryUrl ||
    normalizeSkillPath(installSpec.data.skillPath) !== skillPath ||
    installSpec.data.immutableRef !== input.observedHead
  ) {
    fail(
      "REVISION_MISMATCH",
      "Immutable install evidence does not match the repository, path, and observed head.",
    );
  }

  const activeListings = await transaction
    .select({ id: sourceListings.id })
    .from(sourceListings)
    .innerJoin(catalogSources, eq(catalogSources.id, sourceListings.sourceId))
    .where(
      and(
        eq(sourceListings.skillId, candidate.skillId),
        eq(sourceListings.status, "current"),
        eq(sourceListings.sourceHash, input.observedHead),
        eq(catalogSources.enabled, true),
        eq(catalogSources.coverageState, packageAdmissibleCoverageStates[0]),
        hasCertifiedSourceObservation(candidate.skillId, candidate.revisionId),
      ),
    )
    .limit(1);
  if (activeListings.length !== 1) {
    fail(
      "PROVENANCE_MISMATCH",
      "No current enabled admissible source observation remains bound to the revision.",
    );
  }

  const assessments = await transaction
    .select({
      state: trustAssessments.state,
      immutableRef: trustAssessments.immutableRef,
      contentHash: trustAssessments.contentHash,
    })
    .from(trustAssessments)
    .where(eq(trustAssessments.revisionId, candidate.revisionId));
  const boundAssessments = assessments.filter(
    (assessment) =>
      assessment.immutableRef === candidate.immutableRef &&
      assessment.contentHash === candidate.contentHash,
  );
  if (
    !boundAssessments.some((assessment) => ["pass", "warn"].includes(assessment.state)) ||
    boundAssessments.some((assessment) => ["fail", "quarantined"].includes(assessment.state))
  ) {
    fail("TRUST_NOT_ELIGIBLE", "The exact revision lacks selectable revision-bound trust evidence.");
  }
  const observations = await transaction
    .select({
      id: auditRecords.id,
      provider: auditRecords.provider,
      providerSlug: auditRecords.providerSlug,
      status: auditRecords.status,
      observedAt: auditRecords.observedAt,
    })
    .from(auditRecords)
    .innerJoin(sourceListings, eq(sourceListings.id, auditRecords.sourceListingId))
    .where(
      and(
        eq(sourceListings.skillId, candidate.skillId),
        eq(auditRecords.scope, "observation"),
        eq(auditRecords.upstreamContentHash, input.observedHead),
      ),
    )
    .orderBy(desc(auditRecords.observedAt), desc(auditRecords.id));
  const latestKeys = new Set<string>();
  for (const observation of observations) {
    const key = `${observation.provider}\0${observation.providerSlug ?? ""}`;
    if (latestKeys.has(key)) continue;
    latestKeys.add(key);
    if (observation.status === "fail") {
      fail("TRUST_NOT_ELIGIBLE", "The latest upstream observation for the exact revision failed.");
    }
  }

  const evidence = readLicenseEvidence(candidate.metadata);
  if (
    candidate.license !== input.observedLicense ||
    !evidence ||
    !licenseEvidenceMatches(input, evidence, repositoryUrl, skillPath)
  ) {
    fail(
      "LICENSE_EVIDENCE_MISMATCH",
      "Verified revision-bound license evidence no longer matches the package binding.",
    );
  }
  if (input.publisherClass === "official" && candidate.officialProvenance !== true) {
    fail(
      "PROVENANCE_MISMATCH",
      "An official package member requires catalog-verified publisher provenance.",
    );
  }
  return {
    skillId: candidate.skillId,
    revisionId: candidate.revisionId,
    name: candidate.name,
    description: candidate.description,
    sourceUrl: candidate.sourceUrl,
    skillPath: candidate.skillPath,
    immutableRef: candidate.immutableRef,
    contentHash: candidate.contentHash,
    installSpec: installSpec.data,
    license: candidate.license,
    revisionMetadata: candidate.metadata,
    officialProvenance: candidate.officialProvenance,
    repositoryOwner: candidate.repositoryOwner!,
    repositoryName: candidate.repositoryName!,
    repositoryDefaultBranch: candidate.repositoryDefaultBranch,
    trustState: boundAssessments.some((assessment) => assessment.state === "warn")
      ? "warn"
      : "pass",
  };
}
