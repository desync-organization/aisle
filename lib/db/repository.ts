import { createHash, randomUUID } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  like,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";

import type { CatalogDatabase } from "./client";
import {
  auditRecords,
  catalogSources,
  categories,
  packageMembers,
  packages,
  packageVersions,
  skillCategories,
  skillRevisions,
  skills,
  sourceListings,
  syncRuns,
  trustAssessments,
  type lifecycleStates,
  type sourceModes,
} from "./schema";

type SourceMode = (typeof sourceModes)[number];
type LifecycleState = (typeof lifecycleStates)[number];

function stableId(namespace: string, value: string): string {
  return `${namespace}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
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
}

export class CatalogRepository {
  constructor(readonly db: CatalogDatabase) {}

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
      notExists(
        this.db
          .select({ value: sql`1` })
          .from(trustAssessments)
          .where(
            and(
              eq(trustAssessments.revisionId, skillRevisions.id),
              inArray(trustAssessments.state, ["fail", "quarantined"]),
            ),
          ),
      ),
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

    return this.db
      .select({
        id: skills.id,
        name: skills.upstreamName,
        description: skills.upstreamDescription,
        sourceUrl: skills.sourceUrl,
        skillPath: skills.skillPath,
        lifecycle: skills.lifecycle,
        license: skills.license,
        officialProvenance: skills.officialProvenance,
        revisionId: skillRevisions.id,
        immutableRef: skillRevisions.immutableRef,
        contentHash: skillRevisions.contentHash,
        trustState: sql<"unreviewed" | "pass" | "warn">`
          case
            when exists (
              select 1 from trust_assessments ta
              where ta.revision_id = ${skillRevisions.id} and ta.state = 'warn'
            ) then 'warn'
            when exists (
              select 1 from trust_assessments ta
              where ta.revision_id = ${skillRevisions.id} and ta.state = 'pass'
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
    const selectedVersion = version
      ? eq(packageVersions.version, version)
      : sql`${packageVersions.version} = (
          select max(latest.version)
          from package_versions latest
          where latest.package_id = ${packages.id}
        )`;
    return this.db
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
        trustState: sql<"unreviewed" | "pass" | "warn">`
          case
            when exists (
              select 1 from trust_assessments ta
              where ta.revision_id = ${skillRevisions.id} and ta.state = 'warn'
            ) then 'warn'
            when exists (
              select 1 from trust_assessments ta
              where ta.revision_id = ${skillRevisions.id} and ta.state = 'pass'
            ) then 'pass'
            else 'unreviewed'
          end
        `,
      })
      .from(packages)
      .innerJoin(packageVersions, eq(packageVersions.packageId, packages.id))
      .innerJoin(packageMembers, eq(packageMembers.packageVersionId, packageVersions.id))
      .innerJoin(skills, eq(skills.id, packageMembers.skillId))
      .innerJoin(skillRevisions, eq(skillRevisions.id, packageMembers.revisionId))
      .where(
        and(
          eq(packages.slug, slug),
          eq(packages.published, true),
          selectedVersion,
          eq(skills.public, true),
          eq(skills.internal, false),
          inArray(skills.lifecycle, ["current", "stale"]),
          ne(skillRevisions.immutableRef, ""),
          ne(skillRevisions.contentHash, ""),
          notExists(
            this.db
              .select({ value: sql`1` })
              .from(trustAssessments)
              .where(
                and(
                  eq(trustAssessments.revisionId, skillRevisions.id),
                  inArray(trustAssessments.state, ["fail", "quarantined"]),
                ),
              ),
          ),
        ),
      )
      .orderBy(desc(packageVersions.version), asc(packageMembers.position));
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

  async createSyncRun(sourceId: string, resume?: { runId: string; nextPage: number }) {
    const id = resume?.runId ?? randomUUID();
    if (resume) {
      await this.db
        .update(syncRuns)
        .set({ status: "running", failure: null, nextRetryAt: null })
        .where(eq(syncRuns.id, id));
      return { id, nextPage: resume.nextPage };
    }

    await this.db.insert(syncRuns).values({
      id,
      sourceId,
      status: "running",
      startedAt: new Date(),
    });
    return { id, nextPage: 0 };
  }

  async latestIncompleteRun(sourceId: string) {
    const [run] = await this.db
      .select()
      .from(syncRuns)
      .where(and(eq(syncRuns.sourceId, sourceId), inArray(syncRuns.status, ["running", "partial"])))
      .orderBy(desc(syncRuns.startedAt))
      .limit(1);
    return run;
  }

  async checkpointSyncRun(input: {
    runId: string;
    nextPage: number;
    pageCount: number;
    processedCount: number;
    sourceTotal: number;
    cursor?: string | null;
  }): Promise<void> {
    await this.db
      .update(syncRuns)
      .set({
        nextPage: input.nextPage,
        pageCount: input.pageCount,
        processedCount: input.processedCount,
        sourceTotal: input.sourceTotal,
        cursor: input.cursor ?? null,
        checkpointJson: { nextPage: input.nextPage },
      })
      .where(eq(syncRuns.id, input.runId));
  }

  async finishSyncRun(input: {
    runId: string;
    sourceId: string;
    sourceTotal: number;
    recordCount: number;
    partialFailures?: string[];
  }): Promise<void> {
    const now = new Date();
    const failure = input.partialFailures?.length
      ? `${input.partialFailures.length} hydration/audit operation(s) failed: ${input.partialFailures
          .slice(0, 3)
          .join("; ")}`
      : null;
    await this.db.transaction(async (transaction) => {
      await transaction
        .update(syncRuns)
        .set({
          status: failure ? "partial" : "succeeded",
          finishedAt: now,
          sourceTotal: input.sourceTotal,
          completeCrawl: true,
          failure,
          nextRetryAt: null,
        })
        .where(eq(syncRuns.id, input.runId));
      await transaction
        .update(catalogSources)
        .set({
          coverageState: failure ? "partial" : "current",
          lastSuccessfulSyncAt: now,
          recordCount: input.recordCount,
          lastError: failure,
          updatedAt: now,
        })
        .where(eq(catalogSources.id, input.sourceId));
    });
  }

  async failSyncRun(input: {
    runId?: string;
    sourceId: string;
    message: string;
    retryCount?: number;
    nextRetryAt?: Date | null;
    authMissing?: boolean;
  }): Promise<void> {
    const now = new Date();
    if (input.runId) {
      await this.db
        .update(syncRuns)
        .set({
          status: "partial",
          finishedAt: now,
          failure: input.message,
          retryCount: input.retryCount ?? 0,
          nextRetryAt: input.nextRetryAt ?? null,
        })
        .where(eq(syncRuns.id, input.runId));
    }
    await this.db
      .update(catalogSources)
      .set({
        coverageState: input.authMissing ? "credentials-required" : "partial",
        lastError: input.message,
        updatedAt: now,
      })
      .where(eq(catalogSources.id, input.sourceId));
  }

  async upsertSourceListing(input: {
    sourceId: string;
    runId: string;
    upstreamId: string;
    sourceType: string;
    installUrl?: string | null;
    sourceHash?: string | null;
    installs: number;
    duplicateIndicator?: boolean;
    raw: Record<string, unknown>;
  }): Promise<{
    id: string;
    previousHash: string | null;
    skillId: string | null;
    detailEtag: string | null;
    detailLastModified: string | null;
  }> {
    const now = new Date();
    const id = stableId("listing", `${input.sourceId}:${input.upstreamId}`);
    const [previous] = await this.db
      .select({
        sourceHash: sourceListings.sourceHash,
        skillId: sourceListings.skillId,
        detailEtag: sourceListings.detailEtag,
        detailLastModified: sourceListings.detailLastModified,
      })
      .from(sourceListings)
      .where(and(eq(sourceListings.sourceId, input.sourceId), eq(sourceListings.upstreamId, input.upstreamId)))
      .limit(1);

    await this.db
      .insert(sourceListings)
      .values({
        id,
        sourceId: input.sourceId,
        upstreamId: input.upstreamId,
        sourceType: input.sourceType,
        installUrl: input.installUrl ?? null,
        sourceHash: input.sourceHash ?? previous?.sourceHash ?? null,
        installs: input.installs,
        duplicateIndicator: input.duplicateIndicator ?? false,
        status: previous?.skillId ? "current" : "unresolved",
        rawJson: input.raw,
        lastSeenRunId: input.runId,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [sourceListings.sourceId, sourceListings.upstreamId],
        set: {
          sourceType: input.sourceType,
          installUrl: input.installUrl ?? null,
          sourceHash: input.sourceHash ?? previous?.sourceHash ?? null,
          installs: input.installs,
          duplicateIndicator: input.duplicateIndicator ?? false,
          rawJson: input.raw,
          lastSeenRunId: input.runId,
          lastSeenAt: now,
          missedCompleteCrawls: 0,
        },
      });

    return {
      id,
      previousHash: previous?.sourceHash ?? null,
      skillId: previous?.skillId ?? null,
      detailEtag: previous?.detailEtag ?? null,
      detailLastModified: previous?.detailLastModified ?? null,
    };
  }

  async updateSourceListingHydration(input: {
    listingId: string;
    hash: string | null;
    etag: string | null;
    lastModified: string | null;
    hydratedAt?: Date;
  }): Promise<void> {
    await this.db
      .update(sourceListings)
      .set({
        sourceHash: input.hash,
        detailEtag: input.etag,
        detailLastModified: input.lastModified,
        hydratedAt: input.hydratedAt ?? new Date(),
      })
      .where(eq(sourceListings.id, input.listingId));
  }

  async recordObservedAudits(input: {
    listingId: string;
    upstreamContentHash: string | null;
    audits: Array<{
      provider: string;
      providerSlug: string;
      status: "pass" | "warn" | "fail";
      summary: string;
      riskLevel?: string;
      auditedAt?: string;
      raw: Record<string, unknown>;
    }>;
    observedAt?: Date;
  }): Promise<void> {
    const observedAt = input.observedAt ?? new Date();
    for (const audit of input.audits) {
      const auditTime = audit.auditedAt ? new Date(audit.auditedAt) : observedAt;
      const id = stableId(
        "audit",
        `${input.listingId}:${audit.providerSlug}:${auditTime.toISOString()}`,
      );
      await this.db
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
          rawJson: audit.raw,
        })
        .onConflictDoUpdate({
          target: auditRecords.id,
          set: {
            status: audit.status,
            summary: audit.summary,
            riskLevel: audit.riskLevel ?? null,
            upstreamContentHash: input.upstreamContentHash,
            rawJson: audit.raw,
          },
        });
    }
  }

  async countSourceListings(sourceId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(sourceListings)
      .where(eq(sourceListings.sourceId, sourceId));
    return row?.count ?? 0;
  }
}
