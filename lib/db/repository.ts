import { createHash, randomUUID } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  isNotNull,
  like,
  ne,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import {
  persistedAuditRawSchema,
  persistedSkillRawSchema,
  type PersistedAuditRaw,
  type PersistedSkillRaw,
} from "../catalog/provider-raw";
import { installSpecSchema } from "../catalog/source-contract";
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
  skillDuplicates,
  skillRevisions,
  skills,
  sourceListings,
  syncRuns,
  trustAssessments,
  trustFindings,
  type lifecycleStates,
  type sourceModes,
} from "./schema";

type SourceMode = (typeof sourceModes)[number];
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

function hasActiveSourceListing() {
  return sql<boolean>`exists (
    select 1 from source_listings active_listing
    join catalog_sources active_source on active_source.id = active_listing.source_id
    where active_listing.skill_id = ${skills.id}
      and active_listing.status in ('current', 'stale')
      and active_listing.source_hash = ${skillRevisions.upstreamHash}
      and active_source.enabled = 1
      and active_source.coverage_state <> 'not-configured'
  )`;
}

function hasStructurallyValidInstallSpec() {
  return sql<boolean>`case
    when json_valid(${skillRevisions.installSpecJson}) = 0 then 0
    when json_extract(${skillRevisions.installSpecJson}, '$.kind') = 'source' then
      json_type(${skillRevisions.installSpecJson}, '$.sourceUrl') = 'text'
      and length(trim(json_extract(${skillRevisions.installSpecJson}, '$.sourceUrl'))) > 0
      and json_type(${skillRevisions.installSpecJson}, '$.immutableRef') = 'text'
      and length(trim(json_extract(${skillRevisions.installSpecJson}, '$.immutableRef'))) > 0
      and json_type(${skillRevisions.installSpecJson}, '$.skillPath') = 'text'
      and length(trim(json_extract(${skillRevisions.installSpecJson}, '$.skillPath'))) > 0
    when json_extract(${skillRevisions.installSpecJson}, '$.kind') = 'registry' then
      json_type(${skillRevisions.installSpecJson}, '$.registry') = 'text'
      and length(trim(json_extract(${skillRevisions.installSpecJson}, '$.registry'))) > 0
      and json_type(${skillRevisions.installSpecJson}, '$.identifier') = 'text'
      and length(trim(json_extract(${skillRevisions.installSpecJson}, '$.identifier'))) > 0
      and json_type(${skillRevisions.installSpecJson}, '$.version') = 'text'
      and length(trim(json_extract(${skillRevisions.installSpecJson}, '$.version'))) > 0
    else 0
  end`;
}

function hasValidInstallSpec(value: unknown): boolean {
  return installSpecSchema.safeParse(value).success;
}

export interface CatalogSearchOptions {
  query?: string;
  category?: string;
  lifecycle?: LifecycleState[];
  limit?: number;
  offset?: number;
}

