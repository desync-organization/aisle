import { createHash, randomUUID } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  isNotNull,
  like,
  ne,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import {
  persistedAuditRawSchema,
  persistedSkillRawSchema,
  type PersistedAuditRaw,
  type PersistedSkillRaw,
} from "../catalog/provider-raw";
import {
  CANONICAL_CATEGORY_SLUGS,
  SOURCE_CATEGORY_ATTRIBUTION,
  type CanonicalCategorySlug,
} from "../catalog/categories";
import { installSpecSchema } from "../catalog/source-contract";
import type {
  CatalogSelectionGateReason,
  CatalogTrustState,
} from "../marketplace/selection-gates";
import {
  packageEditorialSchema,
  packageBlueprintDigest,
  parsePackageBlueprint,
  type PackageBlueprint,
} from "../packages/package-blueprint";
import {
  PackageMemberEligibilityError,
  resolveEligiblePackageMember,
  type EligiblePackageMember,
  type PackageMemberEligibilityBinding,
} from "../packages/member-eligibility";
import type { CatalogDatabase } from "./client";
import {
  auditRecords,
  catalogSources,
  categories,
  packageMembers,
  packages,
  packageVersions,
  repositories,
  skillAliases,
  skillCategories,
  skillCategoryEvidence,
  skillCategoryObservations,
  skillDuplicates,
  skillRevisions,
  skills,
  sourceListings,
  syncRuns,
  trustAssessments,
  trustFindings,
  type lifecycleStates,
  type sourceFreshnessPolicies,
  type sourceModes,
} from "./schema";

type SourceMode = (typeof sourceModes)[number];
type SourceFreshnessPolicy = (typeof sourceFreshnessPolicies)[number];
type LifecycleState = (typeof lifecycleStates)[number];
type CatalogTransaction = Parameters<Parameters<CatalogDatabase["transaction"]>[0]>[0];
type TrustState = "unreviewed" | "pass" | "warn" | "fail" | "quarantined";
type TrustFindingInput = {
  code: string;
  severity: "info" | "warning" | "critical";
  path: string | null;
  message: string;
  evidence: string | null;
};
type TrustAssessmentWrite = {
  revisionId: string;
  immutableRef: string;
  contentHash: string;
  scanner: string;
  scannerVersion: string;
  state: TrustState;
  quarantineReason: string | null;
  findings: TrustFindingInput[];
  scannedAt: Date;
};

const trustStateRank: Record<TrustState, number> = {
  unreviewed: 0,
  pass: 1,
  warn: 2,
  fail: 3,
  quarantined: 4,
};
export type PackagePublicationErrorCode =
  | "MEMBER_NOT_FOUND"
  | "REVISION_MISMATCH"
  | "LICENSE_EVIDENCE_MISMATCH"
  | "TRUST_NOT_ELIGIBLE"
  | "PROVENANCE_MISMATCH"
  | "DUPLICATE_MEMBER"
  | "PACKAGE_SET_INVALID";

export class PackagePublicationError extends Error {
  constructor(
    readonly code: PackagePublicationErrorCode,
    readonly packageSlug: string,
    readonly memberPosition: number,
    message: string,
  ) {
    super(message);
    this.name = "PackagePublicationError";
  }
}

export type PublishedPackageSummary = Readonly<{
  id: string;
  slug: string;
  title: string;
  description: string;
  versionId: string;
  version: number;
  publishedAt: Date;
  memberCount: number;
  editorial: Record<string, unknown>;
  blueprintSchemaVersion: number;
  blueprintDigest: string;
}>;

export type PublishedPackagePageQuery = Readonly<{
  limit: number;
  sort: "name" | "recent";
  query?: string | null;
  category?: string | null;
  featured?: boolean;
  after?: Readonly<{ key: string; id: string }> | null;
}>;

export type PublishedPackagePage = Readonly<{
  items: readonly PublishedPackageSummary[];
  next: Readonly<{ key: string; id: string }> | null;
}>;

export type PackagePublicationResult = Readonly<{
  packageId: string;
  packageVersionId: string;
  slug: string;
  version: number;
  blueprintDigest: string;
  memberCount: number;
  publishedAt: Date;
  reused: boolean;
}>;

const packageEligibleLicenses = [
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "CC0-1.0",
  "Unlicense",
] as const;
const packageEligibleLicenseSet = new Set<string>(packageEligibleLicenses);
const CATEGORY_OBSERVATION_HISTORY_LIMIT = 4;

