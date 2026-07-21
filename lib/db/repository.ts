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

import { installSpecSchema } from "../catalog/source-contract";
import { normalizeSkillPath, normalizeSourceUrl } from "../catalog/normalization";
import {
  parsePackageBlueprint,
  type PackageBlueprint,
  type PackageBlueprintMember,
} from "../packages/package-blueprint";
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

export type PackagePublicationErrorCode =
  | "MEMBER_NOT_FOUND"
  | "REVISION_MISMATCH"
  | "LICENSE_EVIDENCE_MISMATCH"
  | "TRUST_NOT_ELIGIBLE"
  | "PROVENANCE_MISMATCH"
  | "DUPLICATE_MEMBER";

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

type PersistedLicenseEvidence = Readonly<{
  path: string;
  sha256: string;
  source: string;
  sourceUrl?: string;
  immutableRef?: string;
}>;

function packageBlueprintDigest(blueprint: PackageBlueprint): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(blueprint)).digest("hex")}`;
}

function persistedLicenseEvidence(metadata: Record<string, unknown> | null): PersistedLicenseEvidence | null {
  const value = metadata?.licenseEvidence;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const evidence = value as Record<string, unknown>;
  if (
    typeof evidence.path !== "string" ||
    typeof evidence.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(evidence.sha256) ||
    typeof evidence.source !== "string"
  ) {
    return null;
  }
  if (evidence.sourceUrl !== undefined && typeof evidence.sourceUrl !== "string") return null;
  if (evidence.immutableRef !== undefined && typeof evidence.immutableRef !== "string") return null;
  return {
    path: evidence.path,
    sha256: evidence.sha256,
    source: evidence.source,
    ...(typeof evidence.sourceUrl === "string" ? { sourceUrl: evidence.sourceUrl } : {}),
    ...(typeof evidence.immutableRef === "string" ? { immutableRef: evidence.immutableRef } : {}),
  };
}

function hasCompleteInventory(metadata: Record<string, unknown> | null, contentHash: string): boolean {
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

function packageLicenseEvidenceMatches(
  member: PackageBlueprintMember,
  evidence: PersistedLicenseEvidence,
  normalizedSkillPath: string,
  normalizedRepositoryUrl: string,
  immutableRef: string,
): boolean {
  const expected = member.observedLicense;
  if (expected.evidenceClass === "repository-license") {
    return (
      evidence.source === "repository-root-license-text" &&
      evidence.path === expected.evidencePath &&
      evidence.sourceUrl !== undefined &&
      normalizeSourceUrl(evidence.sourceUrl) === normalizedRepositoryUrl &&
      evidence.immutableRef === immutableRef
    );
  }
  if (expected.evidenceClass === "skill-frontmatter") {
    return evidence.source === "frontmatter-spdx" && evidence.path === "SKILL.md";
  }
  const repositoryEvidencePath =
    normalizedSkillPath === "." ? evidence.path : `${normalizedSkillPath}/${evidence.path}`;
  return (
    evidence.source === "license-text-fingerprint" &&
    repositoryEvidencePath === expected.evidencePath
  );
}

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
  upstreamHash: string | null;
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
    raw: Record<string, unknown>;
  }>;
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

export class CatalogRepository {
  constructor(readonly db: CatalogDatabase) {}

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

  /**
   * Resolves and publishes one editorial blueprint in a single database
   * transaction. No skill instructions or upstream response bodies are
   * copied into package storage: a version contains only editorial metadata
   * and exact canonical skill/revision foreign keys.
   */
  async publishPackageBlueprint(input: unknown): Promise<PackagePublicationResult> {
    const blueprint = parsePackageBlueprint(input);
    const digest = packageBlueprintDigest(blueprint);
    const now = new Date();

    return this.db.transaction(async (transaction) => {
      const resolved: Array<{
        position: number;
        selectedByDefault: true;
        skillId: string;
        revisionId: string;
        contentHash: string;
      }> = [];
      const selectedSkillIds = new Set<string>();
      const selectedContentHashes = new Set<string>();

      const reject = (
        code: PackagePublicationErrorCode,
        member: PackageBlueprintMember,
        message: string,
      ): never => {
        throw new PackagePublicationError(code, blueprint.slug, member.position, message);
      };

      for (const member of [...blueprint.members].sort(
        (left, right) => left.position - right.position,
      )) {
        if (!member.observedSource) {
          reject(
            "REVISION_MISMATCH",
            member,
            "A package member requires an observed public branch head before publication.",
          );
        }
        const repositoryUrl = normalizeSourceUrl(member.locator.repositoryUrl);
        const skillPath = normalizeSkillPath(member.locator.skillPath);
        const observedHead = member.observedSource.headSha;
        const candidates = await transaction
          .select({
            repositoryUrl: repositories.normalizedUrl,
            repositoryOwner: repositories.owner,
            repositoryName: repositories.name,
            repositoryVisibility: repositories.visibility,
            repositoryDefaultBranch: repositories.defaultBranch,
            skillId: skills.id,
            sourceUrl: skills.sourceUrl,
            skillPath: skills.skillPath,
            name: skills.upstreamName,
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
              eq(repositories.normalizedUrl, repositoryUrl),
              eq(repositories.visibility, "public"),
              eq(skills.provider, "github"),
              eq(skills.sourceUrl, repositoryUrl),
              eq(skills.skillPath, skillPath),
              eq(skills.upstreamName, member.locator.upstreamSkillName),
              eq(skillRevisions.isCurrent, true),
            ),
          )
          .limit(2);
        if (candidates.length !== 1) {
          reject(
            "MEMBER_NOT_FOUND",
            member,
            "The exact public GitHub repository, SKILL.md path, and upstream name did not resolve uniquely.",
          );
        }
        const candidate = candidates[0]!;
        if (
          candidate.repositoryOwner?.toLowerCase() !== member.locator.owner.toLowerCase() ||
          candidate.repositoryName?.toLowerCase() !== member.locator.repository.toLowerCase() ||
          candidate.repositoryVisibility !== "public" ||
          candidate.public !== true ||
          candidate.internal !== false ||
          candidate.lifecycle !== "current" ||
          candidate.isCurrent !== true
        ) {
          reject(
            "PROVENANCE_MISMATCH",
            member,
            "The catalog record no longer has the required public current repository provenance.",
          );
        }
        if (
          candidate.immutableRef !== observedHead ||
          candidate.upstreamHash !== observedHead ||
          !/^[a-f0-9]{40}$/.test(candidate.immutableRef) ||
          !/^[a-f0-9]{64}$/.test(candidate.contentHash) ||
          !hasCompleteInventory(candidate.metadata, candidate.contentHash)
        ) {
          reject(
            "REVISION_MISMATCH",
            member,
            "The current ingested revision is not bound to the blueprint head and complete artifact fingerprint.",
          );
        }
        const installSpec = installSpecSchema.safeParse(candidate.installSpec);
        if (
          !installSpec.success ||
          installSpec.data.kind !== "source" ||
          normalizeSourceUrl(installSpec.data.sourceUrl) !== repositoryUrl ||
          normalizeSkillPath(installSpec.data.skillPath) !== skillPath ||
          installSpec.data.immutableRef !== observedHead
        ) {
          reject(
            "REVISION_MISMATCH",
            member,
            "The immutable install evidence does not match the resolved repository, path, and head.",
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
              eq(sourceListings.sourceHash, observedHead),
              eq(catalogSources.enabled, true),
              eq(catalogSources.coverageState, "current"),
            ),
          )
          .limit(1);
        if (activeListings.length !== 1) {
          reject(
            "PROVENANCE_MISMATCH",
            member,
            "No current enabled complete source observation is bound to the blueprint head.",
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
          reject(
            "TRUST_NOT_ELIGIBLE",
            member,
            "The exact revision does not have selectable revision-bound trust evidence.",
          );
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
              eq(auditRecords.upstreamContentHash, observedHead),
            ),
          )
          .orderBy(desc(auditRecords.observedAt), desc(auditRecords.id));
        const latestObservationKeys = new Set<string>();
        for (const observation of observations) {
          const key = `${observation.provider}\0${observation.providerSlug ?? ""}`;
          if (latestObservationKeys.has(key)) continue;
          latestObservationKeys.add(key);
          if (observation.status === "fail") {
            reject(
              "TRUST_NOT_ELIGIBLE",
              member,
              "The latest upstream observation for the exact revision failed.",
            );
          }
        }

        const evidence = persistedLicenseEvidence(candidate.metadata);
        if (
          candidate.license !== member.observedLicense.spdx ||
          !packageEligibleLicenses.includes(
            candidate.license as (typeof packageEligibleLicenses)[number],
          ) ||
          !evidence ||
          !packageLicenseEvidenceMatches(
            member,
            evidence,
            skillPath,
            repositoryUrl,
            observedHead,
          )
        ) {
          reject(
            "LICENSE_EVIDENCE_MISMATCH",
            member,
            "Verified revision-bound license evidence does not match the blueprint observation.",
          );
        }
        if (member.publisherClass === "official" && candidate.officialProvenance !== true) {
          reject(
            "PROVENANCE_MISMATCH",
            member,
            "An official package member requires catalog-verified official publisher provenance.",
          );
        }
        if (
          selectedSkillIds.has(candidate.skillId) ||
          selectedContentHashes.has(candidate.contentHash)
        ) {
          reject(
            "DUPLICATE_MEMBER",
            member,
            "A package version cannot include duplicate canonical skills or mirrored artifact content.",
          );
        }
        selectedSkillIds.add(candidate.skillId);
        selectedContentHashes.add(candidate.contentHash);
        resolved.push({
          position: member.position,
          selectedByDefault: member.defaultSelected,
          skillId: candidate.skillId,
          revisionId: candidate.revisionId,
          contentHash: candidate.contentHash,
        });
      }

      const [existingPackage] = await transaction
        .select({ id: packages.id })
        .from(packages)
        .where(eq(packages.slug, blueprint.slug))
        .limit(1);
      const packageId = existingPackage?.id ?? stableId("package", blueprint.slug);
      await transaction
        .insert(packages)
        .values({
          id: packageId,
          slug: blueprint.slug,
          title: blueprint.editorial.title,
          description: blueprint.editorial.summary,
          published: false,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: packages.slug,
          set: {
            title: blueprint.editorial.title,
            description: blueprint.editorial.summary,
            updatedAt: now,
          },
        });

      const packageVersionId = stableId("package-version", `${packageId}:${digest}`);
      const [existingVersion] = await transaction
        .select({
          version: packageVersions.version,
          publishedAt: packageVersions.publishedAt,
          blueprintDigest: packageVersions.blueprintDigest,
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
          })
          .from(packageMembers)
          .where(eq(packageMembers.packageVersionId, packageVersionId))
          .orderBy(asc(packageMembers.position));
        const memberCount = existingMembers.length;
        const membersMatch = existingMembers.every((existingMember, index) => {
          const resolvedMember = resolved[index];
          return (
            resolvedMember !== undefined &&
            existingMember.skillId === resolvedMember.skillId &&
            existingMember.revisionId === resolvedMember.revisionId &&
            existingMember.position === resolvedMember.position &&
            existingMember.selectedByDefault === resolvedMember.selectedByDefault
          );
        });
        if (
          existingVersion.blueprintDigest !== digest ||
          existingVersion.publishedAt === null ||
          memberCount !== resolved.length ||
          !membersMatch
        ) {
          throw new PackagePublicationError(
            "REVISION_MISMATCH",
            blueprint.slug,
            0,
            "An incomplete or inconsistent version already occupies the deterministic blueprint identity.",
          );
        }
        await transaction
          .update(packages)
          .set({ published: true, updatedAt: now })
          .where(eq(packages.id, packageId));
        return {
          packageId,
          packageVersionId,
          slug: blueprint.slug,
          version: existingVersion.version,
          blueprintDigest: digest,
          memberCount,
          publishedAt: existingVersion.publishedAt,
          reused: true,
        };
      }

      const [{ latestVersion = 0 } = {}] = await transaction
        .select({ latestVersion: sql<number>`coalesce(max(${packageVersions.version}), 0)` })
        .from(packageVersions)
        .where(eq(packageVersions.packageId, packageId));
      const version = latestVersion + 1;
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
      for (const member of resolved) {
        await transaction.insert(packageMembers).values({
          packageVersionId,
          skillId: member.skillId,
          revisionId: member.revisionId,
          position: member.position,
          selectedByDefault: member.selectedByDefault,
        });
      }
      await transaction
        .update(packages)
        .set({ published: true, updatedAt: now })
        .where(eq(packages.id, packageId));
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
    });
  }

  async listPublishedPackages(limit = 100): Promise<PublishedPackageSummary[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    const rows = await this.db
      .select({
        id: packages.id,
        slug: packages.slug,
        title: packages.title,
        description: packages.description,
        versionId: packageVersions.id,
        version: packageVersions.version,
        publishedAt: packageVersions.publishedAt,
        editorial: packageVersions.editorialJson,
        memberCount: sql<number>`(
          select count(*) from package_members members
          where members.package_version_id = ${packageVersions.id}
        )`,
      })
      .from(packages)
      .innerJoin(packageVersions, eq(packageVersions.packageId, packages.id))
      .where(
        and(
          eq(packages.published, true),
          isNotNull(packageVersions.publishedAt),
          eq(packageVersions.blueprintSchemaVersion, 1),
          like(packageVersions.blueprintDigest, "sha256:%"),
          sql`${packageVersions.version} = (
            select max(latest.version) from package_versions latest
            where latest.package_id = ${packages.id}
              and latest.published_at is not null
          )`,
        ),
      )
      .orderBy(asc(packages.title), asc(packages.id))
      .limit(boundedLimit);
    const visible: PublishedPackageSummary[] = [];
    for (const row of rows) {
      if (!row.publishedAt) continue;
      const members = await this.resolvePackage(row.slug, row.version);
      if (members.length !== row.memberCount) continue;
      visible.push({ ...row, publishedAt: row.publishedAt });
    }
    return visible;
  }

  async publishedPackageDetails(packageId: string, version?: number) {
    const versionCondition = version
      ? eq(packageVersions.version, version)
      : sql`${packageVersions.version} = (
          select max(latest.version) from package_versions latest
          where latest.package_id = ${packages.id}
            and latest.published_at is not null
        )`;
    const [selected] = await this.db
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
      .where(
        and(
          eq(packages.id, packageId),
          eq(packages.published, true),
          isNotNull(packageVersions.publishedAt),
          eq(packageVersions.blueprintSchemaVersion, 1),
          like(packageVersions.blueprintDigest, "sha256:%"),
          versionCondition,
        ),
      )
      .limit(1);
    if (!selected?.publishedAt) return null;
    const members = await this.resolvePackage(selected.slug, selected.version);
    if (members.length === 0) return null;
    return { ...selected, publishedAt: selected.publishedAt, members };
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
          const listingRows = await transaction
            .select({ status: sourceListings.status })
            .from(sourceListings)
            .where(eq(sourceListings.skillId, skillId));
          const statuses = new Set(listingRows.map((row) => row.status));
          const lifecycle: LifecycleState = statuses.has("current")
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
    runId?: string;
    leaseToken?: string;
    sourceId: string;
    message: string;
    retryCount?: number;
    nextRetryAt?: Date | null;
    authMissing?: boolean;
  }): Promise<void> {
    const now = new Date();
    if (input.runId) {
      const result = await this.db
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
          input.leaseToken
            ? and(eq(syncRuns.id, input.runId), eq(syncRuns.leaseToken, input.leaseToken))
            : eq(syncRuns.id, input.runId),
        );
      if (input.leaseToken && result.rowsAffected !== 1) {
        throw new CatalogSyncLeaseLostError(input.runId);
      }
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
    preserveSourceHash?: boolean;
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
        status: sourceListings.status,
      })
      .from(sourceListings)
      .where(and(eq(sourceListings.sourceId, input.sourceId), eq(sourceListings.upstreamId, input.upstreamId)))
      .limit(1);

    const restoresExistingBinding = Boolean(
      previous?.skillId &&
      input.sourceHash &&
      previous.sourceHash === input.sourceHash,
    );

    await this.db
      .insert(sourceListings)
      .values({
        id,
        sourceId: input.sourceId,
        upstreamId: input.upstreamId,
        sourceType: input.sourceType,
        installUrl: input.installUrl ?? null,
        sourceHash:
          input.sourceHash ?? (input.preserveSourceHash === false ? null : previous?.sourceHash ?? null),
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
          sourceHash:
            input.sourceHash ??
            (input.preserveSourceHash === false ? null : previous?.sourceHash ?? null),
          installs: input.installs,
          duplicateIndicator: input.duplicateIndicator ?? false,
          rawJson: input.raw,
          lastSeenRunId: input.runId,
          lastSeenAt: now,
          missedCompleteCrawls: 0,
          ...(restoresExistingBinding ? { status: "current" as const } : {}),
        },
      });

    if (restoresExistingBinding && previous?.skillId && previous.status !== "current") {
      await this.recomputeSkillLifecycle(previous.skillId);
    }

    return {
      id,
      previousHash: previous?.sourceHash ?? null,
      skillId: previous?.skillId ?? null,
      detailEtag: previous?.detailEtag ?? null,
      detailLastModified: previous?.detailLastModified ?? null,
    };
  }

  async markListingUnresolved(listingId: string, sourceHash: string | null): Promise<void> {
    const now = new Date();
    await this.db.transaction(async (transaction) => {
      const [listing] = await transaction
        .select({ skillId: sourceListings.skillId })
        .from(sourceListings)
        .where(eq(sourceListings.id, listingId))
        .limit(1);
      await transaction
        .update(sourceListings)
        .set({
          skillId: null,
          status: "unresolved",
          sourceHash,
          duplicateIndicator: false,
        })
        .where(eq(sourceListings.id, listingId));
      if (!listing?.skillId) return;
      const rows = await transaction
        .select({ status: sourceListings.status })
        .from(sourceListings)
        .where(eq(sourceListings.skillId, listing.skillId));
      const statuses = new Set(rows.map((row) => row.status));
      const lifecycle: LifecycleState = statuses.has("current")
        ? "current"
        : statuses.has("stale")
          ? "stale"
          : statuses.has("unavailable")
            ? "unavailable"
            : statuses.has("removed")
              ? "removed"
              : "stale";
      await transaction
        .update(skills)
        .set({ lifecycle, updatedAt: now })
        .where(eq(skills.id, listing.skillId));
    });
  }

  async markSourceRecordUnresolved(
    sourceId: string,
    upstreamId: string,
    sourceHash: string | null,
  ): Promise<void> {
    const [listing] = await this.db
      .select({ id: sourceListings.id })
      .from(sourceListings)
      .where(
        and(
          eq(sourceListings.sourceId, sourceId),
          eq(sourceListings.upstreamId, upstreamId),
        ),
      )
      .limit(1);
    if (listing) await this.markListingUnresolved(listing.id, sourceHash);
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
        `${input.listingId}:${audit.provider}:${audit.providerSlug}:${auditTime.toISOString()}`,
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

  async recordRevisionAudits(input: {
    revisionId: string;
    upstreamContentHash: string;
    audits: Array<{
      provider: string;
      providerSlug: string;
      status: "pass" | "warn" | "fail";
      summary: string;
      scannerVersion: string | null;
      raw: Record<string, unknown>;
    }>;
    observedAt?: Date;
  }): Promise<void> {
    const observedAt = input.observedAt ?? new Date();
    for (const audit of input.audits) {
      const id = stableId(
        "audit",
        `${input.revisionId}:${audit.provider}:${audit.providerSlug}:${observedAt.toISOString()}`,
      );
      await this.db.insert(auditRecords).values({
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
        rawJson: audit.raw,
      });
    }
  }

  async recordTrustAssessment(input: {
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
      await this.writeMonotonicTrustAssessment(transaction, {
        ...input,
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

    return this.db.transaction(async (transaction) => {
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
        throw new Error(
          `Immutable revision ${input.immutableRef} changed content hash; refusing in-place mutation`,
        );
      }
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

      await transaction
        .update(sourceListings)
        .set({ skillId, status: "current", missedCompleteCrawls: 0 })
        .where(eq(sourceListings.id, input.listingId));

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
          rawJson: audit.raw,
        });
      }

      return {
        skillId,
        revisionId,
        duplicateOfSkillId: duplicate?.skillId ?? null,
      };
    });
  }

  async markCompleteCrawlMisses(
    sourceId: string,
    runId: string,
    unavailableAfter = 2,
  ): Promise<void> {
    const missing = await this.db
      .select({
        id: sourceListings.id,
        skillId: sourceListings.skillId,
        missed: sourceListings.missedCompleteCrawls,
      })
      .from(sourceListings)
      .where(
        and(
          eq(sourceListings.sourceId, sourceId),
          or(isNull(sourceListings.lastSeenRunId), ne(sourceListings.lastSeenRunId, runId)),
          notInArray(sourceListings.status, ["removed", "unavailable"]),
        ),
      );

    for (const listing of missing) {
      const missed = listing.missed + 1;
      const status = missed >= unavailableAfter ? "unavailable" : "stale";
      await this.db
        .update(sourceListings)
        .set({ status, missedCompleteCrawls: missed })
        .where(eq(sourceListings.id, listing.id));
      if (listing.skillId) {
        await this.recomputeSkillLifecycle(listing.skillId);
      }
    }
  }

  async markSourceListingRemoved(sourceId: string, upstreamId: string): Promise<void> {
    const [listing] = await this.db
      .select({ id: sourceListings.id, skillId: sourceListings.skillId })
      .from(sourceListings)
      .where(and(eq(sourceListings.sourceId, sourceId), eq(sourceListings.upstreamId, upstreamId)))
      .limit(1);
    if (!listing) {
      return;
    }
    await this.db
      .update(sourceListings)
      .set({ status: "removed" })
      .where(eq(sourceListings.id, listing.id));
    if (listing.skillId) {
      await this.recomputeSkillLifecycle(listing.skillId);
    }
  }

  private async recomputeSkillLifecycle(skillId: string): Promise<void> {
    const rows = await this.db
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
    await this.db
      .update(skills)
      .set({ lifecycle, updatedAt: new Date() })
      .where(eq(skills.id, skillId));
  }
}