export interface SourceDescriptorInput {
  id: string;
  name: string;
  baseUrl: string;
  mode: SourceMode;
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
      .update(sourceListings)
      .set({
        skillId: null,
        status: "unresolved",
        sourceHash,
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

  async upsertSource(input: SourceDescriptorInput): Promise<void> {
    const now = new Date();
    await this.db
      .insert(catalogSources)
      .values({
        ...input,
        termsUrl: input.termsUrl ?? null,
        enabled: input.enabled ?? true,
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
          upstreamIdentifier: input.upstreamIdentifier,
          termsUrl: input.termsUrl ?? null,
          enabled: input.enabled ?? true,
          updatedAt: now,
        },
      });
  }

  async markSourceNotConfigured(sourceId: string, exclusions: readonly string[]): Promise<void> {
    await this.db
      .update(catalogSources)
      .set({
        coverageState: "not-configured",
        lastSuccessfulSyncAt: null,
        lastError: null,
        exclusionsJson: [...exclusions],
        updatedAt: new Date(),
      })
      .where(eq(catalogSources.id, sourceId));
  }

  async search(options: CatalogSearchOptions = {}) {
    const limit = Math.min(Math.max(options.limit ?? 24, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);
    const lifecycle = options.lifecycle ?? ["current"];
    const conditions = [
      eq(skills.public, true),
      eq(skills.internal, false),
      inArray(skills.lifecycle, lifecycle),
      ne(skillRevisions.immutableRef, ""),
      ne(skillRevisions.contentHash, ""),
      isNotNull(skillRevisions.upstreamHash),
      ne(skillRevisions.upstreamHash, ""),
      hasStructurallyValidInstallSpec(),
      hasActiveSourceListing(),
      notExists(
        this.db
          .select({ value: sql`1` })
          .from(trustAssessments)
          .where(
            and(
              eq(trustAssessments.revisionId, skillRevisions.id),
              eq(trustAssessments.immutableRef, skillRevisions.immutableRef),
              eq(trustAssessments.contentHash, skillRevisions.contentHash),
              inArray(trustAssessments.state, ["fail", "quarantined"]),
            ),
          ),
      ),
      hasSelectableTrust(),
      noLatestObservedFail(),
    ];

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
        sourceUrl: skills.sourceUrl,
        skillPath: skills.skillPath,
        lifecycle: skills.lifecycle,
        officialProvenance: skills.officialProvenance,
        revisionId: skillRevisions.id,
        immutableRef: skillRevisions.immutableRef,
        contentHash: skillRevisions.contentHash,
        installSpec: skillRevisions.installSpecJson,
        license: skillRevisions.license,
        revisionMetadata: skillRevisions.metadataJson,
        trustState: sql<"unreviewed" | "pass" | "warn">`
          case
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
        installs: sql<number>`coalesce(max(${sourceListings.installs}), 0)`,
      })
      .from(skills)
      .innerJoin(
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
    return rows.filter((row) => hasValidInstallSpec(row.installSpec));
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

  async resolvePackage(slug: string, version?: number) {
    const versionCondition = version
      ? eq(packageVersions.version, version)
      : sql`${packageVersions.version} = (
          select max(latest.version)
          from package_versions latest
          where latest.package_id = ${packages.id}
            and latest.published_at is not null
        )`;
    const [selected] = await this.db
      .select({ id: packageVersions.id })
      .from(packages)
      .innerJoin(packageVersions, eq(packageVersions.packageId, packages.id))
      .where(
        and(
          eq(packages.slug, slug),
          eq(packages.published, true),
          isNotNull(packageVersions.publishedAt),
          versionCondition,
        ),
      )
      .limit(1);
    if (!selected) return [];
    const [{ count: expectedCount = 0 } = {}] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(packageMembers)
      .where(eq(packageMembers.packageVersionId, selected.id));
    const rows = await this.db
      .select({
        packageId: packages.id,
        slug: packages.slug,
        title: packages.title,
        description: packages.description,
        version: packageVersions.version,
        position: packageMembers.position,
        selectedByDefault: packageMembers.selectedByDefault,
        skillId: skills.id,
        name: skills.upstreamName,
        sourceUrl: skills.sourceUrl,
        skillPath: skills.skillPath,
        revisionId: skillRevisions.id,
        immutableRef: skillRevisions.immutableRef,
        contentHash: skillRevisions.contentHash,
        installSpec: skillRevisions.installSpecJson,
        license: skillRevisions.license,
        revisionMetadata: skillRevisions.metadataJson,
        trustState: sql<"unreviewed" | "pass" | "warn">`
          case
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
      })
      .from(packages)
      .innerJoin(packageVersions, eq(packageVersions.packageId, packages.id))
      .innerJoin(packageMembers, eq(packageMembers.packageVersionId, packageVersions.id))
      .innerJoin(skills, eq(skills.id, packageMembers.skillId))
      .innerJoin(
        skillRevisions,
        and(
          eq(skillRevisions.id, packageMembers.revisionId),
          eq(skillRevisions.skillId, skills.id),
        ),
      )
      .where(
        and(
          eq(packages.slug, slug),
          eq(packages.published, true),
          eq(packageVersions.id, selected.id),
          isNotNull(packageVersions.publishedAt),
          eq(skills.public, true),
          eq(skills.internal, false),
          inArray(skills.lifecycle, ["current", "stale"]),
          ne(skillRevisions.immutableRef, ""),
          ne(skillRevisions.contentHash, ""),
          isNotNull(skillRevisions.upstreamHash),
          ne(skillRevisions.upstreamHash, ""),
          hasStructurallyValidInstallSpec(),
          hasActiveSourceListing(),
          inArray(skillRevisions.license, packageEligibleLicenses),
          sql`json_extract(${skillRevisions.metadataJson}, '$.licenseEvidence.sha256') is not null`,
          notExists(
            this.db
              .select({ value: sql`1` })
              .from(trustAssessments)
              .where(
                and(
                  eq(trustAssessments.revisionId, skillRevisions.id),
                  eq(trustAssessments.immutableRef, skillRevisions.immutableRef),
                  eq(trustAssessments.contentHash, skillRevisions.contentHash),
                  inArray(trustAssessments.state, ["fail", "quarantined"]),
                ),
              ),
          ),
          hasSelectableTrust(),
          noLatestObservedFail(),
        ),
      )
      .orderBy(desc(packageVersions.version), asc(packageMembers.position));
    return rows.length === expectedCount && rows.every((row) => hasValidInstallSpec(row.installSpec))
      ? rows
      : [];
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

  async acquireSyncRun(sourceId: string, leaseDurationMs = 300_000) {
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
            leaseToken,
            leaseExpiresAt,
          })
          .where(eq(syncRuns.id, resumable.id));
        return { ...resumable, status: "running" as const, leaseToken, leaseExpiresAt, resumed: true };
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
        leaseExpiresAt: new Date(Date.now() + Math.max(input.leaseDurationMs ?? 300_000, 100)),
      })
      .where(
        and(
          eq(syncRuns.id, input.runId),
          eq(syncRuns.status, "running"),
          eq(syncRuns.leaseToken, input.leaseToken),
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
    const result = await this.db
      .update(syncRuns)
      .set({ leaseExpiresAt: new Date(Date.now() + Math.max(leaseDurationMs, 100)) })
      .where(
        and(
          eq(syncRuns.id, runId),
          eq(syncRuns.status, "running"),
          eq(syncRuns.leaseToken, leaseToken),
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
        .select({ id: syncRuns.id })
        .from(syncRuns)
        .where(
          and(
            eq(syncRuns.id, input.runId),
            eq(syncRuns.sourceId, input.sourceId),
            eq(syncRuns.status, "running"),
            eq(syncRuns.leaseToken, input.leaseToken),
          ),
        )
        .limit(1);
      if (!lease) throw new CatalogSyncLeaseLostError(input.runId);

      if (input.completeCrawl) {
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
            .set({ status, missedCompleteCrawls: missed })
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
      const result = await transaction
        .update(syncRuns)
        .set({
          status: failure ? "partial" : "succeeded",
          finishedAt: now,
          sourceTotal: input.sourceTotal,
          completeCrawl: input.completeCrawl ?? true,
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
          leaseToken: null,
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(syncRuns.id, input.runId),
            eq(syncRuns.sourceId, input.sourceId),
            eq(syncRuns.status, "running"),
            eq(syncRuns.leaseToken, input.leaseToken),
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
      const invalidatesExistingBinding = Boolean(
        previous?.skillId && previous.sourceHash !== nextSourceHash,
      );
      const restoresExistingBinding = Boolean(
        previous?.skillId &&
        input.sourceHash &&
        previous.sourceHash === input.sourceHash,
      );

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
      const result = await transaction
        .update(sourceListings)
        .set({
          sourceHash: input.hash,
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

      const listingLink = await transaction
        .update(sourceListings)
        .set({ skillId, status: "current", missedCompleteCrawls: 0 })
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
          .set({ status, missedCompleteCrawls: missed })
          .where(
            and(
              eq(sourceListings.id, listing.id),
              eq(sourceListings.sourceId, fence.sourceId),
            ),
          );
        if (listing.skillId) {
          await this.recomputeSkillLifecycleInTransaction(transaction, listing.skillId);
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
        .update(sourceListings)
        .set({ status: "removed" })
        .where(
          and(
            eq(sourceListings.id, listing.id),
            eq(sourceListings.sourceId, fence.sourceId),
          ),
        );
      if (listing.skillId) {
        await this.recomputeSkillLifecycleInTransaction(transaction, listing.skillId);
      }
    });
  }
}
