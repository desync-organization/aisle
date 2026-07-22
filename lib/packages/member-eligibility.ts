import { and, desc, eq, inArray, sql } from "drizzle-orm";

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

export type PackageMemberEligibilityResult =
  | Readonly<{ ok: true; member: EligiblePackageMember }>
  | Readonly<{ ok: false; error: PackageMemberEligibilityError }>;

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

function hasCertifiedSourceObservation() {
  return sql<boolean>`(
    (
      ${catalogSources.freshnessPolicy} = 'retain'
      and exists (
        select 1
        from sync_runs package_retain_run
        where package_retain_run.id = ${sourceListings.lastSeenRunId}
          and package_retain_run.source_id = ${sourceListings.sourceId}
          and package_retain_run.status in ('succeeded', 'partial')
          and package_retain_run.finished_at is not null
      )
    )
    or (
      ${catalogSources.freshnessPolicy} = 'latest-completed-observation'
      and ${sourceListings.lastCompletedObservationRunId} is not null
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

export async function resolveEligiblePackageMembers(
  transaction: CatalogTransaction,
  inputs: readonly PackageMemberEligibilityBinding[],
): Promise<PackageMemberEligibilityResult[]> {
  const prepared = inputs.map((input) => {
    try {
      const repositoryUrl = normalizeSourceUrl(input.repositoryUrl);
      const url = new URL(repositoryUrl);
      const repositoryCoordinates = url.pathname.split("/").filter(Boolean);
      if (repositoryCoordinates.length !== 2 || url.hostname !== "github.com") {
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
      return {
        ok: true as const,
        input,
        repositoryUrl,
        skillPath,
        expectedOwner,
        expectedRepository,
      };
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof PackageMemberEligibilityError
          ? error
          : new PackageMemberEligibilityError(
              "PROVENANCE_MISMATCH",
              "Package repository evidence is not one canonical public GitHub origin.",
            ),
      };
    }
  });
  const valid = prepared.filter((entry): entry is Extract<typeof entry, { ok: true }> => entry.ok);
  if (valid.length === 0) {
    return prepared.map((entry) => ({
      ok: false as const,
      error: entry.ok
        ? new PackageMemberEligibilityError("MEMBER_NOT_FOUND", "The package member did not resolve.")
        : entry.error,
    }));
  }

  const candidates = await transaction
    .select({
      repositoryOwner: repositories.owner,
      repositoryName: repositories.name,
      repositoryUrl: repositories.normalizedUrl,
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
    .where(
      and(
        eq(repositories.provider, "github"),
        eq(repositories.visibility, "public"),
        inArray(repositories.normalizedUrl, [...new Set(valid.map((entry) => entry.repositoryUrl))]),
        eq(skills.provider, "github"),
        inArray(skills.sourceUrl, [...new Set(valid.map((entry) => entry.repositoryUrl))]),
        inArray(skills.skillPath, [...new Set(valid.map((entry) => entry.skillPath))]),
        inArray(skills.upstreamName, [...new Set(valid.map((entry) => entry.input.upstreamSkillName))]),
        eq(skillRevisions.isCurrent, true),
      ),
    );

  const candidateSkillIds = [...new Set(candidates.map((candidate) => candidate.skillId))];
  const candidateRevisionIds = [...new Set(candidates.map((candidate) => candidate.revisionId))];
  const activeListings = candidateSkillIds.length === 0 ? [] : await transaction
    .select({ skillId: sourceListings.skillId, sourceHash: sourceListings.sourceHash })
    .from(sourceListings)
    .innerJoin(catalogSources, eq(catalogSources.id, sourceListings.sourceId))
    .where(
      and(
        inArray(sourceListings.skillId, candidateSkillIds),
        inArray(sourceListings.status, ["current", "stale"]),
        eq(catalogSources.enabled, true),
        eq(catalogSources.coverageState, packageAdmissibleCoverageStates[0]),
        hasCertifiedSourceObservation(),
      ),
    );

  const assessments = candidateRevisionIds.length === 0 ? [] : await transaction
    .select({
      revisionId: trustAssessments.revisionId,
      state: trustAssessments.state,
      immutableRef: trustAssessments.immutableRef,
      contentHash: trustAssessments.contentHash,
    })
    .from(trustAssessments)
    .where(inArray(trustAssessments.revisionId, candidateRevisionIds));
  const observations = candidateSkillIds.length === 0 ? [] : await transaction
    .select({
      id: auditRecords.id,
      skillId: sourceListings.skillId,
      provider: auditRecords.provider,
      providerSlug: auditRecords.providerSlug,
      status: auditRecords.status,
      upstreamContentHash: auditRecords.upstreamContentHash,
      observedAt: auditRecords.observedAt,
    })
    .from(auditRecords)
    .innerJoin(sourceListings, eq(sourceListings.id, auditRecords.sourceListingId))
    .where(
      and(
        inArray(sourceListings.skillId, candidateSkillIds),
        eq(auditRecords.scope, "observation"),
      ),
    )
    .orderBy(desc(auditRecords.observedAt), desc(auditRecords.id));

  return prepared.map((entry): PackageMemberEligibilityResult => {
    if (!entry.ok) return entry;
    const { input, repositoryUrl, skillPath, expectedOwner, expectedRepository } = entry;
    try {
      const matchingCandidates = candidates.filter((candidate) =>
        candidate.repositoryUrl === repositoryUrl &&
        candidate.sourceUrl === repositoryUrl &&
        candidate.skillPath === skillPath &&
        candidate.name === input.upstreamSkillName &&
        (!input.skillId || candidate.skillId === input.skillId) &&
        (!input.revisionId || candidate.revisionId === input.revisionId));
      if (matchingCandidates.length !== 1) {
        fail(
          "MEMBER_NOT_FOUND",
          "The exact public repository, SKILL.md path, name, skill, and revision did not resolve uniquely.",
        );
      }
      const candidate = matchingCandidates[0]!;
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
      if (!activeListings.some((listing) =>
        listing.skillId === candidate.skillId && listing.sourceHash === input.observedHead)) {
        fail(
          "PROVENANCE_MISMATCH",
          "No current enabled admissible source observation remains bound to the revision.",
        );
      }
      const boundAssessments = assessments.filter(
        (assessment) =>
          assessment.revisionId === candidate.revisionId &&
          assessment.immutableRef === candidate.immutableRef &&
          assessment.contentHash === candidate.contentHash,
      );
      if (
        !boundAssessments.some((assessment) => ["pass", "warn"].includes(assessment.state)) ||
        boundAssessments.some((assessment) => ["fail", "quarantined"].includes(assessment.state))
      ) {
        fail("TRUST_NOT_ELIGIBLE", "The exact revision lacks selectable revision-bound trust evidence.");
      }
      const latestKeys = new Set<string>();
      for (const observation of observations) {
        if (
          observation.skillId !== candidate.skillId ||
          observation.upstreamContentHash !== input.observedHead
        ) continue;
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
        ok: true,
        member: {
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
        },
      };
    } catch (error) {
      if (error instanceof PackageMemberEligibilityError) return { ok: false, error };
      throw error;
    }
  });
}

export async function resolveEligiblePackageMember(
  transaction: CatalogTransaction,
  input: PackageMemberEligibilityBinding,
): Promise<EligiblePackageMember> {
  const [result] = await resolveEligiblePackageMembers(transaction, [input]);
  if (!result || !result.ok) {
    throw result?.error ?? new PackageMemberEligibilityError(
      "MEMBER_NOT_FOUND",
      "The package member did not resolve.",
    );
  }
  return result.member;
}
