import { createHash } from "node:crypto";

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { normalizeSkillPath, normalizeSourceUrl } from "@/lib/catalog/normalization";
import { installSpecSchema } from "@/lib/catalog/source-contract";
import type { CatalogDatabase } from "@/lib/db/client";
import {
  repositories,
  skillDuplicates,
  skillRevisions,
  skills,
  trustAssessments,
  trustFindings,
} from "@/lib/db/schema";
import {
  createInstallPlan,
  githubBranchSchema,
  githubDiscoveryPathSchema,
  InstallPlanError,
  resolvedGithubSkillSchema,
  SUPPORTED_AGENTS,
  type ResolvedGithubSkill,
} from "@/lib/install-plan";

import { ApiError } from "../errors";
import {
  revalidateGithubStackCandidates,
  stackGithubCandidateKey,
  type StackGithubRevalidationOptions,
  type StackGithubVerificationCandidate,
  type StackGithubVerificationResult,
} from "./github-revalidation";
import type {
  StackGateReason,
  StackResolveRequest,
} from "./contracts";

type CatalogTransaction = Parameters<Parameters<CatalogDatabase["transaction"]>[0]>[0];
type RawTrustState = "pass" | "warn" | "unreviewed" | "fail" | "quarantined";
type PublicStackTrust = "pass" | "warn" | "unreviewed" | "blocked";

type PersistedStackSelection = Readonly<{
  id: string;
  name: string;
  compatibility: string | null;
  sourceUrl: string;
  skillPath: string;
  lifecycle: "current" | "stale" | "unavailable" | "removed";
  public: boolean;
  internal: boolean;
  catalogLicense: string;
  repositoryProvider: string | null;
  repositoryUrl: string | null;
  repositoryOwner: string | null;
  repositoryName: string | null;
  repositoryVisibility: string | null;
  repositoryDefaultBranch: string | null;
  revisionId: string | null;
  immutableRef: string | null;
  contentHash: string | null;
  upstreamHash: string | null;
  revisionLicense: string | null;
  installSpec: Record<string, unknown> | null;
  revisionMetadata: Record<string, unknown> | null;
  trustState: RawTrustState;
  hasCurrentObservation: boolean;
  hasLatestAuditFailure: boolean;
  duplicateOfSkillId: string | null;
}>;

type WarningEvidenceRow = Readonly<{
  assessmentId: string;
  revisionId: string;
  immutableRef: string;
  contentHash: string;
  scanner: string;
  scannerVersion: string;
  state: RawTrustState;
  scannedAt: Date;
  quarantineReason: string | null;
  findingId: string | null;
  findingCode: string | null;
  findingSeverity: "info" | "warning" | "critical" | null;
  findingPath: string | null;
  findingMessage: string | null;
  findingEvidence: string | null;
}>;

type ResolvedStackSelection = Readonly<{
  persisted: PersistedStackSelection;
  publicRow: Readonly<{
    id: string;
    name: string;
    compatibilityAdvisory: string | null;
    sourceUrl: string;
    license: string;
    trust: PublicStackTrust;
    revisionId: string | null;
    immutableRef: string | null;
    selectable: boolean;
    gateReasons: readonly StackGateReason[];
    warningFingerprint?: string;
  }>;
  plannerSkill: ResolvedGithubSkill | null;
}>;

const trustStateExpression = sql<RawTrustState>`case
  when exists (
    select 1 from trust_assessments stack_trust
    where stack_trust.revision_id = ${skillRevisions.id}
      and stack_trust.immutable_ref = ${skillRevisions.immutableRef}
      and stack_trust.content_hash = ${skillRevisions.contentHash}
      and stack_trust.state = 'quarantined'
  ) then 'quarantined'
  when exists (
    select 1 from trust_assessments stack_trust
    where stack_trust.revision_id = ${skillRevisions.id}
      and stack_trust.immutable_ref = ${skillRevisions.immutableRef}
      and stack_trust.content_hash = ${skillRevisions.contentHash}
      and stack_trust.state = 'fail'
  ) then 'fail'
  when exists (
    select 1 from trust_assessments stack_trust
    where stack_trust.revision_id = ${skillRevisions.id}
      and stack_trust.immutable_ref = ${skillRevisions.immutableRef}
      and stack_trust.content_hash = ${skillRevisions.contentHash}
      and stack_trust.state = 'warn'
  ) then 'warn'
  when exists (
    select 1 from trust_assessments stack_trust
    where stack_trust.revision_id = ${skillRevisions.id}
      and stack_trust.immutable_ref = ${skillRevisions.immutableRef}
      and stack_trust.content_hash = ${skillRevisions.contentHash}
      and stack_trust.state = 'pass'
  ) then 'pass'
  else 'unreviewed'
end`;