function stableId(namespace: string, value: string): string {
  return `${namespace}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function noLatestObservedFail() {
  return sql<boolean>`not exists (
    select 1
    from audit_records ar
    join source_listings sl on sl.id = ar.source_listing_id
    where sl.skill_id = ${skills.id}
      and ar.scope = 'observation'
      and ar.status = 'fail'
      and (
        ${skillRevisions.upstreamHash} is null
        or ar.upstream_content_hash = ${skillRevisions.upstreamHash}
      )
      and not exists (
        select 1 from audit_records newer
        where newer.source_listing_id = ar.source_listing_id
          and newer.provider = ar.provider
          and coalesce(newer.provider_slug, '') = coalesce(ar.provider_slug, '')
          and coalesce(newer.upstream_content_hash, '') = coalesce(ar.upstream_content_hash, '')
          and (
            newer.observed_at > ar.observed_at
            or (newer.observed_at = ar.observed_at and newer.id > ar.id)
          )
      )
  )`;
}

function hasSelectableTrust() {
  return sql<boolean>`exists (
    select 1 from trust_assessments selectable_trust
    where selectable_trust.revision_id = ${skillRevisions.id}
      and selectable_trust.immutable_ref = ${skillRevisions.immutableRef}
      and selectable_trust.content_hash = ${skillRevisions.contentHash}
      and selectable_trust.state in ('pass', 'warn')
  )`;
}

function hasNoBlockingTrust() {
  return sql<boolean>`not exists (
    select 1 from trust_assessments blocking_trust
    where blocking_trust.revision_id = ${skillRevisions.id}
      and blocking_trust.immutable_ref = ${skillRevisions.immutableRef}
      and blocking_trust.content_hash = ${skillRevisions.contentHash}
      and blocking_trust.state in ('fail', 'quarantined')
  )`;
}

function hasActiveSourceListing() {
  return sql<boolean>`exists (
    select 1 from source_listings active_listing
    join catalog_sources active_source on active_source.id = active_listing.source_id
    where active_listing.skill_id = ${skills.id}
      and active_listing.status in ('current', 'stale')
      and active_listing.source_hash = ${skillRevisions.upstreamHash}
      and active_source.enabled = 1
      and active_source.coverage_state in ('current', 'partial')
      and (
        active_source.freshness_policy = 'retain'
        or (
          active_source.freshness_policy = 'latest-completed-observation'
          and active_listing.last_completed_observation_run_id = (
            select completed_observation.id
            from sync_runs completed_observation
            where completed_observation.source_id = active_source.id
              and completed_observation.observation_sweep_complete = 1
              and completed_observation.finished_at is not null
              and completed_observation.status in ('succeeded', 'partial')
            order by completed_observation.finished_at desc,
              completed_observation.started_at desc,
              completed_observation.id desc
            limit 1
          )
        )
      )
  )`;
}

function hasRevisionBoundInstallSpecSql() {
  return sql<boolean>`case
    when json_valid(${skillRevisions.installSpecJson}) = 0 then 0
    when json_extract(${skillRevisions.installSpecJson}, '$.kind') = 'source' then
      json_type(${skillRevisions.installSpecJson}, '$.sourceUrl') = 'text'
      and length(trim(json_extract(${skillRevisions.installSpecJson}, '$.sourceUrl'))) > 0
      and json_extract(${skillRevisions.installSpecJson}, '$.sourceUrl') = ${skills.sourceUrl}
      and json_type(${skillRevisions.installSpecJson}, '$.immutableRef') = 'text'
      and length(trim(json_extract(${skillRevisions.installSpecJson}, '$.immutableRef'))) > 0
      and json_extract(${skillRevisions.installSpecJson}, '$.immutableRef') = ${skillRevisions.immutableRef}
      and json_type(${skillRevisions.installSpecJson}, '$.skillPath') = 'text'
      and length(trim(json_extract(${skillRevisions.installSpecJson}, '$.skillPath'))) > 0
      and json_extract(${skillRevisions.installSpecJson}, '$.skillPath') = ${skills.skillPath}
    when json_extract(${skillRevisions.installSpecJson}, '$.kind') = 'registry' then
      json_type(${skillRevisions.installSpecJson}, '$.registry') = 'text'
      and length(trim(json_extract(${skillRevisions.installSpecJson}, '$.registry'))) > 0
      and json_type(${skillRevisions.installSpecJson}, '$.identifier') = 'text'
      and length(trim(json_extract(${skillRevisions.installSpecJson}, '$.identifier'))) > 0
      and json_type(${skillRevisions.installSpecJson}, '$.version') = 'text'
      and length(trim(json_extract(${skillRevisions.installSpecJson}, '$.version'))) > 0
      and json_extract(${skillRevisions.installSpecJson}, '$.version') = ${skillRevisions.immutableRef}
    else 0
  end`;
}

function hasLicenseEvidence() {
  return sql<boolean>`
    json_valid(coalesce(${skillRevisions.metadataJson}, '{}')) = 1
    and json_type(${skillRevisions.metadataJson}, '$.licenseEvidence.path') = 'text'
    and length(trim(json_extract(${skillRevisions.metadataJson}, '$.licenseEvidence.path'))) > 0
    and json_type(${skillRevisions.metadataJson}, '$.licenseEvidence.sha256') = 'text'
    and length(json_extract(${skillRevisions.metadataJson}, '$.licenseEvidence.sha256')) = 64
    and lower(json_extract(${skillRevisions.metadataJson}, '$.licenseEvidence.sha256'))
      not glob '*[^0-9a-f]*'
  `;
}

function hasRevisionBoundInstallSpec(
  value: unknown,
  identity: Readonly<{
    sourceUrl: string;
    skillPath: string;
    immutableRef: string | null;
  }>,
): boolean {
  const parsed = installSpecSchema.safeParse(value);
  if (!parsed.success || !identity.immutableRef) return false;
  if (parsed.data.kind === "source") {
    return (
      parsed.data.sourceUrl === identity.sourceUrl &&
      parsed.data.skillPath === identity.skillPath &&
      parsed.data.immutableRef === identity.immutableRef
    );
  }
  return parsed.data.version === identity.immutableRef;
}

function hasValidLicenseEvidence(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = (value as Record<string, unknown>).licenseEvidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
  const { path, sha256 } = evidence as Record<string, unknown>;
  return (
    typeof path === "string" &&
    path.trim().length > 0 &&
    typeof sha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(sha256)
  );
}

export interface CatalogSearchOptions {
  id?: string;
  query?: string;
  category?: string;
  lifecycle?: LifecycleState[];
  includeUnselectable?: boolean;
  limit?: number;
  offset?: number;
}

export interface SourceDescriptorInput {
  id: string;
  name: string;
  baseUrl: string;
  mode: SourceMode;
  freshnessPolicy?: SourceFreshnessPolicy;
  upstreamIdentifier: string;
  termsUrl?: string | null;
  enabled?: boolean;
  initialCoverageState?: string;
  knownExclusions?: readonly string[];
}

export interface CanonicalSkillInput {
  fence: CatalogMutationFence;
  canonicalKey: string;
  provider: string;
  sourceUrl: string;
  skillPath: string;
  upstreamName: string;
  upstreamDescription: string;
  compatibility: string | null;
  license: string;
  revisionMetadata?: Record<string, unknown>;
  officialProvenance: boolean;
  installUrl: string;
  installSpec: Record<string, unknown>;
  immutableRef: string;
  contentHash: string;
  upstreamHash: string;
  aliases: string[];
  listingId: string;
  repository: {
    provider: string;
    url: string;
    owner: string | null;
    name: string | null;
    visibility: "public";
    defaultBranch: string | null;
  } | null;
  trustAssessment?: {
    scanner: string;
    scannerVersion: string;
    state: "unreviewed" | "pass" | "warn" | "fail" | "quarantined";
    quarantineReason: string | null;
    findings: Array<{
      code: string;
      severity: "info" | "warning" | "critical";
      path: string | null;
      message: string;
      evidence: string | null;
    }>;
  };
  upstreamAudits?: Array<{
    provider: string;
    providerSlug: string;
    status: "pass" | "warn" | "fail";
    summary: string;
    scannerVersion: string | null;
    raw: PersistedAuditRaw;
  }>;
}

export interface CatalogMutationFence {
  sourceId: string;
  runId: string;
  leaseToken: string;
}

export class CatalogSyncLeaseConflictError extends Error {
  constructor(sourceId: string) {
    super(`A catalog sync is already running for ${sourceId}`);
    this.name = "CatalogSyncLeaseConflictError";
  }
}

export class CatalogSyncLeaseLostError extends Error {
  constructor(runId: string) {
    super(`Catalog sync lease was lost for run ${runId}`);
    this.name = "CatalogSyncLeaseLostError";
  }
}

export class CatalogImmutableRevisionConflictError extends Error {
  constructor(immutableRef: string) {
    super(`Immutable revision ${immutableRef} changed content hash; listing was detached`);
    this.name = "CatalogImmutableRevisionConflictError";
  }
}

export class CatalogRepository {
  constructor(readonly db: CatalogDatabase) {}

  private async assertActiveSyncLease(
    transaction: CatalogTransaction,
    fence: CatalogMutationFence,
  ): Promise<void> {
    const [lease] = await transaction
      .select({ id: syncRuns.id })
      .from(syncRuns)
      .innerJoin(catalogSources, eq(catalogSources.id, syncRuns.sourceId))
      .where(
        and(
          eq(syncRuns.id, fence.runId),
          eq(syncRuns.sourceId, fence.sourceId),
          eq(syncRuns.status, "running"),
          eq(syncRuns.leaseToken, fence.leaseToken),
          gt(syncRuns.leaseExpiresAt, new Date()),
          eq(catalogSources.enabled, true),
          ne(catalogSources.coverageState, "not-configured"),
        ),
      )
      .limit(1);
    if (!lease) throw new CatalogSyncLeaseLostError(fence.runId);
  }

  private async recomputeSkillLifecycleInTransaction(
    transaction: CatalogTransaction,
    skillId: string,
    now = new Date(),
  ): Promise<void> {
    const rows = await transaction
      .select({ status: sourceListings.status })
      .from(sourceListings)
      .where(eq(sourceListings.skillId, skillId));
    const statuses = new Set(rows.map((row) => row.status));
    const lifecycle: LifecycleState = rows.length === 0
      ? "stale"
      : statuses.has("current")
        ? "current"
        : statuses.has("stale")
          ? "stale"
          : statuses.has("unavailable")
            ? "unavailable"
            : "removed";
    await transaction
      .update(skills)
      .set({ lifecycle, updatedAt: now })
      .where(eq(skills.id, skillId));
  }

  private async recomputeSkillCategoryMaterializationInTransaction(
    transaction: CatalogTransaction,
    skillIds: Iterable<string>,
  ): Promise<void> {
    const orderedSkillIds = [...new Set(skillIds)].sort();
    const chunkSize = 25;
    for (let offset = 0; offset < orderedSkillIds.length; offset += chunkSize) {
      const chunk = orderedSkillIds.slice(offset, offset + chunkSize);
      const eligible = await transaction
        .selectDistinct({
          skillId: skillCategoryObservations.skillId,
          categoryId: skillCategoryEvidence.categoryId,
          categoryOrder: categories.sortOrder,
          categorySlug: categories.slug,
        })
        .from(skillCategoryEvidence)
        .innerJoin(
          skillCategoryObservations,
          and(
            eq(
              skillCategoryObservations.sourceListingId,
              skillCategoryEvidence.sourceListingId,
            ),
            eq(
              skillCategoryObservations.observedRunId,
              skillCategoryEvidence.observedRunId,
            ),
          ),
        )
        .innerJoin(
          sourceListings,
          and(
            eq(sourceListings.id, skillCategoryObservations.sourceListingId),
            eq(sourceListings.skillId, skillCategoryObservations.skillId),
            eq(sourceListings.sourceHash, skillCategoryObservations.sourceHash),
          ),
        )
        .innerJoin(catalogSources, eq(catalogSources.id, sourceListings.sourceId))
        .innerJoin(
          skillRevisions,
          and(
            eq(skillRevisions.id, skillCategoryObservations.revisionId),
            eq(skillRevisions.skillId, skillCategoryObservations.skillId),
            eq(skillRevisions.upstreamHash, skillCategoryObservations.sourceHash),
            eq(skillRevisions.isCurrent, true),
          ),
        )
        .innerJoin(
          syncRuns,
          and(
            eq(syncRuns.id, skillCategoryObservations.observedRunId),
            eq(syncRuns.sourceId, catalogSources.id),
          ),
        )
        .innerJoin(categories, eq(categories.id, skillCategoryEvidence.categoryId))
        .where(
          and(
            inArray(skillCategoryObservations.skillId, chunk),
            inArray(sourceListings.status, ["current", "stale"]),
            eq(catalogSources.enabled, true),
            inArray(catalogSources.coverageState, ["current", "partial"]),
            sql<boolean>`(
              (
                ${catalogSources.freshnessPolicy} = 'retain'
                and ${skillCategoryObservations.observedRunId} = (
                  select retain_category_observation.observed_run_id
                  from skill_category_observations retain_category_observation
                  join sync_runs retain_category_run
                    on retain_category_run.id = retain_category_observation.observed_run_id
                  where retain_category_observation.source_listing_id = ${sourceListings.id}
                    and retain_category_observation.skill_id = ${sourceListings.skillId}
                    and retain_category_observation.revision_id = ${skillRevisions.id}
                    and retain_category_observation.source_hash = ${sourceListings.sourceHash}
                    and retain_category_run.source_id = ${catalogSources.id}
                    and retain_category_run.finished_at is not null
                    and retain_category_run.status in ('succeeded', 'partial')
                  order by retain_category_run.finished_at desc,
                    retain_category_run.started_at desc,
                    retain_category_run.id desc
                  limit 1
                )
              )
              or (
                ${catalogSources.freshnessPolicy} = 'latest-completed-observation'
                and ${skillCategoryObservations.observedRunId} = ${sourceListings.lastCompletedObservationRunId}
                and ${sourceListings.lastCompletedObservationRunId} = (
                  select completed_category_observation.id
                  from sync_runs completed_category_observation
                  where completed_category_observation.source_id = ${catalogSources.id}
                    and completed_category_observation.observation_sweep_complete = 1
                    and completed_category_observation.finished_at is not null
                    and completed_category_observation.status in ('succeeded', 'partial')
                  order by completed_category_observation.finished_at desc,
                    completed_category_observation.started_at desc,
                    completed_category_observation.id desc
                  limit 1
                )
              )
            )`,
          ),
        )
        .orderBy(
          asc(skillCategoryObservations.skillId),
          asc(categories.sortOrder),
          asc(categories.slug),
          asc(skillCategoryEvidence.categoryId),
        );

      await transaction
        .delete(skillCategories)
        .where(
          and(
            inArray(skillCategories.skillId, chunk),
            eq(skillCategories.attribution, SOURCE_CATEGORY_ATTRIBUTION),
          ),
        );
      if (eligible.length) {
        await transaction
          .insert(skillCategories)
          .values(
            eligible.map(({ skillId, categoryId }) => ({
              skillId,
              categoryId,
              attribution: SOURCE_CATEGORY_ATTRIBUTION,
            })),
          )
          .onConflictDoNothing();
      }
    }
  }

  private async recomputeSourceCategoryMaterializationInTransaction(
    transaction: CatalogTransaction,
    sourceId: string,
  ): Promise<void> {
    const affected = await transaction
      .selectDistinct({ skillId: sourceListings.skillId })
      .from(sourceListings)
      .where(
        and(
          eq(sourceListings.sourceId, sourceId),
          isNotNull(sourceListings.skillId),
        ),
      );
    await this.recomputeSkillCategoryMaterializationInTransaction(
      transaction,
      affected.flatMap(({ skillId }) => skillId ? [skillId] : []),
    );
  }

  private async pruneSkillCategoryObservationHistoryInTransaction(
    transaction: CatalogTransaction,
    sourceId: string,
  ): Promise<void> {
    const observations = await transaction
      .select({
        sourceListingId: skillCategoryObservations.sourceListingId,
        observedRunId: skillCategoryObservations.observedRunId,
        lastCompletedObservationRunId: sourceListings.lastCompletedObservationRunId,
        runStatus: syncRuns.status,
        runFinishedAt: syncRuns.finishedAt,
      })
      .from(skillCategoryObservations)
      .innerJoin(
        sourceListings,
        eq(sourceListings.id, skillCategoryObservations.sourceListingId),
      )
      .innerJoin(syncRuns, eq(syncRuns.id, skillCategoryObservations.observedRunId))
      .where(eq(sourceListings.sourceId, sourceId))
      .orderBy(
        asc(skillCategoryObservations.sourceListingId),
        desc(syncRuns.finishedAt),
        desc(syncRuns.startedAt),
        desc(syncRuns.id),
      );

    const terminalCounts = new Map<string, number>();
    const removable: Array<{ sourceListingId: string; observedRunId: string }> = [];
    for (const observation of observations) {
      const preserveCertificate =
        observation.observedRunId === observation.lastCompletedObservationRunId;
      const preserveRunning = observation.runStatus === "running";
      const terminal =
        observation.runFinishedAt !== null &&
        ["succeeded", "partial"].includes(observation.runStatus);
      const retainedTerminalCount = terminalCounts.get(observation.sourceListingId) ?? 0;
      const preserveRecentTerminal =
        terminal && retainedTerminalCount < CATEGORY_OBSERVATION_HISTORY_LIMIT;
      if (terminal) {
        terminalCounts.set(observation.sourceListingId, retainedTerminalCount + 1);
      }
      if (preserveCertificate || preserveRunning || preserveRecentTerminal) continue;
      removable.push({
        sourceListingId: observation.sourceListingId,
        observedRunId: observation.observedRunId,
      });
    }

    const chunkSize = 25;
    for (let offset = 0; offset < removable.length; offset += chunkSize) {
      const chunk = removable.slice(offset, offset + chunkSize);
      const condition = or(
        ...chunk.map((observation) =>
          and(
            eq(
              skillCategoryObservations.sourceListingId,
              observation.sourceListingId,
            ),
            eq(
              skillCategoryObservations.observedRunId,
              observation.observedRunId,
            ),
          )),
      );
      if (condition) await transaction.delete(skillCategoryObservations).where(condition);
    }
  }

  private async markListingUnresolvedInTransaction(
    transaction: CatalogTransaction,
    fence: CatalogMutationFence,
    listingId: string,
    sourceHash: string | null,
    now = new Date(),
  ): Promise<boolean> {
    const [listing] = await transaction
      .select({ skillId: sourceListings.skillId })
      .from(sourceListings)
      .where(
        and(
          eq(sourceListings.id, listingId),
          eq(sourceListings.sourceId, fence.sourceId),
        ),
      )
      .limit(1);
    if (!listing) return false;
    await transaction
      .delete(skillCategoryObservations)
      .where(eq(skillCategoryObservations.sourceListingId, listingId));
    await transaction
      .update(sourceListings)
      .set({
        skillId: null,
        status: "unresolved",
        sourceHash,
        lastCompletedObservationRunId: null,
        duplicateIndicator: false,
        lastSeenRunId: fence.runId,
        lastSeenAt: now,
      })
      .where(
        and(
          eq(sourceListings.id, listingId),
          eq(sourceListings.sourceId, fence.sourceId),
        ),
      );
    if (listing.skillId) {
      await this.recomputeSkillLifecycleInTransaction(transaction, listing.skillId, now);
      await this.recomputeSkillCategoryMaterializationInTransaction(
        transaction,
        [listing.skillId],
      );
    }
    return true;
  }

  private async writeMonotonicTrustAssessment(
    transaction: CatalogTransaction,
    input: TrustAssessmentWrite,
  ): Promise<boolean> {
    if (
      input.findings.some((finding) => finding.severity === "critical") &&
      !["fail", "quarantined"].includes(input.state)
    ) {
      throw new Error("Critical trust findings require a fail or quarantined state");
    }

    const [revision] = await transaction
      .select({
        immutableRef: skillRevisions.immutableRef,
        contentHash: skillRevisions.contentHash,
      })
      .from(skillRevisions)
      .where(eq(skillRevisions.id, input.revisionId))
      .limit(1);
    if (
      !revision ||
      revision.immutableRef !== input.immutableRef ||
      revision.contentHash !== input.contentHash
    ) {
      throw new Error("Trust assessment did not match the immutable revision and content hash");
    }

    const [existing] = await transaction
      .select({
        id: trustAssessments.id,
        scannedAt: trustAssessments.scannedAt,
        state: trustAssessments.state,
      })
      .from(trustAssessments)
      .where(
        and(
          eq(trustAssessments.revisionId, input.revisionId),
          eq(trustAssessments.scanner, input.scanner),
        ),
      )
      .limit(1);
    if (
      existing &&
      (existing.scannedAt > input.scannedAt ||
        (existing.scannedAt.getTime() === input.scannedAt.getTime() &&
          trustStateRank[existing.state] >= trustStateRank[input.state]))
    ) {
      return false;
    }

    const assessmentId =
      existing?.id ?? stableId("assessment", `${input.revisionId}:${input.scanner}`);
    await transaction
      .insert(trustAssessments)
      .values({
        id: assessmentId,
        revisionId: input.revisionId,
        scanner: input.scanner,
        scannerVersion: input.scannerVersion,
        immutableRef: input.immutableRef,
        contentHash: input.contentHash,
        state: input.state,
        quarantineReason: input.quarantineReason,
        scannedAt: input.scannedAt,
      })
      .onConflictDoUpdate({
        target: [trustAssessments.revisionId, trustAssessments.scanner],
        set: {
          scannerVersion: input.scannerVersion,
          immutableRef: input.immutableRef,
          contentHash: input.contentHash,
          state: input.state,
          quarantineReason: input.quarantineReason,
          scannedAt: input.scannedAt,
        },
      });

    await transaction
      .delete(trustFindings)
      .where(eq(trustFindings.assessmentId, assessmentId));
    for (const [index, finding] of input.findings.entries()) {
      await transaction.insert(trustFindings).values({
        id: stableId(
          "finding",
          `${assessmentId}:${index}:${finding.code}:${finding.path ?? ""}`,
        ),
        assessmentId,
        ...finding,
      });
    }
    return true;
  }

  async upsertCategory(input: {
    slug: string;
    name: string;
    description: string;
    sortOrder?: number;
  }): Promise<void> {
    const id = stableId("category", input.slug);
    const fallbackOrder = 100;
    await this.db
      .insert(categories)
      .values({ id, ...input, sortOrder: input.sortOrder ?? fallbackOrder })
      .onConflictDoUpdate({
        target: categories.slug,
        set: {
          name: input.name,
          description: input.description,
          sortOrder: input.sortOrder ?? fallbackOrder,
        },
      });
  }

  async replaceSkillCategoryEvidence(input: {
    fence: CatalogMutationFence;
    listingId: string;
    skillId: string;
    revisionId: string;
    sourceHash: string;
    categorySlugs: readonly CanonicalCategorySlug[];
  }): Promise<void> {
    const requested = [...new Set(input.categorySlugs)];
    const allowed = new Set<string>(CANONICAL_CATEGORY_SLUGS);
    if (requested.some((slug) => !allowed.has(slug))) {
      throw new Error("Category assignment referenced a non-canonical taxonomy slug");
    }

    await this.db.transaction(async (transaction) => {
      await this.assertActiveSyncLease(transaction, input.fence);
      const [binding] = await transaction
        .select({
          listingId: sourceListings.id,
          revisionId: skillRevisions.id,
        })
        .from(sourceListings)
        .innerJoin(
          skillRevisions,
          and(
            eq(skillRevisions.id, input.revisionId),
            eq(skillRevisions.skillId, input.skillId),
            eq(skillRevisions.upstreamHash, input.sourceHash),
            eq(skillRevisions.isCurrent, true),
          ),
        )
        .where(
          and(
            eq(sourceListings.id, input.listingId),
            eq(sourceListings.sourceId, input.fence.sourceId),
            eq(sourceListings.lastSeenRunId, input.fence.runId),
            eq(sourceListings.skillId, input.skillId),
            eq(sourceListings.status, "current"),
            eq(sourceListings.sourceHash, input.sourceHash),
          ),
        )
        .limit(1);
      if (!binding) {
        throw new Error("Category assignment was not bound to the active source observation");
      }

      const resolved = requested.length
        ? await transaction
            .select({ id: categories.id, slug: categories.slug })
            .from(categories)
            .where(inArray(categories.slug, requested))
        : [];
      if (resolved.length !== requested.length) {
        throw new Error("Canonical category taxonomy is not fully seeded");
      }

      await transaction
        .delete(skillCategoryObservations)
        .where(
          and(
            eq(skillCategoryObservations.sourceListingId, input.listingId),
            eq(skillCategoryObservations.observedRunId, input.fence.runId),
          ),
        );
      const observedAt = new Date();
      await transaction.insert(skillCategoryObservations).values({
        sourceListingId: input.listingId,
        observedRunId: input.fence.runId,
        skillId: input.skillId,
        revisionId: input.revisionId,
        sourceHash: input.sourceHash,
        observedAt,
      });
      if (resolved.length) {
        await transaction
          .insert(skillCategoryEvidence)
          .values(
            resolved.map((category) => ({
              sourceListingId: input.listingId,
              observedRunId: input.fence.runId,
              categoryId: category.id,
            })),
          );
      }
      await this.recomputeSkillCategoryMaterializationInTransaction(
        transaction,
        [input.skillId],
      );
    });
  }

  async upsertSource(input: SourceDescriptorInput): Promise<void> {
    const now = new Date();
    await this.db.transaction(async (transaction) => {
      const [previous] = await transaction
        .select({
          enabled: catalogSources.enabled,
          freshnessPolicy: catalogSources.freshnessPolicy,
        })
        .from(catalogSources)
        .where(eq(catalogSources.id, input.id))
        .limit(1);
      const enabled = input.enabled ?? true;
      const freshnessPolicy = input.freshnessPolicy ?? "retain";
      await transaction
        .insert(catalogSources)
        .values({
          ...input,
          termsUrl: input.termsUrl ?? null,
          enabled,
          freshnessPolicy,
          coverageState: input.initialCoverageState ?? "not-synced",
          exclusionsJson: input.knownExclusions ? [...input.knownExclusions] : [],
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: catalogSources.id,
          set: {
            name: input.name,
            baseUrl: input.baseUrl,
            mode: input.mode,
            freshnessPolicy,
            upstreamIdentifier: input.upstreamIdentifier,
            termsUrl: input.termsUrl ?? null,
            enabled,
            updatedAt: now,
          },
        });
      if (
        previous &&
        (previous.enabled !== enabled || previous.freshnessPolicy !== freshnessPolicy)
      ) {
        const affected = await transaction
          .selectDistinct({ skillId: sourceListings.skillId })
          .from(sourceListings)
          .where(
            and(
              eq(sourceListings.sourceId, input.id),
              isNotNull(sourceListings.skillId),
            ),
          );
        await this.recomputeSkillCategoryMaterializationInTransaction(
          transaction,
          affected.flatMap(({ skillId }) => skillId ? [skillId] : []),
        );
      }
    });
  }

  async markSourceNotConfigured(sourceId: string, exclusions: readonly string[]): Promise<void> {
    await this.db.transaction(async (transaction) => {
      const affected = await transaction
        .selectDistinct({ skillId: sourceListings.skillId })
        .from(sourceListings)
        .where(
          and(
            eq(sourceListings.sourceId, sourceId),
            isNotNull(sourceListings.skillId),
          ),
        );
      await transaction
        .update(catalogSources)
        .set({
          coverageState: "not-configured",
          lastSuccessfulSyncAt: null,
          lastError: null,
          exclusionsJson: [...exclusions],
          updatedAt: new Date(),
        })
        .where(eq(catalogSources.id, sourceId));
      await this.recomputeSkillCategoryMaterializationInTransaction(
        transaction,
        affected.flatMap(({ skillId }) => skillId ? [skillId] : []),
      );
    });
  }

  async search(options: CatalogSearchOptions = {}) {
    const requestedLimit = Number.isFinite(options.limit) ? Math.trunc(options.limit ?? 24) : 24;
    const requestedOffset = Number.isFinite(options.offset) ? Math.trunc(options.offset ?? 0) : 0;
    const limit = Math.min(Math.max(requestedLimit, 1), 100);
    const offset = Math.min(Math.max(requestedOffset, 0), 100_000);
    const lifecycle = options.lifecycle ?? (options.includeUnselectable ? ["current", "stale"] : ["current"]);
    const conditions = [
      eq(skills.public, true),
      eq(skills.internal, false),
      inArray(skills.lifecycle, lifecycle),
    ];

    if (!options.includeUnselectable) {
      conditions.push(
        ne(skillRevisions.immutableRef, ""),
        ne(skillRevisions.contentHash, ""),
        isNotNull(skillRevisions.upstreamHash),
        ne(skillRevisions.upstreamHash, ""),
        hasRevisionBoundInstallSpecSql(),
        hasActiveSourceListing(),
        inArray(skillRevisions.license, packageEligibleLicenses),
        hasLicenseEvidence(),
        hasNoBlockingTrust(),
        hasSelectableTrust(),
        noLatestObservedFail(),
      );
    }

    if (options.id) {
      conditions.push(eq(skills.id, options.id));
    }

    if (options.query?.trim()) {
      const pattern = `%${options.query.trim()}%`;
      conditions.push(
        or(like(skills.upstreamName, pattern), like(skills.upstreamDescription, pattern))!,
      );
    }

    if (options.category) {
      conditions.push(eq(categories.slug, options.category));
    }

    const rows = await this.db
      .select({
        id: skills.id,
        name: skills.upstreamName,
        description: skills.upstreamDescription,
        provider: skills.provider,
        sourceUrl: skills.sourceUrl,
        skillPath: skills.skillPath,
        compatibility: skills.compatibility,
        lifecycle: skills.lifecycle,
        officialProvenance: skills.officialProvenance,
        revisionId: skillRevisions.id,
        immutableRef: skillRevisions.immutableRef,
        contentHash: skillRevisions.contentHash,
        upstreamHash: skillRevisions.upstreamHash,
        installSpec: skillRevisions.installSpecJson,
        license: sql<string>`coalesce(${skillRevisions.license}, ${skills.license}, 'unknown')`,
        revisionMetadata: skillRevisions.metadataJson,
        trustState: sql<CatalogTrustState>`
          case
            when exists (
              select 1 from trust_assessments ta
              where ta.revision_id = ${skillRevisions.id}
                and ta.immutable_ref = ${skillRevisions.immutableRef}
                and ta.content_hash = ${skillRevisions.contentHash}
                and ta.state in ('fail', 'quarantined')
            ) then 'blocked'
            when exists (
              select 1 from trust_assessments ta
              where ta.revision_id = ${skillRevisions.id}
                and ta.immutable_ref = ${skillRevisions.immutableRef}
                and ta.content_hash = ${skillRevisions.contentHash}
                and ta.state = 'warn'
            ) then 'warn'
            when exists (
              select 1 from trust_assessments ta
              where ta.revision_id = ${skillRevisions.id}
                and ta.immutable_ref = ${skillRevisions.immutableRef}
                and ta.content_hash = ${skillRevisions.contentHash}
                and ta.state = 'pass'
            ) then 'pass'
            else 'unreviewed'
          end
        `,
        activeSource: hasActiveSourceListing(),
        cleanUpstreamAudit: noLatestObservedFail(),
        installs: sql<number>`coalesce(max(${sourceListings.installs}), 0)`,
      })
      .from(skills)
      .leftJoin(
        skillRevisions,
        and(eq(skillRevisions.skillId, skills.id), eq(skillRevisions.isCurrent, true)),
      )
      .leftJoin(sourceListings, eq(sourceListings.skillId, skills.id))
      .leftJoin(skillCategories, eq(skillCategories.skillId, skills.id))
      .leftJoin(categories, eq(categories.id, skillCategories.categoryId))
      .where(and(...conditions))
      .groupBy(skills.id, skillRevisions.id)
      .orderBy(desc(sql`coalesce(max(${sourceListings.installs}), 0)`), asc(skills.upstreamName))
      .limit(limit)
      .offset(offset);

    return rows
      .map((row) => {
        const gateReasons: CatalogSelectionGateReason[] = [];
        if (row.lifecycle !== "current") gateReasons.push("lifecycle-not-current");
        if (
          !row.revisionId ||
          !row.immutableRef?.trim() ||
          !row.contentHash?.trim() ||
          !row.upstreamHash?.trim()
        ) {
          gateReasons.push("revision-evidence-missing");
        }
        if (!hasRevisionBoundInstallSpec(row.installSpec, row)) {
          gateReasons.push("install-unresolved");
        }
        if (!Boolean(row.activeSource)) gateReasons.push("source-inactive");
        if (!packageEligibleLicenseSet.has(row.license)) gateReasons.push("license-not-eligible");
        if (!hasValidLicenseEvidence(row.revisionMetadata)) {
          gateReasons.push("license-evidence-missing");
        }
        if (row.trustState === "blocked") gateReasons.push("trust-blocked");
        if (row.trustState === "unreviewed") gateReasons.push("trust-pending");
        if (!Boolean(row.cleanUpstreamAudit)) gateReasons.push("upstream-audit-failed");

        return {
          ...row,
          selectable: gateReasons.length === 0,
          gateReasons,
        };
      })
      .filter((row) => options.includeUnselectable || row.selectable);
  }

  async facets() {
    const lifecycle = await this.db
      .select({ key: skills.lifecycle, count: sql<number>`count(*)` })
      .from(skills)
      .where(and(eq(skills.public, true), eq(skills.internal, false)))
      .groupBy(skills.lifecycle)
      .orderBy(asc(skills.lifecycle));

    const category = await this.db
      .select({
        key: categories.slug,
        name: categories.name,
        count: sql<number>`count(${skills.id})`,
      })
      .from(categories)
      .leftJoin(skillCategories, eq(skillCategories.categoryId, categories.id))
      .leftJoin(
        skills,
        and(
          eq(skills.id, skillCategories.skillId),
          eq(skills.public, true),
          eq(skills.internal, false),
          ne(skills.lifecycle, "removed"),
        ),
      )
      .groupBy(categories.id)
      .orderBy(asc(categories.sortOrder), asc(categories.name));

    return { lifecycle, category };
  }

  /**
   * Resolves and publishes one editorial blueprint in a single database
   * transaction. No skill instructions or upstream response bodies are
   * copied into package storage: a version contains only editorial metadata
   * and exact canonical skill/revision foreign keys.
   */
  private async resolveBoundPackageMember(
    transaction: CatalogTransaction,
    binding: PackageMemberEligibilityBinding,
    packageSlug: string,
    position: number,
  ): Promise<EligiblePackageMember> {
    try {
      return await resolveEligiblePackageMember(transaction, binding);
    } catch (error) {
      if (error instanceof PackageMemberEligibilityError) {
        throw new PackagePublicationError(
          error.code,
          packageSlug,
          position,
          error.message,
        );
      }
      throw error;
    }
  }

  private async publishBlueprintInTransaction(
    transaction: CatalogTransaction,
    blueprint: PackageBlueprint,
    now: Date,
  ): Promise<PackagePublicationResult> {
    const digest = packageBlueprintDigest(blueprint);
    const resolved: Array<{
      position: number;
      selectedByDefault: true;
      binding: PackageMemberEligibilityBinding;
      member: EligiblePackageMember;
    }> = [];
    const selectedSkillIds = new Set<string>();
    const selectedContentHashes = new Set<string>();

    for (const blueprintMember of [...blueprint.members].sort(
      (left, right) => left.position - right.position,
    )) {
      if (!blueprintMember.observedSource) {
        throw new PackagePublicationError(
          "REVISION_MISMATCH",
          blueprint.slug,
          blueprintMember.position,
          "A package member requires an observed public branch head before publication.",
        );
      }
      const binding: PackageMemberEligibilityBinding = {
        repositoryUrl: blueprintMember.locator.repositoryUrl,
        skillPath: blueprintMember.locator.skillPath,
        upstreamSkillName: blueprintMember.locator.upstreamSkillName,
        observedHead: blueprintMember.observedSource.headSha,
        observedLicense: blueprintMember.observedLicense.spdx,
        licenseEvidenceClass: blueprintMember.observedLicense.evidenceClass,
        licenseEvidencePath: blueprintMember.observedLicense.evidencePath,
        publisherClass: blueprintMember.publisherClass,
      };
      const member = await this.resolveBoundPackageMember(
        transaction,
        binding,
        blueprint.slug,
        blueprintMember.position,
      );
      if (
        selectedSkillIds.has(member.skillId) ||
        selectedContentHashes.has(member.contentHash)
      ) {
        throw new PackagePublicationError(
          "DUPLICATE_MEMBER",
          blueprint.slug,
          blueprintMember.position,
          "A package cannot contain duplicate canonical skills or mirrored artifact content.",
        );
      }
      selectedSkillIds.add(member.skillId);
      selectedContentHashes.add(member.contentHash);
      resolved.push({
        position: blueprintMember.position,
        selectedByDefault: blueprintMember.defaultSelected,
        binding,
        member,
      });
    }

    const [existingPackage] = await transaction
      .select({
        id: packages.id,
        title: packages.title,
        description: packages.description,
        published: packages.published,
      })
      .from(packages)
      .where(eq(packages.slug, blueprint.slug))
      .limit(1);
    const expectedPackageId = stableId("package", blueprint.slug);
    if (existingPackage && existingPackage.id !== expectedPackageId) {
      throw new PackagePublicationError(
        "REVISION_MISMATCH",
        blueprint.slug,
        0,
        "An existing package slug is not bound to its deterministic canonical ID.",
      );
    }
    const packageId = expectedPackageId;
    const packageVersionId = stableId(
      "package-version",
      packageId + ":" + digest,
    );
    const [latestPublishedVersion] = await transaction
      .select({
        id: packageVersions.id,
        version: packageVersions.version,
      })
      .from(packageVersions)
      .where(
        and(
          eq(packageVersions.packageId, packageId),
          isNotNull(packageVersions.publishedAt),
        ),
      )
      .orderBy(desc(packageVersions.version))
      .limit(1);
    const [existingVersion] = await transaction
      .select({
        id: packageVersions.id,
        version: packageVersions.version,
        blueprintSchemaVersion: packageVersions.blueprintSchemaVersion,
        blueprintDigest: packageVersions.blueprintDigest,
        editorial: packageVersions.editorialJson,
        publishedAt: packageVersions.publishedAt,
      })
      .from(packageVersions)
      .where(
        and(
          eq(packageVersions.id, packageVersionId),
          eq(packageVersions.packageId, packageId),
        ),
      )
      .limit(1);

    if (existingVersion) {
      const existingMembers = await transaction
        .select({
          skillId: packageMembers.skillId,
          revisionId: packageMembers.revisionId,
          position: packageMembers.position,
          selectedByDefault: packageMembers.selectedByDefault,
          repositoryUrl: packageMembers.upstreamRepositoryUrl,
          skillPath: packageMembers.upstreamSkillPath,
          upstreamSkillName: packageMembers.upstreamSkillName,
          observedHead: packageMembers.observedHead,
          observedLicense: packageMembers.observedLicense,
          licenseEvidenceClass: packageMembers.licenseEvidenceClass,
          licenseEvidencePath: packageMembers.licenseEvidencePath,
          publisherClass: packageMembers.publisherClass,
        })
        .from(packageMembers)
        .where(eq(packageMembers.packageVersionId, packageVersionId))
        .orderBy(asc(packageMembers.position));
      const membersMatch =
        existingMembers.length === resolved.length &&
        existingMembers.every((stored, index) => {
          const expected = resolved[index];
          return (
            expected !== undefined &&
            stored.skillId === expected.member.skillId &&
            stored.revisionId === expected.member.revisionId &&
            stored.position === expected.position &&
            stored.selectedByDefault === expected.selectedByDefault &&
            stored.repositoryUrl === expected.binding.repositoryUrl &&
            stored.skillPath === expected.binding.skillPath &&
            stored.upstreamSkillName === expected.binding.upstreamSkillName &&
            stored.observedHead === expected.binding.observedHead &&
            stored.observedLicense === expected.binding.observedLicense &&
            stored.licenseEvidenceClass === expected.binding.licenseEvidenceClass &&
            stored.licenseEvidencePath === expected.binding.licenseEvidencePath &&
            stored.publisherClass === expected.binding.publisherClass
          );
        });
      const storedEditorial = packageEditorialSchema.safeParse(existingVersion.editorial);
      const editorialMatches =
        storedEditorial.success &&
        JSON.stringify(storedEditorial.data) === JSON.stringify(blueprint.editorial);
      if (
        latestPublishedVersion?.id !== existingVersion.id ||
        existingVersion.publishedAt === null ||
        existingVersion.blueprintSchemaVersion !== blueprint.schemaVersion ||
        existingVersion.blueprintDigest !== digest ||
        !editorialMatches ||
        !membersMatch ||
        existingPackage?.published !== true ||
        existingPackage.title !== blueprint.editorial.title ||
        existingPackage.description !== blueprint.editorial.summary
      ) {
        throw new PackagePublicationError(
          "REVISION_MISMATCH",
          blueprint.slug,
          0,
          "An old or inconsistent version cannot be reused or overwrite current package metadata.",
        );
      }
      return {
        packageId,
        packageVersionId,
        slug: blueprint.slug,
        version: existingVersion.version,
        blueprintDigest: digest,
        memberCount: resolved.length,
        publishedAt: existingVersion.publishedAt,
        reused: true,
      };
    }

    const [latestVersion] = await transaction
      .select({ version: packageVersions.version })
      .from(packageVersions)
      .where(eq(packageVersions.packageId, packageId))
      .orderBy(desc(packageVersions.version))
      .limit(1);
    const version = (latestVersion?.version ?? 0) + 1;
    if (existingPackage) {
      await transaction
        .update(packages)
        .set({
          title: blueprint.editorial.title,
          description: blueprint.editorial.summary,
          published: true,
          updatedAt: now,
        })
        .where(eq(packages.id, packageId));
    } else {
      await transaction.insert(packages).values({
        id: packageId,
        slug: blueprint.slug,
        title: blueprint.editorial.title,
        description: blueprint.editorial.summary,
        published: true,
        createdAt: now,
        updatedAt: now,
      });
    }
    await transaction.insert(packageVersions).values({
      id: packageVersionId,
      packageId,
      version,
      blueprintSchemaVersion: blueprint.schemaVersion,
      blueprintDigest: digest,
      editorialJson: blueprint.editorial,
      publishedAt: now,
      createdAt: now,
    });
    for (const resolvedMember of resolved) {
      await transaction.insert(packageMembers).values({
        packageVersionId,
        skillId: resolvedMember.member.skillId,
        revisionId: resolvedMember.member.revisionId,
        position: resolvedMember.position,
        selectedByDefault: resolvedMember.selectedByDefault,
        upstreamRepositoryUrl: resolvedMember.binding.repositoryUrl,
        upstreamSkillPath: resolvedMember.binding.skillPath,
        upstreamSkillName: resolvedMember.binding.upstreamSkillName,
        observedHead: resolvedMember.binding.observedHead,
        observedLicense: resolvedMember.binding.observedLicense,
        licenseEvidenceClass: resolvedMember.binding.licenseEvidenceClass,
        licenseEvidencePath: resolvedMember.binding.licenseEvidencePath,
        publisherClass: resolvedMember.binding.publisherClass,
      });
    }
    return {
      packageId,
      packageVersionId,
      slug: blueprint.slug,
      version,
      blueprintDigest: digest,
      memberCount: resolved.length,
      publishedAt: now,
      reused: false,
    };
  }

  async publishPackageBlueprintSet(
    inputs: readonly unknown[],
  ): Promise<PackagePublicationResult[]> {
    if (inputs.length === 0 || inputs.length > 100) {
      throw new PackagePublicationError(
        "PACKAGE_SET_INVALID",
        "",
        0,
        "A publication set must contain between one and 100 blueprints.",
      );
    }
    const blueprints = inputs.map((input) => parsePackageBlueprint(input));
    if (new Set(blueprints.map((blueprint) => blueprint.slug)).size !== blueprints.length) {
      throw new PackagePublicationError(
        "PACKAGE_SET_INVALID",
        "",
        0,
        "A publication set cannot contain the same package slug twice.",
      );
    }
    const now = new Date();
    return this.db.transaction(async (transaction) => {
      const published: PackagePublicationResult[] = [];
      for (const blueprint of blueprints) {
        published.push(
          await this.publishBlueprintInTransaction(transaction, blueprint, now),
        );
      }
      return published;
    });
  }

  async publishPackageBlueprint(input: unknown): Promise<PackagePublicationResult> {
    const [result] = await this.publishPackageBlueprintSet([input]);
    if (!result) {
      throw new PackagePublicationError(
        "PACKAGE_SET_INVALID",
        "",
        0,
        "The requested package was not published.",
      );
    }
    return result;
  }

  private async resolvePublishedPackageVersion(
    transaction: CatalogTransaction,
    selector: Readonly<{ packageId?: string; slug?: string; version?: number }>,
  ) {
    const conditions = [
      eq(packages.published, true),
      isNotNull(packageVersions.publishedAt),
      eq(packageVersions.blueprintSchemaVersion, 1),
      like(packageVersions.blueprintDigest, "sha256:%"),
    ];
    if (selector.packageId) conditions.push(eq(packages.id, selector.packageId));
    if (selector.slug) conditions.push(eq(packages.slug, selector.slug));
    if (selector.version !== undefined) {
      conditions.push(eq(packageVersions.version, selector.version));
    }
    const [selected] = await transaction
      .select({
        id: packages.id,
        slug: packages.slug,
        title: packages.title,
        description: packages.description,
        versionId: packageVersions.id,
        version: packageVersions.version,
        blueprintSchemaVersion: packageVersions.blueprintSchemaVersion,
        blueprintDigest: packageVersions.blueprintDigest,
        editorial: packageVersions.editorialJson,
        publishedAt: packageVersions.publishedAt,
      })
      .from(packages)
      .innerJoin(packageVersions, eq(packageVersions.packageId, packages.id))
      .where(and(...conditions))
      .orderBy(desc(packageVersions.version))
      .limit(1);
    if (
      !selected?.publishedAt ||
      !/^sha256:[a-f0-9]{64}$/.test(selected.blueprintDigest)
    ) {
      return null;
    }
    const editorial = packageEditorialSchema.safeParse(selected.editorial);
    if (
      !editorial.success ||
      selected.title !== editorial.data.title ||
      selected.description !== editorial.data.summary
    ) {
      return null;
    }
    const storedMembers = await transaction
      .select({
        skillId: packageMembers.skillId,
        revisionId: packageMembers.revisionId,
        position: packageMembers.position,
        selectedByDefault: packageMembers.selectedByDefault,
        repositoryUrl: packageMembers.upstreamRepositoryUrl,
        skillPath: packageMembers.upstreamSkillPath,
        upstreamSkillName: packageMembers.upstreamSkillName,
        observedHead: packageMembers.observedHead,
        observedLicense: packageMembers.observedLicense,
        licenseEvidenceClass: packageMembers.licenseEvidenceClass,
        licenseEvidencePath: packageMembers.licenseEvidencePath,
        publisherClass: packageMembers.publisherClass,
      })
      .from(packageMembers)
      .where(eq(packageMembers.packageVersionId, selected.versionId))
      .orderBy(asc(packageMembers.position));
    if (storedMembers.length === 0) return null;

    const members: Array<
      EligiblePackageMember & {
        position: number;
        selectedByDefault: boolean;
      }
    > = [];
    const skillIds = new Set<string>();
    const contentHashes = new Set<string>();
    for (const stored of storedMembers) {
      if (
        stored.publisherClass === "legacy" ||
        !["official", "community"].includes(stored.publisherClass) ||
        !["repository-license", "skill-local-license", "skill-frontmatter"].includes(
          stored.licenseEvidenceClass,
        )
      ) {
        return null;
      }
      const binding: PackageMemberEligibilityBinding = {
        repositoryUrl: stored.repositoryUrl,
        skillPath: stored.skillPath,
        upstreamSkillName: stored.upstreamSkillName,
        observedHead: stored.observedHead,
        observedLicense: stored.observedLicense,
        licenseEvidenceClass: stored.licenseEvidenceClass as PackageMemberEligibilityBinding["licenseEvidenceClass"],
        licenseEvidencePath: stored.licenseEvidencePath,
        publisherClass: stored.publisherClass as PackageMemberEligibilityBinding["publisherClass"],
        skillId: stored.skillId,
        revisionId: stored.revisionId,
      };
      let member: EligiblePackageMember;
      try {
        member = await resolveEligiblePackageMember(transaction, binding);
      } catch (error) {
        if (error instanceof PackageMemberEligibilityError) return null;
        throw error;
      }
      if (skillIds.has(member.skillId) || contentHashes.has(member.contentHash)) {
        return null;
      }
      skillIds.add(member.skillId);
      contentHashes.add(member.contentHash);
      members.push({
        ...member,
        position: stored.position,
        selectedByDefault: stored.selectedByDefault,
      });
    }
    return {
      ...selected,
      editorial: editorial.data,
      publishedAt: selected.publishedAt,
      memberCount: members.length,
      members,
    };
  }

  /**
   * Resolves one bounded public page without first materializing the complete
   * package catalog. The opaque checkpoint may refer to a scanned invalid row;
   * this lets callers continue after a bounded amount of eligibility work
   * without skipping any later valid package.
   */
  async listPublishedPackagesPage(
    input: PublishedPackagePageQuery,
  ): Promise<PublishedPackagePage> {
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 100);
    const candidateBudget = Math.min(Math.max(limit * 4, 100), 400);
    const normalizedQuery = input.query?.trim() || null;
    const normalizedCategory = input.category?.trim() || null;

    return this.db.transaction(async (transaction) => {
      const visible: Array<Readonly<{
        summary: PublishedPackageSummary;
        checkpoint: Readonly<{ key: string; id: string }>;
      }>> = [];
      let after = input.after ?? null;
      let scanned = 0;
      let exhausted = false;
      let lastScanned: Readonly<{ key: string; id: string }> | null = null;

      while (visible.length <= limit && scanned < candidateBudget) {
        const batchLimit = Math.min(100, candidateBudget - scanned);
        const conditions: SQL[] = [
          eq(packages.published, true),
          isNotNull(packageVersions.publishedAt),
          eq(packageVersions.blueprintSchemaVersion, 1),
          like(packageVersions.blueprintDigest, "sha256:%"),
          sql`json_valid(${packageVersions.editorialJson}) = 1`,
          sql`not exists (
            select 1
            from package_versions newer_package_version
            where newer_package_version.package_id = ${packages.id}
              and newer_package_version.published_at is not null
              and newer_package_version.version > ${packageVersions.version}
          )`,
        ];
        if (normalizedCategory) {
          conditions.push(
            sql`lower(json_extract(${packageVersions.editorialJson}, '$.category')) = lower(${normalizedCategory})`,
          );
        }
        if (input.featured !== undefined) {
          conditions.push(
            sql`json_extract(${packageVersions.editorialJson}, '$.featured') = ${input.featured ? 1 : 0}`,
          );
        }
        if (normalizedQuery) {
          conditions.push(sql`(
            instr(lower(${packages.title}), lower(${normalizedQuery})) > 0
            or instr(lower(${packages.description}), lower(${normalizedQuery})) > 0
            or instr(
              lower(coalesce(json_extract(${packageVersions.editorialJson}, '$.outcome'), '')),
              lower(${normalizedQuery})
            ) > 0
            or exists (
              select 1
              from json_each(${packageVersions.editorialJson}, '$.tags') package_tag
              where instr(lower(cast(package_tag.value as text)), lower(${normalizedQuery})) > 0
            )
          )`);
        }
        if (after) {
          if (input.sort === "recent") {
            const publishedAt = new Date(after.key);
            if (Number.isNaN(publishedAt.getTime())) {
              throw new Error("Invalid recent package scan cursor");
            }
            conditions.push(sql`(
              ${packageVersions.publishedAt} < ${publishedAt}
              or (
                ${packageVersions.publishedAt} = ${publishedAt}
                and ${packages.id} > ${after.id}
              )
            )`);
          } else {
            conditions.push(sql`(
              lower(${packages.title}) > ${after.key}
              or (lower(${packages.title}) = ${after.key} and ${packages.id} > ${after.id})
            )`);
          }
        }

        const orderBy = input.sort === "recent"
          ? [desc(packageVersions.publishedAt), asc(packages.id)]
          : [asc(sql`lower(${packages.title})`), asc(packages.id)];
        const candidateRows = await transaction
          .select({
            id: packages.id,
            title: packages.title,
            titleKey: sql<string>`lower(${packages.title})`,
            publishedAt: packageVersions.publishedAt,
          })
          .from(packages)
          .innerJoin(packageVersions, eq(packageVersions.packageId, packages.id))
          .where(and(...conditions))
          .orderBy(...orderBy)
          .limit(batchLimit + 1);
        const hasMoreCandidates = candidateRows.length > batchLimit;
        const batch = hasMoreCandidates ? candidateRows.slice(0, batchLimit) : candidateRows;
        if (batch.length === 0) {
          exhausted = true;
          break;
        }

        for (const candidate of batch) {
          if (!candidate.publishedAt) continue;
          scanned += 1;
          const checkpoint = {
            key: input.sort === "recent"
              ? candidate.publishedAt.toISOString()
              : candidate.titleKey,
            id: candidate.id,
          } as const;
          lastScanned = checkpoint;
          const resolved = await this.resolvePublishedPackageVersion(transaction, {
            packageId: candidate.id,
          });
          if (resolved) {
            visible.push({
              summary: {
                id: resolved.id,
                slug: resolved.slug,
                title: resolved.title,
                description: resolved.description,
                versionId: resolved.versionId,
                version: resolved.version,
                publishedAt: resolved.publishedAt,
                memberCount: resolved.memberCount,
                editorial: resolved.editorial,
                blueprintSchemaVersion: resolved.blueprintSchemaVersion,
                blueprintDigest: resolved.blueprintDigest,
              },
              checkpoint,
            });
          }
          if (visible.length > limit) break;
        }

        if (visible.length > limit) break;
        if (!hasMoreCandidates) {
          exhausted = true;
          break;
        }
        after = lastScanned;
      }

      const pageEntries = visible.slice(0, limit);
      const items = pageEntries.map((entry) => entry.summary);
      if (visible.length > limit) {
        return {
          items,
          next: pageEntries.at(-1)!.checkpoint,
        };
      }
      return {
        items,
        next: !exhausted && lastScanned ? lastScanned : null,
      };
    });
  }

  async listPublishedPackages(): Promise<PublishedPackageSummary[]> {
    const pageSize = 100;
    return this.db.transaction(async (transaction) => {
      const visible: PublishedPackageSummary[] = [];
      let after: Readonly<{ title: string; id: string }> | null = null;

      while (true) {
        const conditions = [eq(packages.published, true)];
        if (after) {
          const keyset = or(
            gt(packages.title, after.title),
            and(eq(packages.title, after.title), gt(packages.id, after.id)),
          );
          if (keyset) conditions.push(keyset);
        }
        const packageRows = await transaction
          .select({ id: packages.id, title: packages.title })
          .from(packages)
          .where(and(...conditions))
          .orderBy(asc(packages.title), asc(packages.id))
          .limit(pageSize);
        if (packageRows.length === 0) break;

        for (const packageRow of packageRows) {
          const resolved = await this.resolvePublishedPackageVersion(transaction, {
            packageId: packageRow.id,
          });
          if (!resolved) continue;
          visible.push({
            id: resolved.id,
            slug: resolved.slug,
            title: resolved.title,
            description: resolved.description,
            versionId: resolved.versionId,
            version: resolved.version,
            publishedAt: resolved.publishedAt,
            memberCount: resolved.memberCount,
            editorial: resolved.editorial,
            blueprintSchemaVersion: resolved.blueprintSchemaVersion,
            blueprintDigest: resolved.blueprintDigest,
          });
        }

        if (packageRows.length < pageSize) break;
        const last = packageRows.at(-1)!;
        after = { title: last.title, id: last.id };
      }
      return visible;
    });
  }

  async publishedPackageDetails(packageId: string, version?: number) {
    return this.db.transaction((transaction) =>
      this.resolvePublishedPackageVersion(transaction, { packageId, version }),
    );
  }

  async resolvePackage(slug: string, version?: number) {
    const resolved = await this.db.transaction((transaction) =>
      this.resolvePublishedPackageVersion(transaction, { slug, version }),
    );
    if (!resolved) return [];
    return resolved.members.map((member) => ({
      packageId: resolved.id,
      slug: resolved.slug,
      title: resolved.title,
      description: resolved.description,
      versionId: resolved.versionId,
      version: resolved.version,
      blueprintSchemaVersion: resolved.blueprintSchemaVersion,
      blueprintDigest: resolved.blueprintDigest,
      editorial: resolved.editorial,
      publishedAt: resolved.publishedAt,
      ...member,
    }));
  }

  async coverage(now = new Date()) {
    const rows = await this.db
      .select()
      .from(catalogSources)
      .orderBy(asc(catalogSources.name));

    return rows.map((source) => ({
      sourceId: source.id,
      name: source.name,
      mode: source.mode,
      freshnessPolicy: source.freshnessPolicy,
      state: source.coverageState,
      recordCount: source.recordCount,
      unavailableCount: source.unavailableCount,
      lastSuccessfulSyncAt: source.lastSuccessfulSyncAt,
      lagMs: source.lastSuccessfulSyncAt
        ? Math.max(0, now.getTime() - source.lastSuccessfulSyncAt.getTime())
        : null,
      error: source.lastError,
      exclusions: source.exclusionsJson,
      upstreamIdentifier: source.upstreamIdentifier,
    }));
  }

  async acquireSyncRun(
    sourceId: string,
    leaseDurationMs = 300_000,
    options: { resumePartial?: boolean } = {},
  ) {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + Math.max(leaseDurationMs, 100));
    const leaseToken = randomUUID();
    return this.db.transaction(async (transaction) => {
      const running = await transaction
        .select()
        .from(syncRuns)
        .where(and(eq(syncRuns.sourceId, sourceId), eq(syncRuns.status, "running")))
        .limit(1);
      const active = running[0];
      if (active && active.leaseExpiresAt && active.leaseExpiresAt > now) {
        throw new CatalogSyncLeaseConflictError(sourceId);
      }
      if (active) {
        await transaction
          .update(syncRuns)
          .set({
            status: "partial",
            failure: "Previous sync lease expired",
            finishedAt: now,
            leaseToken: null,
            leaseExpiresAt: null,
          })
          .where(eq(syncRuns.id, active.id));
      }

      if (options.resumePartial !== false) {
        const [resumable] = await transaction
          .select()
          .from(syncRuns)
          .where(
            and(
              eq(syncRuns.sourceId, sourceId),
              eq(syncRuns.status, "partial"),
              isNotNull(syncRuns.cursor),
            ),
          )
          .orderBy(desc(syncRuns.startedAt))
          .limit(1);
        if (resumable) {
          await transaction
            .update(syncRuns)
            .set({
              status: "running",
              failure: null,
              finishedAt: null,
              nextRetryAt: null,
              observationSweepComplete: false,
              leaseToken,
              leaseExpiresAt,
            })
            .where(eq(syncRuns.id, resumable.id));
          await this.recomputeSourceCategoryMaterializationInTransaction(
            transaction,
            sourceId,
          );
          return {
            ...resumable,
            status: "running" as const,
            leaseToken,
            leaseExpiresAt,
            resumed: true,
          };
        }
      }

      const id = randomUUID();
      await transaction.insert(syncRuns).values({
        id,
        sourceId,
        status: "running",
        startedAt: now,
        leaseToken,
        leaseExpiresAt,
      });
      if (active) {
        await this.recomputeSourceCategoryMaterializationInTransaction(
          transaction,
          sourceId,
        );
      }
      return {
        id,
        sourceId,
        status: "running" as const,
        startedAt: now,
        finishedAt: null,
        cursor: null,
        nextPage: 0,
        pageCount: 0,
        sourceTotal: null,
        processedCount: 0,
        retryCount: 0,
        nextRetryAt: null,
        failure: null,
        leaseToken,
        leaseExpiresAt,
        completeCrawl: false,
        checkpointJson: {},
        resumed: false,
      };
    });
  }

  async checkpointSyncRun(input: {
    runId: string;
    leaseToken: string;
    nextPage: number;
    pageCount: number;
    processedCount: number;
    sourceTotal: number;
    cursor?: string | null;
    reportedTotalKnown?: boolean;
    leaseDurationMs?: number;
  }): Promise<void> {
    const now = new Date();
    const result = await this.db
      .update(syncRuns)
      .set({
        nextPage: input.nextPage,
        pageCount: input.pageCount,
        processedCount: input.processedCount,
        sourceTotal: input.sourceTotal,
        cursor: input.cursor ?? null,
        checkpointJson: {
          nextPage: input.nextPage,
          reportedTotalKnown: input.reportedTotalKnown ?? false,
        },
        leaseExpiresAt: new Date(now.getTime() + Math.max(input.leaseDurationMs ?? 300_000, 100)),
      })
      .where(
        and(
          eq(syncRuns.id, input.runId),
          eq(syncRuns.status, "running"),
          eq(syncRuns.leaseToken, input.leaseToken),
          gt(syncRuns.leaseExpiresAt, now),
        ),
      );
    if (result.rowsAffected !== 1) {
      throw new CatalogSyncLeaseLostError(input.runId);
    }
  }

  async renewSyncLease(
    runId: string,
    leaseToken: string,
    leaseDurationMs = 300_000,
  ): Promise<void> {
    const now = new Date();
    const result = await this.db
      .update(syncRuns)
      .set({ leaseExpiresAt: new Date(now.getTime() + Math.max(leaseDurationMs, 100)) })
      .where(
        and(
          eq(syncRuns.id, runId),
          eq(syncRuns.status, "running"),
          eq(syncRuns.leaseToken, leaseToken),
          gt(syncRuns.leaseExpiresAt, now),
        ),
      );
    if (result.rowsAffected !== 1) {
      throw new CatalogSyncLeaseLostError(runId);
    }
  }

  async finishSyncRun(input: {
    runId: string;
    leaseToken: string;
    sourceId: string;
    sourceTotal: number;
    recordCount: number;
    partialFailures?: string[];
    exclusions?: string[];
    completeCrawl?: boolean;
    observationSweepComplete?: boolean;
    unavailableAfter?: number;
  }): Promise<void> {
    const now = new Date();
    const incompleteFailure = input.completeCrawl === true
      ? null
      : "Source crawl ended without a complete terminal snapshot";
    const failure = input.partialFailures?.length
      ? `${input.partialFailures.length} hydration/audit operation(s) failed: ${input.partialFailures
          .slice(0, 3)
          .join("; ")}`
      : incompleteFailure;
    await this.db.transaction(async (transaction) => {
      const [lease] = await transaction
        .select({
          id: syncRuns.id,
          freshnessPolicy: catalogSources.freshnessPolicy,
        })
        .from(syncRuns)
        .innerJoin(catalogSources, eq(catalogSources.id, syncRuns.sourceId))
        .where(
          and(
            eq(syncRuns.id, input.runId),
            eq(syncRuns.sourceId, input.sourceId),
            eq(syncRuns.status, "running"),
            eq(syncRuns.leaseToken, input.leaseToken),
            gt(syncRuns.leaseExpiresAt, now),
          ),
        )
        .limit(1);
      if (!lease) throw new CatalogSyncLeaseLostError(input.runId);

      if (
        lease.freshnessPolicy === "latest-completed-observation" &&
        input.observationSweepComplete === true
      ) {
        await transaction
          .update(sourceListings)
          .set({ lastCompletedObservationRunId: null })
          .where(
            and(
              eq(sourceListings.sourceId, input.sourceId),
              eq(sourceListings.lastSeenRunId, input.runId),
            ),
          );
        await transaction
          .update(sourceListings)
          .set({ lastCompletedObservationRunId: input.runId })
          .where(
            and(
              eq(sourceListings.sourceId, input.sourceId),
              eq(sourceListings.lastSeenRunId, input.runId),
              inArray(sourceListings.status, ["current", "stale"]),
              isNotNull(sourceListings.skillId),
              isNotNull(sourceListings.sourceHash),
            ),
          );
        const missing = await transaction
          .select({
            id: sourceListings.id,
            skillId: sourceListings.skillId,
          })
          .from(sourceListings)
          .where(
            and(
              eq(sourceListings.sourceId, input.sourceId),
              or(
                isNull(sourceListings.lastSeenRunId),
                ne(sourceListings.lastSeenRunId, input.runId),
              ),
              notInArray(sourceListings.status, ["removed", "unresolved"]),
            ),
          );
        const changedSkills = new Set<string>();
        for (const listing of missing) {
          await transaction
            .update(sourceListings)
            .set({ status: "stale" })
            .where(
              and(
                eq(sourceListings.id, listing.id),
                eq(sourceListings.sourceId, input.sourceId),
              ),
            );
          if (listing.skillId) changedSkills.add(listing.skillId);
        }
        for (const skillId of changedSkills) {
          await this.recomputeSkillLifecycleInTransaction(transaction, skillId, now);
        }
      } else if (input.completeCrawl) {
        const missing = await transaction
          .select({
            id: sourceListings.id,
            skillId: sourceListings.skillId,
            missed: sourceListings.missedCompleteCrawls,
          })
          .from(sourceListings)
          .where(
            and(
              eq(sourceListings.sourceId, input.sourceId),
              or(isNull(sourceListings.lastSeenRunId), ne(sourceListings.lastSeenRunId, input.runId)),
              notInArray(sourceListings.status, ["removed", "unavailable"]),
            ),
          );
        const changedSkills = new Set<string>();
        for (const listing of missing) {
          const missed = listing.missed + 1;
          const status = missed >= (input.unavailableAfter ?? 2) ? "unavailable" : "stale";
          await transaction
            .update(sourceListings)
            .set({
              status,
              missedCompleteCrawls: missed,
              ...(status === "unavailable"
                ? { lastCompletedObservationRunId: null }
                : {}),
            })
            .where(eq(sourceListings.id, listing.id));
          if (listing.skillId) changedSkills.add(listing.skillId);
        }
        for (const skillId of changedSkills) {
          await this.recomputeSkillLifecycleInTransaction(transaction, skillId, now);
        }
      }

      const [{ count: unavailableCount = 0 } = {}] = await transaction
        .select({ count: sql<number>`count(*)` })
        .from(sourceListings)
        .where(
          and(
            eq(sourceListings.sourceId, input.sourceId),
            inArray(sourceListings.status, ["unavailable", "removed"]),
          ),
        );
      const completionFenceTime = new Date();
      const result = await transaction
        .update(syncRuns)
        .set({
          status: failure ? "partial" : "succeeded",
          finishedAt: now,
          sourceTotal: input.sourceTotal,
          completeCrawl: input.completeCrawl ?? true,
          observationSweepComplete: input.observationSweepComplete ?? false,
          failure,
          nextRetryAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(syncRuns.id, input.runId),
            eq(syncRuns.sourceId, input.sourceId),
            eq(syncRuns.status, "running"),
            eq(syncRuns.leaseToken, input.leaseToken),
            gt(syncRuns.leaseExpiresAt, completionFenceTime),
          ),
        );
      if (result.rowsAffected !== 1) {
        throw new CatalogSyncLeaseLostError(input.runId);
      }
      await transaction
        .update(catalogSources)
        .set({
          coverageState: failure ? "partial" : "current",
          ...(failure ? {} : { lastSuccessfulSyncAt: now }),
          recordCount: input.recordCount,
          unavailableCount,
          lastError: failure,
          exclusionsJson: input.exclusions ?? [],
          updatedAt: now,
        })
        .where(eq(catalogSources.id, input.sourceId));
      await this.recomputeSourceCategoryMaterializationInTransaction(
        transaction,
        input.sourceId,
      );
      await this.pruneSkillCategoryObservationHistoryInTransaction(
        transaction,
        input.sourceId,
      );
    });
  }

  async failSyncRun(input: {
    runId: string;
    leaseToken: string;
    sourceId: string;
    message: string;
    retryCount?: number;
    nextRetryAt?: Date | null;
    authMissing?: boolean;
  }): Promise<void> {
    const now = new Date();
    await this.db.transaction(async (transaction) => {
      const result = await transaction
        .update(syncRuns)
        .set({
          status: "partial",
          finishedAt: now,
          failure: input.message,
          retryCount: input.retryCount ?? 0,
          nextRetryAt: input.nextRetryAt ?? null,
          observationSweepComplete: false,
          leaseToken: null,
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(syncRuns.id, input.runId),
            eq(syncRuns.sourceId, input.sourceId),
            eq(syncRuns.status, "running"),
            eq(syncRuns.leaseToken, input.leaseToken),
            gt(syncRuns.leaseExpiresAt, now),
          ),
        );
      if (result.rowsAffected !== 1) {
        throw new CatalogSyncLeaseLostError(input.runId);
      }
      await transaction
        .update(catalogSources)
        .set({
          coverageState: input.authMissing ? "credentials-required" : "partial",
          lastError: input.message,
          updatedAt: now,
        })
        .where(eq(catalogSources.id, input.sourceId));
      await this.recomputeSourceCategoryMaterializationInTransaction(
        transaction,
        input.sourceId,
      );
      await this.pruneSkillCategoryObservationHistoryInTransaction(
        transaction,
        input.sourceId,
      );
    });
  }

  async upsertSourceListing(input: {
    fence: CatalogMutationFence;
    upstreamId: string;
    sourceType: string;
    installUrl?: string | null;
    sourceHash?: string | null;
    installs: number;
    duplicateIndicator?: boolean;
    preserveSourceHash?: boolean;
    raw: PersistedSkillRaw;
  }): Promise<{
    id: string;
    previousHash: string | null;
    skillId: string | null;
    detailEtag: string | null;
    detailLastModified: string | null;
  }> {
    const now = new Date();
    const raw = persistedSkillRawSchema.parse(input.raw);
    const id = stableId("listing", `${input.fence.sourceId}:${input.upstreamId}`);
    return this.db.transaction(async (transaction) => {
      await this.assertActiveSyncLease(transaction, input.fence);
      const [previous] = await transaction
        .select({
          sourceHash: sourceListings.sourceHash,
          skillId: sourceListings.skillId,
          detailEtag: sourceListings.detailEtag,
          detailLastModified: sourceListings.detailLastModified,
          status: sourceListings.status,
        })
        .from(sourceListings)
        .where(
          and(
            eq(sourceListings.sourceId, input.fence.sourceId),
            eq(sourceListings.upstreamId, input.upstreamId),
          ),
        )
        .limit(1);
      const nextSourceHash = input.sourceHash ??
        (input.preserveSourceHash === false ? null : previous?.sourceHash ?? null);
      const sourceHashChanged = Boolean(
        previous && previous.sourceHash !== nextSourceHash,
      );
      const invalidatesExistingBinding = Boolean(
        previous?.skillId && previous.sourceHash !== nextSourceHash,
      );
      const restoresExistingBinding = Boolean(
        previous?.skillId &&
        input.sourceHash &&
        previous.sourceHash === input.sourceHash,
      );

      if (invalidatesExistingBinding) {
        await transaction
          .delete(skillCategoryObservations)
          .where(eq(skillCategoryObservations.sourceListingId, id));
      }

      await transaction
        .insert(sourceListings)
        .values({
          id,
          sourceId: input.fence.sourceId,
          upstreamId: input.upstreamId,
          sourceType: input.sourceType,
          installUrl: input.installUrl ?? null,
          sourceHash: nextSourceHash,
          installs: input.installs,
          duplicateIndicator: input.duplicateIndicator ?? false,
          status: "unresolved",
          rawJson: raw,
          lastSeenRunId: input.fence.runId,
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: [sourceListings.sourceId, sourceListings.upstreamId],
          set: {
            sourceType: input.sourceType,
            installUrl: input.installUrl ?? null,
            sourceHash: nextSourceHash,
            installs: input.installs,
            duplicateIndicator: invalidatesExistingBinding
              ? false
              : input.duplicateIndicator ?? false,
            rawJson: raw,
            lastSeenRunId: input.fence.runId,
            lastSeenAt: now,
            missedCompleteCrawls: 0,
            ...(sourceHashChanged
              ? { lastCompletedObservationRunId: null }
              : {}),
            ...(invalidatesExistingBinding
              ? { skillId: null, status: "unresolved" as const }
              : restoresExistingBinding
                ? { status: "current" as const }
                : {}),
          },
        });

      if (previous?.skillId && (invalidatesExistingBinding ||
        (restoresExistingBinding && previous.status !== "current"))) {
        await this.recomputeSkillLifecycleInTransaction(transaction, previous.skillId, now);
      }
      if (previous?.skillId) {
        await this.recomputeSkillCategoryMaterializationInTransaction(
          transaction,
          [previous.skillId],
        );
      }

      return {
        id,
        previousHash: previous?.sourceHash ?? null,
        skillId: invalidatesExistingBinding ? null : previous?.skillId ?? null,
        detailEtag: previous?.detailEtag ?? null,
        detailLastModified: previous?.detailLastModified ?? null,
      };
    });
  }

  async markListingUnresolved(
    fence: CatalogMutationFence,
    listingId: string,
    sourceHash: string | null,
  ): Promise<void> {
    await this.db.transaction(async (transaction) => {
      await this.assertActiveSyncLease(transaction, fence);
      const found = await this.markListingUnresolvedInTransaction(
        transaction,
        fence,
        listingId,
        sourceHash,
      );
      if (!found) throw new Error("Source listing did not belong to the active sync source");
    });
  }

  async markSourceRecordUnresolved(
    fence: CatalogMutationFence,
    upstreamId: string,
    sourceHash: string | null,
  ): Promise<void> {
    await this.db.transaction(async (transaction) => {
      await this.assertActiveSyncLease(transaction, fence);
      const [listing] = await transaction
        .select({ id: sourceListings.id })
        .from(sourceListings)
        .where(
          and(
            eq(sourceListings.sourceId, fence.sourceId),
            eq(sourceListings.upstreamId, upstreamId),
          ),
        )
        .limit(1);
      if (listing) {
        await this.markListingUnresolvedInTransaction(
          transaction,
          fence,
          listing.id,
          sourceHash,
        );
      }
    });
  }

  async updateSourceListingHydration(input: {
    fence: CatalogMutationFence;
    listingId: string;
    hash: string | null;
    etag: string | null;
    lastModified: string | null;
    hydratedAt?: Date;
  }): Promise<void> {
    await this.db.transaction(async (transaction) => {
      await this.assertActiveSyncLease(transaction, input.fence);
      const [listing] = await transaction
        .select({
          skillId: sourceListings.skillId,
          sourceHash: sourceListings.sourceHash,
        })
        .from(sourceListings)
        .where(
          and(
            eq(sourceListings.id, input.listingId),
            eq(sourceListings.sourceId, input.fence.sourceId),
            eq(sourceListings.lastSeenRunId, input.fence.runId),
          ),
        )
        .limit(1);
      if (!listing) {
        throw new Error("Hydration target did not belong to the active sync observation");
      }
      const hashChanged = listing.sourceHash !== input.hash;
      if (hashChanged) {
        await transaction
          .delete(skillCategoryObservations)
          .where(eq(skillCategoryObservations.sourceListingId, input.listingId));
      }
      const result = await transaction
        .update(sourceListings)
        .set({
          sourceHash: input.hash,
          lastCompletedObservationRunId: sql`case
            when ${sourceListings.sourceHash} is ${input.hash}
              then ${sourceListings.lastCompletedObservationRunId}
            else null
          end`,
          detailEtag: input.etag,
          detailLastModified: input.lastModified,
          hydratedAt: input.hydratedAt ?? new Date(),
        })
        .where(
          and(
            eq(sourceListings.id, input.listingId),
            eq(sourceListings.sourceId, input.fence.sourceId),
            eq(sourceListings.lastSeenRunId, input.fence.runId),
          ),
        );
      if (result.rowsAffected !== 1) {
        throw new Error("Hydration target did not belong to the active sync observation");
      }
      if (hashChanged && listing.skillId) {
        await this.recomputeSkillCategoryMaterializationInTransaction(
          transaction,
          [listing.skillId],
        );
      }
    });
  }

  async recordObservedAudits(input: {
    fence: CatalogMutationFence;
    listingId: string;
    upstreamContentHash: string | null;
    audits: Array<{
      provider: string;
      providerSlug: string;
      status: "pass" | "warn" | "fail";
      summary: string;
      riskLevel?: string;
      auditedAt?: string;
      raw: PersistedAuditRaw;
    }>;
    observedAt?: Date;
  }): Promise<void> {
    const observedAt = input.observedAt ?? new Date();
    await this.db.transaction(async (transaction) => {
      await this.assertActiveSyncLease(transaction, input.fence);
      const [listing] = await transaction
        .select({ id: sourceListings.id })
        .from(sourceListings)
        .where(
          and(
            eq(sourceListings.id, input.listingId),
            eq(sourceListings.sourceId, input.fence.sourceId),
            eq(sourceListings.lastSeenRunId, input.fence.runId),
          ),
        )
        .limit(1);
      if (!listing) {
        throw new Error("Audit target did not belong to the active sync observation");
      }
      for (const audit of input.audits) {
        const raw = persistedAuditRawSchema.parse(audit.raw);
        const auditTime = audit.auditedAt ? new Date(audit.auditedAt) : observedAt;
        const id = stableId(
          "audit",
          `${input.listingId}:${audit.provider}:${audit.providerSlug}:${auditTime.toISOString()}`,
        );
        await transaction
          .insert(auditRecords)
          .values({
            id,
            revisionId: null,
            sourceListingId: input.listingId,
            scope: "observation",
            provider: audit.provider,
            providerSlug: audit.providerSlug,
            status: audit.status,
            summary: audit.summary,
            riskLevel: audit.riskLevel ?? null,
            upstreamContentHash: input.upstreamContentHash,
            scannerVersion: null,
            observedAt: auditTime,
            rawJson: raw,
          })
          .onConflictDoUpdate({
            target: auditRecords.id,
            set: {
              status: audit.status,
              summary: audit.summary,
              riskLevel: audit.riskLevel ?? null,
              upstreamContentHash: input.upstreamContentHash,
              rawJson: raw,
            },
          });
      }
    });
  }

  async recordRevisionAudits(input: {
    fence: CatalogMutationFence;
    revisionId: string;
    upstreamContentHash: string;
    audits: Array<{
      provider: string;
      providerSlug: string;
      status: "pass" | "warn" | "fail";
      summary: string;
      scannerVersion: string | null;
      raw: PersistedAuditRaw;
    }>;
    observedAt?: Date;
  }): Promise<void> {
    const observedAt = input.observedAt ?? new Date();
    await this.db.transaction(async (transaction) => {
      await this.assertActiveSyncLease(transaction, input.fence);
      for (const audit of input.audits) {
        const raw = persistedAuditRawSchema.parse(audit.raw);
        const id = stableId(
          "audit",
          `${input.revisionId}:${audit.provider}:${audit.providerSlug}:${observedAt.toISOString()}`,
        );
        await transaction.insert(auditRecords).values({
          id,
          revisionId: input.revisionId,
          sourceListingId: null,
          scope: "revision",
          provider: audit.provider,
          providerSlug: audit.providerSlug,
          status: audit.status,
          summary: audit.summary,
          riskLevel: null,
          upstreamContentHash: input.upstreamContentHash,
          scannerVersion: audit.scannerVersion,
          observedAt,
          rawJson: raw,
        });
      }
    });
  }

  async recordTrustAssessment(input: {
    fence: CatalogMutationFence;
    revisionId: string;
    immutableRef: string;
    contentHash: string;
    scanner: string;
    scannerVersion: string;
    state: TrustState;
    quarantineReason: string | null;
    findings: TrustFindingInput[];
    scannedAt?: Date;
  }): Promise<void> {
    await this.db.transaction(async (transaction) => {
      await this.assertActiveSyncLease(transaction, input.fence);
      await this.writeMonotonicTrustAssessment(transaction, {
        revisionId: input.revisionId,
        immutableRef: input.immutableRef,
        contentHash: input.contentHash,
        scanner: input.scanner,
        scannerVersion: input.scannerVersion,
        state: input.state,
        quarantineReason: input.quarantineReason,
        findings: input.findings,
        scannedAt: input.scannedAt ?? new Date(),
      });
    });
  }

  async trustDetails(revisionId: string) {
    return this.db
      .select({
        assessmentId: trustAssessments.id,
        scanner: trustAssessments.scanner,
        scannerVersion: trustAssessments.scannerVersion,
        immutableRef: trustAssessments.immutableRef,
        contentHash: trustAssessments.contentHash,
        state: trustAssessments.state,
        quarantineReason: trustAssessments.quarantineReason,
        scannedAt: trustAssessments.scannedAt,
        code: trustFindings.code,
        severity: trustFindings.severity,
        path: trustFindings.path,
        message: trustFindings.message,
        evidence: trustFindings.evidence,
      })
      .from(trustAssessments)
      .leftJoin(trustFindings, eq(trustFindings.assessmentId, trustAssessments.id))
      .where(eq(trustAssessments.revisionId, revisionId))
      .orderBy(asc(trustAssessments.scanner), asc(trustFindings.code));
  }

  async countSourceListings(sourceId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(sourceListings)
      .where(
        and(
          eq(sourceListings.sourceId, sourceId),
          notInArray(sourceListings.status, ["unavailable", "removed"]),
        ),
      );
    return row?.count ?? 0;
  }

  async countListingsSeenInRun(sourceId: string, runId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(sourceListings)
      .where(
        and(
          eq(sourceListings.sourceId, sourceId),
          eq(sourceListings.lastSeenRunId, runId),
        ),
      );
    return row?.count ?? 0;
  }

  async upsertCanonicalSkill(input: CanonicalSkillInput): Promise<{
    skillId: string;
    revisionId: string;
    duplicateOfSkillId: string | null;
  }> {
    const now = new Date();
    const skillId = stableId("skill", input.canonicalKey);
    const revisionId = stableId(
      "revision",
      `${input.canonicalKey}:${input.immutableRef}:${input.contentHash}`,
    );
    const repositoryId = input.repository
      ? stableId("repository", `${input.repository.provider}:${input.repository.url}`)
      : null;

    const outcome = await this.db.transaction(async (transaction) => {
      await this.assertActiveSyncLease(transaction, input.fence);
      const [listingObservation] = await transaction
        .select({
          skillId: sourceListings.skillId,
          sourceHash: sourceListings.sourceHash,
        })
        .from(sourceListings)
        .where(
          and(
            eq(sourceListings.id, input.listingId),
            eq(sourceListings.sourceId, input.fence.sourceId),
            eq(sourceListings.lastSeenRunId, input.fence.runId),
          ),
        )
        .limit(1);
      if (!listingObservation || listingObservation.sourceHash !== input.upstreamHash) {
        throw new Error("Canonical skill was not bound to this active source observation");
      }

      const [existingRevision] = await transaction
        .select({ id: skillRevisions.id, contentHash: skillRevisions.contentHash })
        .from(skillRevisions)
        .where(
          and(
            eq(skillRevisions.skillId, skillId),
            eq(skillRevisions.immutableRef, input.immutableRef),
          ),
        )
        .limit(1);
      if (existingRevision && existingRevision.contentHash !== input.contentHash) {
        await this.markListingUnresolvedInTransaction(
          transaction,
          input.fence,
          input.listingId,
          input.upstreamHash,
          now,
        );
        return { conflict: true as const };
      }

      if (input.repository && repositoryId) {
        await transaction
          .insert(repositories)
          .values({
            id: repositoryId,
            provider: input.repository.provider,
            normalizedUrl: input.repository.url,
            owner: input.repository.owner,
            name: input.repository.name,
            visibility: "public",
            defaultBranch: input.repository.defaultBranch,
            lastSeenAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [repositories.provider, repositories.normalizedUrl],
            set: {
              owner: input.repository.owner,
              name: input.repository.name,
              visibility: "public",
              defaultBranch: input.repository.defaultBranch,
              lastSeenAt: now,
              updatedAt: now,
            },
          });
      }

      await transaction
        .insert(skills)
        .values({
          id: skillId,
          canonicalKey: input.canonicalKey,
          provider: input.provider,
          repositoryId,
          sourceUrl: input.sourceUrl,
          skillPath: input.skillPath,
          upstreamName: input.upstreamName,
          upstreamDescription: input.upstreamDescription,
          compatibility: input.compatibility,
          license: input.license,
          lifecycle: "current",
          public: true,
          internal: false,
          officialProvenance: input.officialProvenance,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: skills.canonicalKey,
          set: {
            repositoryId,
            upstreamName: input.upstreamName,
            upstreamDescription: input.upstreamDescription,
            compatibility: input.compatibility,
            license: input.license,
            lifecycle: "current",
            public: true,
            internal: false,
            officialProvenance: input.officialProvenance,
            updatedAt: now,
          },
        });

      const [previousCurrentRevision] = await transaction
        .select({ contentHash: skillRevisions.contentHash })
        .from(skillRevisions)
        .where(and(eq(skillRevisions.skillId, skillId), eq(skillRevisions.isCurrent, true)))
        .limit(1);

      await transaction
        .update(skillRevisions)
        .set({ isCurrent: false })
        .where(and(eq(skillRevisions.skillId, skillId), eq(skillRevisions.isCurrent, true)));
      await transaction
        .insert(skillRevisions)
        .values({
          id: revisionId,
          skillId,
          immutableRef: input.immutableRef,
          contentHash: input.contentHash,
          upstreamHash: input.upstreamHash,
          installUrl: input.installUrl,
          installSpecJson: input.installSpec,
          license: input.license,
          metadataJson: input.revisionMetadata ?? {},
          isCurrent: true,
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: [skillRevisions.skillId, skillRevisions.immutableRef],
          set: {
            upstreamHash: input.upstreamHash,
            installUrl: input.installUrl,
            installSpecJson: input.installSpec,
            license: input.license,
            metadataJson: input.revisionMetadata ?? {},
            isCurrent: true,
            lastSeenAt: now,
          },
        });

      for (const alias of input.aliases) {
        await transaction
          .insert(skillAliases)
          .values({
            id: stableId("alias", `${input.provider}:${alias}`),
            skillId,
            provider: input.provider,
            alias,
            createdAt: now,
          })
          .onConflictDoNothing();
      }

      if (
        listingObservation.skillId &&
        listingObservation.skillId !== skillId
      ) {
        await transaction
          .delete(skillCategoryObservations)
          .where(eq(skillCategoryObservations.sourceListingId, input.listingId));
      }
      const listingLink = await transaction
        .update(sourceListings)
        .set({
          skillId,
          status: "current",
          missedCompleteCrawls: 0,
          ...(listingObservation.skillId !== skillId
            ? { lastCompletedObservationRunId: null }
            : {}),
        })
        .where(
          and(
            eq(sourceListings.id, input.listingId),
            eq(sourceListings.sourceId, input.fence.sourceId),
            eq(sourceListings.lastSeenRunId, input.fence.runId),
            eq(sourceListings.sourceHash, input.upstreamHash),
          ),
        );
      if (listingLink.rowsAffected !== 1) {
        throw new Error("Canonical listing link lost its active source observation");
      }

      const affectedHashes = new Set(
        [previousCurrentRevision?.contentHash, input.contentHash].filter(
          (hash): hash is string => Boolean(hash),
        ),
      );
      for (const contentHash of affectedHashes) {
        const memberRows = await transaction
          .select({ skillId: skillRevisions.skillId, canonicalKey: skills.canonicalKey })
          .from(skillRevisions)
          .innerJoin(skills, eq(skills.id, skillRevisions.skillId))
          .where(
            and(
              eq(skillRevisions.contentHash, contentHash),
              eq(skillRevisions.isCurrent, true),
            ),
          )
          .orderBy(asc(skills.canonicalKey), asc(skillRevisions.skillId));
        const memberIds = [...new Set(memberRows.map((member) => member.skillId))];
        if (!memberIds.length) continue;
        await transaction
          .delete(skillDuplicates)
          .where(
            or(
              inArray(skillDuplicates.skillId, memberIds),
              inArray(skillDuplicates.duplicateOfSkillId, memberIds),
            ),
          );
        await transaction
          .update(sourceListings)
          .set({ duplicateIndicator: false })
          .where(inArray(sourceListings.skillId, memberIds));
        const rootSkillId = memberIds[0]!;
        for (const duplicateSkillId of memberIds.slice(1)) {
          await transaction.insert(skillDuplicates).values({
            skillId: duplicateSkillId,
            duplicateOfSkillId: rootSkillId,
            contentHash,
            detectedAt: now,
          });
          await transaction
            .update(sourceListings)
            .set({ duplicateIndicator: true })
            .where(eq(sourceListings.skillId, duplicateSkillId));
        }
      }

      const [duplicate] = await transaction
        .select({ skillId: skillDuplicates.duplicateOfSkillId })
        .from(skillDuplicates)
        .where(eq(skillDuplicates.skillId, skillId))
        .limit(1);

      if (input.trustAssessment) {
        await this.writeMonotonicTrustAssessment(transaction, {
          revisionId,
          immutableRef: input.immutableRef,
          contentHash: input.contentHash,
          ...input.trustAssessment,
          scannedAt: now,
        });
      }
      for (const audit of input.upstreamAudits ?? []) {
        const raw = persistedAuditRawSchema.parse(audit.raw);
        await transaction.insert(auditRecords).values({
          id: stableId(
            "audit",
            `${revisionId}:${audit.provider}:${audit.providerSlug}:${now.toISOString()}`,
          ),
          revisionId,
          sourceListingId: null,
          scope: "revision",
          provider: audit.provider,
          providerSlug: audit.providerSlug,
          status: audit.status,
          summary: audit.summary,
          riskLevel: null,
          upstreamContentHash: input.upstreamHash,
          scannerVersion: audit.scannerVersion,
          observedAt: now,
          rawJson: raw,
        });
      }

      const categoryAffectedSkills = new Set([skillId]);
      if (
        listingObservation.skillId &&
        listingObservation.skillId !== skillId
      ) {
        categoryAffectedSkills.add(listingObservation.skillId);
        await this.recomputeSkillLifecycleInTransaction(
          transaction,
          listingObservation.skillId,
          now,
        );
      }
      await this.recomputeSkillCategoryMaterializationInTransaction(
        transaction,
        categoryAffectedSkills,
      );

      return {
        conflict: false as const,
        skillId,
        revisionId,
        duplicateOfSkillId: duplicate?.skillId ?? null,
      };
    });
    if (outcome.conflict) {
      throw new CatalogImmutableRevisionConflictError(input.immutableRef);
    }
    return {
      skillId: outcome.skillId,
      revisionId: outcome.revisionId,
      duplicateOfSkillId: outcome.duplicateOfSkillId,
    };
  }

  async markCompleteCrawlMisses(
    fence: CatalogMutationFence,
    unavailableAfter = 2,
  ): Promise<void> {
    await this.db.transaction(async (transaction) => {
      await this.assertActiveSyncLease(transaction, fence);
      const missing = await transaction
        .select({
          id: sourceListings.id,
          skillId: sourceListings.skillId,
          missed: sourceListings.missedCompleteCrawls,
        })
        .from(sourceListings)
        .where(
          and(
            eq(sourceListings.sourceId, fence.sourceId),
            or(
              isNull(sourceListings.lastSeenRunId),
              ne(sourceListings.lastSeenRunId, fence.runId),
            ),
            notInArray(sourceListings.status, ["removed", "unavailable"]),
          ),
        );

      for (const listing of missing) {
        const missed = listing.missed + 1;
        const status = missed >= unavailableAfter ? "unavailable" : "stale";
        await transaction
          .update(sourceListings)
          .set({
            status,
            missedCompleteCrawls: missed,
            ...(status === "unavailable"
              ? { lastCompletedObservationRunId: null }
              : {}),
          })
          .where(
            and(
              eq(sourceListings.id, listing.id),
              eq(sourceListings.sourceId, fence.sourceId),
            ),
          );
        if (listing.skillId) {
          await this.recomputeSkillLifecycleInTransaction(transaction, listing.skillId);
          await this.recomputeSkillCategoryMaterializationInTransaction(
            transaction,
            [listing.skillId],
          );
        }
      }
    });
  }

  async markSourceListingRemoved(
    fence: CatalogMutationFence,
    upstreamId: string,
  ): Promise<void> {
    await this.db.transaction(async (transaction) => {
      await this.assertActiveSyncLease(transaction, fence);
      const [listing] = await transaction
        .select({ id: sourceListings.id, skillId: sourceListings.skillId })
        .from(sourceListings)
        .where(
          and(
            eq(sourceListings.sourceId, fence.sourceId),
            eq(sourceListings.upstreamId, upstreamId),
          ),
        )
        .limit(1);
      if (!listing) return;
      await transaction
        .delete(skillCategoryObservations)
        .where(eq(skillCategoryObservations.sourceListingId, listing.id));
      await transaction
        .update(sourceListings)
        .set({ status: "removed", lastCompletedObservationRunId: null })
        .where(
          and(
            eq(sourceListings.id, listing.id),
            eq(sourceListings.sourceId, fence.sourceId),
          ),
        );
      if (listing.skillId) {
        await this.recomputeSkillLifecycleInTransaction(transaction, listing.skillId);
        await this.recomputeSkillCategoryMaterializationInTransaction(
          transaction,
          [listing.skillId],
        );
      }
    });
  }
}