const currentObservationExpression = sql<boolean>`exists (
  select 1
  from source_listings stack_listing
  join catalog_sources stack_source on stack_source.id = stack_listing.source_id
  where stack_listing.skill_id = ${skills.id}
    and stack_listing.status in ('current', 'stale')
    and stack_listing.source_hash = ${skillRevisions.upstreamHash}
    and stack_source.enabled = 1
    and stack_source.coverage_state in ('current', 'partial')
    and (
      (
        stack_source.freshness_policy = 'retain'
        and exists (
          select 1
          from skill_category_observations stack_observation
          join sync_runs stack_observation_run
            on stack_observation_run.id = stack_observation.observed_run_id
            and stack_observation_run.source_id = stack_listing.source_id
          where stack_observation.source_listing_id = stack_listing.id
            and stack_observation.skill_id = ${skills.id}
            and stack_observation.revision_id = ${skillRevisions.id}
            and stack_observation.source_hash = stack_listing.source_hash
            and stack_observation_run.status in ('succeeded', 'partial')
            and stack_observation_run.finished_at is not null
        )
      )
      or (
        stack_source.freshness_policy = 'latest-completed-observation'
        and stack_listing.last_completed_observation_run_id is not null
        and exists (
          select 1
          from skill_category_observations stack_certified_observation
          where stack_certified_observation.source_listing_id = stack_listing.id
            and stack_certified_observation.observed_run_id = stack_listing.last_completed_observation_run_id
            and stack_certified_observation.skill_id = ${skills.id}
            and stack_certified_observation.revision_id = ${skillRevisions.id}
            and stack_certified_observation.source_hash = stack_listing.source_hash
        )
        and stack_listing.last_completed_observation_run_id = (
          select stack_completed_run.id
          from sync_runs stack_completed_run
          where stack_completed_run.source_id = stack_listing.source_id
            and stack_completed_run.observation_sweep_complete = 1
            and stack_completed_run.finished_at is not null
            and stack_completed_run.status in ('succeeded', 'partial')
          order by stack_completed_run.finished_at desc,
            stack_completed_run.started_at desc,
            stack_completed_run.id desc
          limit 1
        )
      )
    )
)`;

const latestAuditFailureExpression = sql<boolean>`exists (
  select 1
  from audit_records stack_audit
  join source_listings stack_audit_listing on stack_audit_listing.id = stack_audit.source_listing_id
  where stack_audit_listing.skill_id = ${skills.id}
    and stack_audit.scope = 'observation'
    and stack_audit.status = 'fail'
    and stack_audit.upstream_content_hash = ${skillRevisions.upstreamHash}
    and not exists (
      select 1
      from audit_records stack_newer_audit
      where stack_newer_audit.source_listing_id = stack_audit.source_listing_id
        and stack_newer_audit.provider = stack_audit.provider
        and coalesce(stack_newer_audit.provider_slug, '') = coalesce(stack_audit.provider_slug, '')
        and coalesce(stack_newer_audit.upstream_content_hash, '') = coalesce(stack_audit.upstream_content_hash, '')
        and (
          stack_newer_audit.observed_at > stack_audit.observed_at
          or (
            stack_newer_audit.observed_at = stack_audit.observed_at
            and stack_newer_audit.id > stack_audit.id
          )
        )
    )
)`;

function selectionProjection() {
  return {
    id: skills.id,
    name: skills.upstreamName,
    compatibility: skills.compatibility,
    sourceUrl: skills.sourceUrl,
    skillPath: skills.skillPath,
    lifecycle: skills.lifecycle,
    public: skills.public,
    internal: skills.internal,
    catalogLicense: skills.license,
    repositoryProvider: repositories.provider,
    repositoryUrl: repositories.normalizedUrl,
    repositoryOwner: repositories.owner,
    repositoryName: repositories.name,
    repositoryVisibility: repositories.visibility,
    repositoryDefaultBranch: repositories.defaultBranch,
    revisionId: skillRevisions.id,
    immutableRef: skillRevisions.immutableRef,
    contentHash: skillRevisions.contentHash,
    upstreamHash: skillRevisions.upstreamHash,
    revisionLicense: skillRevisions.license,
    installSpec: skillRevisions.installSpecJson,
    revisionMetadata: skillRevisions.metadataJson,
    trustState: trustStateExpression,
    hasCurrentObservation: currentObservationExpression,
    hasLatestAuditFailure: latestAuditFailureExpression,
    duplicateOfSkillId: skillDuplicates.duplicateOfSkillId,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedSkillName(name: string): string {
  return name
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function compatibilityAdvisory(value: string | null): string | null {
  if (!value) return null;
  const bounded = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim()
    .slice(0, 500);
  return bounded || null;
}

function hasCompleteArtifact(row: PersistedStackSelection): boolean {
  const candidate = row.revisionMetadata?.fileInventory;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const inventory = candidate as Record<string, unknown>;
  return (
    inventory.schemaVersion === 1 &&
    inventory.complete === true &&
    typeof inventory.fileCount === "number" &&
    Number.isSafeInteger(inventory.fileCount) &&
    inventory.fileCount > 0 &&
    inventory.aggregateSha256 === row.contentHash
  );
}

function hasVerifiedLicenseEvidence(row: PersistedStackSelection): boolean {
  const candidate = row.revisionMetadata?.licenseEvidence;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const evidence = candidate as Record<string, unknown>;
  return (
    typeof evidence.path === "string" &&
    evidence.path.length > 0 &&
    typeof evidence.source === "string" &&
    evidence.source.length > 0 &&
    typeof evidence.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(evidence.sha256)
  );
}

function eligibleLicense(license: string): boolean {
  return (
    license.toLowerCase() !== "unknown" &&
    license.length <= 100 &&
    /^[A-Za-z0-9.+() -]+$/.test(license)
  );
}

function branchHeadEvidence(
  row: PersistedStackSelection,
): Readonly<{ branch: string; headSha: string }> | null {
  const candidate = row.revisionMetadata?.branchHeadEvidence;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    !row.repositoryUrl ||
    !row.repositoryOwner ||
    !row.repositoryName ||
    !row.repositoryDefaultBranch ||
    !row.immutableRef ||
    !row.upstreamHash
  ) {
    return null;
  }
  const evidence = candidate as Record<string, unknown>;
  if (
    evidence.schemaVersion !== 1 ||
    evidence.provider !== "github" ||
    typeof evidence.repositoryUrl !== "string" ||
    typeof evidence.owner !== "string" ||
    typeof evidence.repository !== "string" ||
    typeof evidence.branch !== "string" ||
    typeof evidence.headSha !== "string" ||
    !/^[a-f0-9]{40}$/.test(evidence.headSha) ||
    evidence.owner.toLowerCase() !== row.repositoryOwner.toLowerCase() ||
    evidence.repository.toLowerCase() !== row.repositoryName.toLowerCase() ||
    evidence.branch !== row.repositoryDefaultBranch ||
    evidence.headSha !== row.immutableRef ||
    evidence.headSha !== row.upstreamHash ||
    !githubBranchSchema.safeParse(evidence.branch).success
  ) {
    return null;
  }
  try {
    if (normalizeSourceUrl(evidence.repositoryUrl) !== normalizeSourceUrl(row.repositoryUrl)) {
      return null;
    }
  } catch {
    return null;
  }
  return { branch: evidence.branch, headSha: evidence.headSha };
}

function exactGithubBinding(row: PersistedStackSelection): boolean {
  const installSpec = installSpecSchema.safeParse(row.installSpec);
  if (
    !installSpec.success ||
    installSpec.data.kind !== "source" ||
    !row.repositoryUrl ||
    row.repositoryProvider !== "github" ||
    row.repositoryVisibility !== "public" ||
    !row.immutableRef
  ) {
    return false;
  }

  try {
    const sourceUrl = normalizeSourceUrl(row.sourceUrl);
    const repositoryUrl = normalizeSourceUrl(row.repositoryUrl);
    const source = new URL(sourceUrl);
    const repository = new URL(repositoryUrl);
    const coordinates = repository.pathname.split("/").filter(Boolean);
    return (
      source.protocol === "https:" &&
      source.hostname === "github.com" &&
      source.username === "" &&
      source.password === "" &&
      repository.protocol === "https:" &&
      repository.hostname === "github.com" &&
      repository.username === "" &&
      repository.password === "" &&
      coordinates.length === 2 &&
      coordinates[0]!.toLowerCase() === row.repositoryOwner?.toLowerCase() &&
      coordinates[1]!.toLowerCase() === row.repositoryName?.toLowerCase() &&
      sourceUrl === repositoryUrl &&
      normalizeSourceUrl(installSpec.data.sourceUrl) === sourceUrl &&
      normalizeSkillPath(installSpec.data.skillPath) === normalizeSkillPath(row.skillPath) &&
      installSpec.data.immutableRef === row.immutableRef
    );
  } catch {
    return false;
  }
}

function githubVerificationCandidate(
  row: PersistedStackSelection,
): StackGithubVerificationCandidate | null {
  const observed = branchHeadEvidence(row);
  if (
    !observed ||
    !row.repositoryOwner ||
    !row.repositoryName ||
    !exactGithubBinding(row)
  ) {
    return null;
  }
  return {
    selectionId: row.id,
    owner: row.repositoryOwner,
    repository: row.repositoryName,
    branch: observed.branch,
    persistedHeadSha: observed.headSha,
    skillPath: row.skillPath,
  };
}

function plannerSkill(
  row: PersistedStackSelection,
  verification: StackGithubVerificationResult | undefined,
): ResolvedGithubSkill | null {
  const license = row.revisionLicense ?? row.catalogLicense;
  const observedBranchHead = branchHeadEvidence(row);
  if (
    !row.revisionId ||
    !row.repositoryOwner ||
    !row.repositoryName ||
    !row.repositoryDefaultBranch ||
    !row.immutableRef ||
    !row.upstreamHash ||
    !row.contentHash ||
    !observedBranchHead ||
    verification?.state !== "verified" ||
    verification.headSha !== observedBranchHead.headSha ||
    !exactGithubBinding(row) ||
    !githubBranchSchema.safeParse(row.repositoryDefaultBranch).success ||
    !githubDiscoveryPathSchema.safeParse(row.skillPath).success
  ) {
    return null;
  }

  const discoveryScope = {
    branch: observedBranchHead.branch,
    path: row.skillPath,
    branchHeadSha: observedBranchHead.headSha,
  };
  const candidate = resolvedGithubSkillSchema.safeParse({
    canonicalSkillId: row.id,
    revisionId: row.revisionId,
    name: row.name,
    normalizedName: normalizedSkillName(row.name),
    source: {
      kind: "github",
      owner: row.repositoryOwner,
      repository: row.repositoryName,
      discoveryScope,
    },
    publication: "public",
    availability: "current",
    license: { status: "verified", expression: license },
    trust: { validation: "passed", blocked: false, quarantined: false },
    // This list describes destinations supported by the pinned installer. The
    // upstream freeform compatibility field is surfaced separately as an
    // advisory and is never interpreted as an agent allowlist.
    compatibleAgents: [...SUPPORTED_AGENTS],
    observed: {
      commitSha: observedBranchHead.headSha,
      contentDigest: `sha256:${row.contentHash}`,
    },
    installer: {
      selector: row.name,
      selectorVerifiedUnique: true,
      verifiedDiscoveryScope: discoveryScope,
    },
  });
  return candidate.success ? candidate.data : null;
}

async function warningEvidence(
  transaction: CatalogTransaction,
  rows: readonly PersistedStackSelection[],
): Promise<WarningEvidenceRow[]> {
  const revisionIds = rows
    .filter((row) => row.trustState === "warn" && row.revisionId)
    .map((row) => row.revisionId!);
  if (revisionIds.length === 0) return [];

  return transaction
    .select({
      assessmentId: trustAssessments.id,
      revisionId: trustAssessments.revisionId,
      immutableRef: trustAssessments.immutableRef,
      contentHash: trustAssessments.contentHash,
      scanner: trustAssessments.scanner,
      scannerVersion: trustAssessments.scannerVersion,
      state: trustAssessments.state,
      scannedAt: trustAssessments.scannedAt,
      quarantineReason: trustAssessments.quarantineReason,
      findingId: trustFindings.id,
      findingCode: trustFindings.code,
      findingSeverity: trustFindings.severity,
      findingPath: trustFindings.path,
      findingMessage: trustFindings.message,
      findingEvidence: trustFindings.evidence,
    })
    .from(trustAssessments)
    .leftJoin(trustFindings, eq(trustFindings.assessmentId, trustAssessments.id))
    .where(inArray(trustAssessments.revisionId, revisionIds))
    .orderBy(asc(trustAssessments.id), asc(trustFindings.id));
}

function warningFingerprint(
  row: PersistedStackSelection,
  evidenceRows: readonly WarningEvidenceRow[],
): string | null {
  if (!row.revisionId || !row.immutableRef || !row.contentHash) return null;
  const assessments = new Map<string, {
    assessmentId: string;
    scanner: string;
    scannerVersion: string;
    scannedAt: string;
    findings: Array<{
      id: string;
      code: string;
      severity: string;
      path: string | null;
      message: string;
      evidence: string | null;
    }>;
  }>();

  for (const evidence of evidenceRows) {
    if (
      evidence.revisionId !== row.revisionId ||
      evidence.immutableRef !== row.immutableRef ||
      evidence.contentHash !== row.contentHash ||
      evidence.state !== "warn"
    ) {
      continue;
    }
    const assessment = assessments.get(evidence.assessmentId) ?? {
      assessmentId: evidence.assessmentId,
      scanner: evidence.scanner,
      scannerVersion: evidence.scannerVersion,
      scannedAt: evidence.scannedAt.toISOString(),
      findings: [],
    };
    if (
      evidence.findingId &&
      evidence.findingCode &&
      evidence.findingSeverity &&
      evidence.findingMessage
    ) {
      assessment.findings.push({
        id: evidence.findingId,
        code: evidence.findingCode,
        severity: evidence.findingSeverity,
        path: evidence.findingPath,
        message: evidence.findingMessage,
        evidence: evidence.findingEvidence,
      });
    }
    assessments.set(evidence.assessmentId, assessment);
  }

  const boundWarnings = [...assessments.values()].sort((left, right) =>
    compareText(left.assessmentId, right.assessmentId),
  );
  if (boundWarnings.length === 0) return null;
  return `sha256:${createHash("sha256")
    .update(JSON.stringify({
      revisionId: row.revisionId,
      immutableRef: row.immutableRef,
      contentHash: row.contentHash,
      warnings: boundWarnings,
    }))
    .digest("hex")}`;
}

function resolvePublicTrust(
  rawTrust: RawTrustState,
  fingerprint: string | null,
): PublicStackTrust {
  if (rawTrust === "fail" || rawTrust === "quarantined") return "blocked";
  if (rawTrust === "warn") return fingerprint ? "warn" : "unreviewed";
  if (rawTrust === "pass") return "pass";
  return "unreviewed";
}

function resolveSelection(
  row: PersistedStackSelection,
  evidenceRows: readonly WarningEvidenceRow[],
  verification: StackGithubVerificationResult | undefined,
): ResolvedStackSelection {
  const reasons = new Set<StackGateReason>();
  const license = row.revisionLicense ?? row.catalogLicense;
  const fingerprint = row.trustState === "warn"
    ? warningFingerprint(row, evidenceRows)
    : null;
  const trust = resolvePublicTrust(row.trustState, fingerprint);
  const candidate = plannerSkill(row, verification);

  if (row.lifecycle !== "current") reasons.add("lifecycle-not-current");
  if (
    !row.revisionId ||
    !row.immutableRef ||
    !row.upstreamHash ||
    row.immutableRef !== row.upstreamHash ||
    !row.contentHash ||
    !/^[a-f0-9]{64}$/.test(row.contentHash) ||
    !hasCompleteArtifact(row)
  ) {
    reasons.add("revision-evidence-missing");
  }
  if (!candidate || row.duplicateOfSkillId) reasons.add("install-unresolved");
  if (verification?.state === "unavailable") {
    reasons.add("source-verification-unavailable");
  }
  if (verification?.state === "changed") reasons.add("source-revision-changed");
  if (verification?.state === "ambiguous") reasons.add("selector-scope-ambiguous");
  if (!row.hasCurrentObservation) reasons.add("source-inactive");
  if (!eligibleLicense(license)) reasons.add("license-not-eligible");
  if (!hasVerifiedLicenseEvidence(row)) reasons.add("license-evidence-missing");
  if (trust === "unreviewed") reasons.add("trust-pending");
  if (trust === "blocked") reasons.add("trust-blocked");
  if (row.hasLatestAuditFailure) reasons.add("upstream-audit-failed");

  const gateReasons = [...reasons];
  const selectable =
    candidate !== null &&
    (trust === "pass" || trust === "warn") &&
    gateReasons.length === 0;
  return {
    persisted: row,
    plannerSkill: selectable ? candidate : null,
    publicRow: {
      id: row.id,
      name: row.name,
      compatibilityAdvisory: compatibilityAdvisory(row.compatibility),
      sourceUrl: row.sourceUrl,
      license,
      trust,
      revisionId: row.revisionId,
      immutableRef: row.immutableRef,
      selectable,
      gateReasons,
      ...(trust === "warn" && fingerprint ? { warningFingerprint: fingerprint } : {}),
    },
  };
}

async function loadPersistedSelectionRows(
  transaction: CatalogTransaction,
  selectionIds: readonly string[],
): Promise<PersistedStackSelection[]> {
  const persistedRows = (await transaction
    .select(selectionProjection())
    .from(skills)
    .leftJoin(
      skillRevisions,
      and(eq(skillRevisions.skillId, skills.id), eq(skillRevisions.isCurrent, true)),
    )
    .leftJoin(repositories, eq(repositories.id, skills.repositoryId))
    .leftJoin(skillDuplicates, eq(skillDuplicates.skillId, skills.id))
    .where(
      and(
        inArray(skills.id, [...selectionIds]),
        eq(skills.public, true),
        eq(skills.internal, false),
      ),
    )) as PersistedStackSelection[];

  const byId = new Map(persistedRows.map((row) => [row.id, row]));
  const missing = selectionIds
    .map((id, index) => ({ id, index }))
    .filter(({ id }) => !byId.has(id));
  if (missing.length > 0) {
    throw new ApiError(
      404,
      "SELECTION_NOT_FOUND",
      "One or more selected public skills were not found.",
      missing.map(({ index }) => ({
        path: `selectionIds.${index}`,
        message: "Public canonical skill not found.",
      })),
    );
  }

  return persistedRows;
}

function bindVerificationToFreshRow(
  row: PersistedStackSelection,
  verification: StackGithubVerificationResult | undefined,
): StackGithubVerificationResult | undefined {
  if (verification?.state !== "verified") return verification;
  const candidate = githubVerificationCandidate(row);
  if (
    !candidate ||
    stackGithubCandidateKey(candidate) !== verification.candidateKey
  ) {
    return { state: "changed" };
  }
  return verification;
}

async function resolveSelectionSet(
  transaction: CatalogTransaction,
  selectionIds: readonly string[],
  verification: ReadonlyMap<string, StackGithubVerificationResult>,
): Promise<ResolvedStackSelection[]> {
  const persistedRows = await loadPersistedSelectionRows(transaction, selectionIds);
  const byId = new Map(persistedRows.map((row) => [row.id, row]));
  const evidence = await warningEvidence(transaction, persistedRows);
  return selectionIds.map((id) => {
    const row = byId.get(id)!;
    return resolveSelection(
      row,
      evidence,
      bindVerificationToFreshRow(row, verification.get(id)),
    );
  });
}

async function withLiveVerifiedSelections<T>(
  database: CatalogDatabase,
  selectionIds: readonly string[],
  github: StackGithubRevalidationOptions,
  operation: (
    transaction: CatalogTransaction,
    selections: readonly ResolvedStackSelection[],
  ) => T | Promise<T>,
): Promise<T> {
  const verificationCandidates = await database.transaction(async (transaction) => {
    const initialRows = await loadPersistedSelectionRows(transaction, selectionIds);
    return initialRows
      .map(githubVerificationCandidate)
      .filter((candidate): candidate is StackGithubVerificationCandidate => candidate !== null);
  });
  const verification = await revalidateGithubStackCandidates(verificationCandidates, github);

  return database.transaction(async (transaction) => {
    const selections = await resolveSelectionSet(transaction, selectionIds, verification);
    return operation(transaction, selections);
  });
}

export type StackResolutionDependencies = Readonly<{
  github?: StackGithubRevalidationOptions;
}>;

export async function preflightStackSelections(
  database: CatalogDatabase,
  selectionIds: readonly string[],
  dependencies: StackResolutionDependencies = {},
) {
  return withLiveVerifiedSelections(
    database,
    selectionIds,
    dependencies.github ?? {},
    (_transaction, selections) => selections.map((selection) => selection.publicRow),
  );
}

function assertAcknowledgements(
  selections: readonly ResolvedStackSelection[],
  acknowledgements: StackResolveRequest["acknowledgements"],
): void {
  const byId = new Map(acknowledgements.map((acknowledgement) => [
    acknowledgement.selectionId,
    acknowledgement,
  ]));
  const issues: Array<{ path: string; message: string }> = [];

  selections.forEach((selection, index) => {
    const acknowledgement = byId.get(selection.publicRow.id);
    if (selection.publicRow.trust !== "warn") {
      if (acknowledgement) {
        issues.push({
          path: `acknowledgements.${acknowledgements.indexOf(acknowledgement)}`,
          message: "Only a current warning-tier revision can be acknowledged.",
        });
      }
      return;
    }

    if (!acknowledgement) {
      issues.push({
        path: `selectionIds.${index}`,
        message: "The current warning-tier revision requires acknowledgement.",
      });
      return;
    }
    if (
      acknowledgement.revisionId !== selection.publicRow.revisionId ||
      acknowledgement.warningFingerprint !== selection.publicRow.warningFingerprint
    ) {
      issues.push({
        path: `acknowledgements.${acknowledgements.indexOf(acknowledgement)}`,
        message: "The acknowledgement is stale for the current revision or warning evidence.",
      });
    }
  });

  if (issues.length > 0) {
    throw new ApiError(
      409,
      "ACKNOWLEDGEMENT_MISMATCH",
      "Warning acknowledgements must match the current revision and warning fingerprint.",
      issues,
    );
  }
}

export async function resolveStackInstallPlan(
  database: CatalogDatabase,
  request: StackResolveRequest,
  dependencies: StackResolutionDependencies = {},
) {
  return withLiveVerifiedSelections(
    database,
    request.selectionIds,
    dependencies.github ?? {},
    async (_transaction, selections) => {
      const blocked = selections
        .map((selection, index) => ({ selection, index }))
        .filter(({ selection }) => !selection.publicRow.selectable || !selection.plannerSkill);
      if (blocked.length > 0) {
        throw new ApiError(
          409,
          "SELECTION_NOT_ELIGIBLE",
          "One or more selected skills are not currently eligible for installation.",
          blocked.map(({ selection, index }) => ({
            path: `selectionIds.${index}`,
            message: selection.publicRow.gateReasons.join(", ") || "Selection is not eligible.",
          })),
        );
      }
      assertAcknowledgements(selections, request.acknowledgements);

      let plan: ReturnType<typeof createInstallPlan>;
      try {
        plan = createInstallPlan({
          selections: selections.map((selection) => selection.plannerSkill!),
          options: request.options,
        });
      } catch (error) {
        if (error instanceof InstallPlanError) {
          throw new ApiError(
            409,
            `INSTALL_PLAN_${error.code}`,
            error.message,
            error.fieldIssues,
          );
        }
        throw error;
      }

      return {
        id: plan.id,
        command: plan.command,
        selectionCount: plan.selectionCount,
        sourceCount: plan.sourceCount,
        runtime: {
          package: plan.runtime.package,
          minimumNodeVersion: plan.runtime.minimumNodeVersion,
        },
        semantics: {
          atomic: false as const,
          runtimeCompletenessVerified: false as const,
          sourceRevisionEnforced: false as const,
          pathScopeEnforced: true as const,
          partialInstallPossible: true as const,
          agentFailureMayExitZero: true as const,
          mutableSourceRacePossible: true as const,
        },
        warnings: [...plan.warnings],
        resolvedSkills: selections.map((selection) => ({
          id: selection.publicRow.id,
          name: selection.publicRow.name,
          compatibilityAdvisory: selection.publicRow.compatibilityAdvisory,
          source: selection.publicRow.sourceUrl,
          revision: selection.publicRow.immutableRef!,
          license: selection.publicRow.license,
          trust: selection.publicRow.trust as "pass" | "warn",
        })),
      };
    },
  );
}
