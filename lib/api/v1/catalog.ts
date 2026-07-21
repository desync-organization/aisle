import {
  and,
  asc,
  desc,
  eq,
  inArray,
  sql,
  type SQL,
} from "drizzle-orm";

import {
  isIndividuallySelectableLicense,
  publicLicenseLabel,
} from "@/lib/catalog/license-policy";
import { normalizeSkillPath, normalizeSourceUrl } from "@/lib/catalog/normalization";
import { installSpecSchema } from "@/lib/catalog/source-contract";
import type { CatalogDatabase } from "@/lib/db/client";
import {
  CatalogRepository,
  type PublishedPackageSummary,
} from "@/lib/db/repository";
import {
  categories,
  repositories,
  skillCategories,
  skillDuplicates,
  skillRevisions,
  skills,
} from "@/lib/db/schema";
import { packageEditorialSchema } from "@/lib/packages/package-blueprint";

import type {
  PackagesQuery,
  SkillGateReason,
  SkillsQuery,
} from "./contracts";
import {
  apiFilterHash,
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
} from "./cursor";

type PublicTrustState = "pass" | "warn" | "unreviewed" | "fail" | "quarantined";

type VisibleSkillRow = Readonly<{
  id: string;
  name: string;
  sortName: string;
  description: string | null;
  compatibility: string | null;
  provider: string;
  sourceUrl: string;
  skillPath: string;
  lifecycle: "current" | "stale" | "unavailable" | "removed";
  officialProvenance: boolean;
  catalogLicense: string;
  updatedAt: Date;
  repositoryProvider: string | null;
  repositoryUrl: string | null;
  repositoryOwner: string | null;
  repositoryName: string | null;
  repositoryVisibility: string | null;
  revisionId: string | null;
  immutableRef: string | null;
  contentHash: string | null;
  upstreamHash: string | null;
  revisionLicense: string | null;
  installSpec: Record<string, unknown> | null;
  revisionMetadata: Record<string, unknown> | null;
  trustState: PublicTrustState;
  installs: number;
  hasCurrentObservation: boolean;
  hasLatestAuditFailure: boolean;
  duplicateOfSkillId: string | null;
}>;

const trustStateExpression = sql<PublicTrustState>`case
  when exists (
    select 1 from trust_assessments api_trust
    where api_trust.revision_id = ${skillRevisions.id}
      and api_trust.immutable_ref = ${skillRevisions.immutableRef}
      and api_trust.content_hash = ${skillRevisions.contentHash}
      and api_trust.state = 'quarantined'
  ) then 'quarantined'
  when exists (
    select 1 from trust_assessments api_trust
    where api_trust.revision_id = ${skillRevisions.id}
      and api_trust.immutable_ref = ${skillRevisions.immutableRef}
      and api_trust.content_hash = ${skillRevisions.contentHash}
      and api_trust.state = 'fail'
  ) then 'fail'
  when exists (
    select 1 from trust_assessments api_trust
    where api_trust.revision_id = ${skillRevisions.id}
      and api_trust.immutable_ref = ${skillRevisions.immutableRef}
      and api_trust.content_hash = ${skillRevisions.contentHash}
      and api_trust.state = 'warn'
  ) then 'warn'
  when exists (
    select 1 from trust_assessments api_trust
    where api_trust.revision_id = ${skillRevisions.id}
      and api_trust.immutable_ref = ${skillRevisions.immutableRef}
      and api_trust.content_hash = ${skillRevisions.contentHash}
      and api_trust.state = 'pass'
  ) then 'pass'
  else 'unreviewed'
end`;

const installsExpression = sql<number>`coalesce((
  select max(api_listing.installs)
  from source_listings api_listing
  where api_listing.skill_id = ${skills.id}
), 0)`;

const nameExpression = sql<string>`lower(${skills.upstreamName})`;

const currentObservationExpression = sql<boolean>`exists (
  select 1
  from source_listings api_listing
  join catalog_sources api_source on api_source.id = api_listing.source_id
  where api_listing.skill_id = ${skills.id}
    and api_listing.status in ('current', 'stale')
    and api_listing.source_hash = ${skillRevisions.upstreamHash}
    and api_source.enabled = 1
    and api_source.coverage_state in ('current', 'partial')
    and (
      (
        api_source.freshness_policy = 'retain'
        and exists (
          select 1
          from skill_category_observations api_observation
          join sync_runs api_observation_run
            on api_observation_run.id = api_observation.observed_run_id
            and api_observation_run.source_id = api_listing.source_id
          where api_observation.source_listing_id = api_listing.id
            and api_observation.skill_id = ${skills.id}
            and api_observation.revision_id = ${skillRevisions.id}
            and api_observation.source_hash = api_listing.source_hash
            and api_observation_run.status in ('succeeded', 'partial')
            and api_observation_run.finished_at is not null
        )
      )
      or (
        api_source.freshness_policy = 'latest-completed-observation'
        and api_listing.last_completed_observation_run_id is not null
        and exists (
          select 1
          from skill_category_observations api_certified_observation
          where api_certified_observation.source_listing_id = api_listing.id
            and api_certified_observation.observed_run_id = api_listing.last_completed_observation_run_id
            and api_certified_observation.skill_id = ${skills.id}
            and api_certified_observation.revision_id = ${skillRevisions.id}
            and api_certified_observation.source_hash = api_listing.source_hash
        )
        and api_listing.last_completed_observation_run_id = (
          select api_completed_run.id
          from sync_runs api_completed_run
          where api_completed_run.source_id = api_listing.source_id
            and api_completed_run.observation_sweep_complete = 1
            and api_completed_run.finished_at is not null
            and api_completed_run.status in ('succeeded', 'partial')
          order by api_completed_run.finished_at desc,
            api_completed_run.started_at desc,
            api_completed_run.id desc
          limit 1
        )
      )
    )
)`;

const latestAuditFailureExpression = sql<boolean>`exists (
  select 1
  from audit_records api_audit
  join source_listings api_audit_listing on api_audit_listing.id = api_audit.source_listing_id
  where api_audit_listing.skill_id = ${skills.id}
    and api_audit.scope = 'observation'
    and api_audit.status = 'fail'
    and api_audit.upstream_content_hash = ${skillRevisions.upstreamHash}
    and not exists (
      select 1
      from audit_records api_newer_audit
      where api_newer_audit.source_listing_id = api_audit.source_listing_id
        and api_newer_audit.provider = api_audit.provider
        and coalesce(api_newer_audit.provider_slug, '') = coalesce(api_audit.provider_slug, '')
        and coalesce(api_newer_audit.upstream_content_hash, '') = coalesce(api_audit.upstream_content_hash, '')
        and (
          api_newer_audit.observed_at > api_audit.observed_at
          or (
            api_newer_audit.observed_at = api_audit.observed_at
            and api_newer_audit.id > api_audit.id
          )
        )
    )
)`;

function skillSelection() {
  return {
    id: skills.id,
    name: skills.upstreamName,
    sortName: nameExpression,
    description: skills.upstreamDescription,
    compatibility: skills.compatibility,
    provider: skills.provider,
    sourceUrl: skills.sourceUrl,
    skillPath: skills.skillPath,
    lifecycle: skills.lifecycle,
    officialProvenance: skills.officialProvenance,
    catalogLicense: skills.license,
    updatedAt: skills.updatedAt,
    repositoryProvider: repositories.provider,
    repositoryUrl: repositories.normalizedUrl,
    repositoryOwner: repositories.owner,
    repositoryName: repositories.name,
    repositoryVisibility: repositories.visibility,
    revisionId: skillRevisions.id,
    immutableRef: skillRevisions.immutableRef,
    contentHash: skillRevisions.contentHash,
    upstreamHash: skillRevisions.upstreamHash,
    revisionLicense: skillRevisions.license,
    installSpec: skillRevisions.installSpecJson,
    revisionMetadata: skillRevisions.metadataJson,
    trustState: trustStateExpression,
    installs: installsExpression,
    hasCurrentObservation: currentObservationExpression,
    hasLatestAuditFailure: latestAuditFailureExpression,
    duplicateOfSkillId: skillDuplicates.duplicateOfSkillId,
  };
}

function hasCompleteArtifact(
  metadata: Record<string, unknown> | null,
  contentHash: string | null,
): boolean {
  if (!metadata || !contentHash) return false;
  const candidate = metadata.fileInventory;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const inventory = candidate as Record<string, unknown>;
  return (
    inventory.schemaVersion === 1 &&
    inventory.complete === true &&
    typeof inventory.fileCount === "number" &&
    Number.isSafeInteger(inventory.fileCount) &&
    inventory.fileCount > 0 &&
    inventory.aggregateSha256 === contentHash
  );
}

function hasVerifiedLicense(
  metadata: Record<string, unknown> | null,
  license: string,
): boolean {
  if (!metadata || license.toLowerCase() === "unknown") return false;
  const candidate = metadata.licenseEvidence;
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

function sourceBindingMatches(row: VisibleSkillRow): boolean {
  const parsed = installSpecSchema.safeParse(row.installSpec);
  if (
    !parsed.success ||
    parsed.data.kind !== "source" ||
    !row.immutableRef ||
    !row.repositoryUrl ||
    !row.repositoryOwner ||
    !row.repositoryName ||
    row.repositoryProvider !== "github" ||
    row.repositoryVisibility !== "public"
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
      coordinates[0]!.toLowerCase() === row.repositoryOwner.toLowerCase() &&
      coordinates[1]!.toLowerCase() === row.repositoryName.toLowerCase() &&
      sourceUrl === repositoryUrl &&
      normalizeSourceUrl(parsed.data.sourceUrl) === sourceUrl &&
      normalizeSkillPath(parsed.data.skillPath) === normalizeSkillPath(row.skillPath) &&
      parsed.data.immutableRef === row.immutableRef
    );
  } catch {
    return false;
  }
}

function gateReasons(row: VisibleSkillRow): SkillGateReason[] {
  const reasons: SkillGateReason[] = [];
  const add = (code: SkillGateReason["code"], message: string) => {
    reasons.push({ code, message });
  };

  if (row.lifecycle !== "current") {
    add("NOT_CURRENT", "This skill is not in the current catalog lifecycle.");
  }
  if (!row.revisionId) {
    add("MISSING_CURRENT_REVISION", "No current immutable revision is available.");
  } else if (
    !row.immutableRef ||
    !row.upstreamHash ||
    row.immutableRef !== row.upstreamHash ||
    !row.contentHash ||
    !/^[a-f0-9]{64}$/.test(row.contentHash)
  ) {
    add("UNBOUND_REVISION", "The current revision is not fully bound to observed upstream content.");
  }
  if (!hasCompleteArtifact(row.revisionMetadata, row.contentHash)) {
    add("INCOMPLETE_ARTIFACT", "A complete verified artifact inventory is not available.");
  }

  const parsedInstallSpec = installSpecSchema.safeParse(row.installSpec);
  if (!parsedInstallSpec.success) {
    add("MISSING_INSTALL_SPEC", "No validated immutable install specification is available.");
  } else if (!sourceBindingMatches(row)) {
    add("UNSUPPORTED_SOURCE", "The install source does not match the catalog provenance binding.");
  }

  if (!row.hasCurrentObservation) {
    add("NO_CURRENT_SOURCE_OBSERVATION", "No current enabled source observation matches this revision.");
  }
  const license = publicLicenseLabel(row.revisionLicense ?? row.catalogLicense);
  if (!isIndividuallySelectableLicense(license)) {
    add("LICENSE_NOT_ELIGIBLE", "The public license identifier is not eligible for individual selection.");
  }
  if (!hasVerifiedLicense(row.revisionMetadata, license)) {
    add("LICENSE_UNVERIFIED", "Revision-bound public license evidence is not available.");
  }
  if (row.trustState === "unreviewed") {
    add("TRUST_PENDING", "Revision-bound trust review has not completed.");
  } else if (row.trustState === "fail") {
    add("TRUST_BLOCKED", "Revision-bound trust review blocks selection.");
  } else if (row.trustState === "quarantined") {
    add("TRUST_QUARANTINED", "This revision is quarantined and cannot be selected.");
  }
  if (row.hasLatestAuditFailure) {
    add("UPSTREAM_AUDIT_FAILED", "The latest upstream observation failed its audit.");
  }
  if (row.duplicateOfSkillId) {
    add("DUPLICATE_MIRROR", "This row mirrors another canonical public skill.");
  }
  return reasons;
}

async function categoryMapForSkills(
  database: CatalogDatabase,
  skillIds: readonly string[],
): Promise<Map<string, Array<{ slug: string; name: string }>>> {
  const result = new Map<string, Array<{ slug: string; name: string }>>();
  if (skillIds.length === 0) return result;

  const rows = await database
    .select({ skillId: skillCategories.skillId, slug: categories.slug, name: categories.name })
    .from(skillCategories)
    .innerJoin(categories, eq(categories.id, skillCategories.categoryId))
    .where(inArray(skillCategories.skillId, [...skillIds]))
    .orderBy(asc(categories.sortOrder), asc(categories.name), asc(categories.id));
  for (const row of rows) {
    const existing = result.get(row.skillId) ?? [];
    existing.push({ slug: row.slug, name: row.name });
    result.set(row.skillId, existing);
  }
  return result;
}

function publicSkill(
  row: VisibleSkillRow,
  categoryMap: ReadonlyMap<string, Array<{ slug: string; name: string }>>,
) {
  const reasons = gateReasons(row);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    compatibility: row.compatibility,
    lifecycle: row.lifecycle,
    license: publicLicenseLabel(row.revisionLicense ?? row.catalogLicense),
    official: row.officialProvenance,
    categories: categoryMap.get(row.id) ?? [],
    installs: row.installs,
    updatedAt: row.updatedAt.toISOString(),
    provenance: {
      provider: row.provider,
      sourceUrl: row.sourceUrl,
      skillPath: row.skillPath,
      repository: row.repositoryUrl
        ? {
            provider: row.repositoryProvider,
            url: row.repositoryUrl,
            owner: row.repositoryOwner,
            name: row.repositoryName,
            visibility: row.repositoryVisibility,
          }
        : null,
    },
    revision: row.revisionId && row.contentHash
      ? { id: row.revisionId, contentDigest: `sha256:${row.contentHash}` }
      : null,
    trust: { state: row.trustState },
    selection: { selectable: reasons.length === 0, gateReasons: reasons },
  };
}

function skillsFilterHash(query: SkillsQuery): string {
  return apiFilterHash({
    q: query.q ?? null,
    category: query.category ?? null,
    source: query.source ?? null,
    compatibility: query.compatibility?.toLowerCase() ?? null,
    lifecycle: query.lifecycle,
    trust: query.trust ?? null,
    official: query.official ?? null,
    license: query.license?.toLowerCase() ?? null,
    sort: query.sort,
  });
}

function skillCursorCondition(
  query: SkillsQuery,
  cursor: ReturnType<typeof decodeCursor>,
): SQL | null {
  if (!cursor) return null;
  if (query.sort === "name") {
    const [lastName] = cursor.key;
    if (typeof lastName !== "string") throw new InvalidCursorError();
    return sql`(
      ${nameExpression} > ${lastName}
      or (${nameExpression} = ${lastName} and ${skills.id} > ${cursor.id})
    )`;
  }
  if (query.sort === "popular") {
    const [lastInstalls, lastName] = cursor.key;
    if (typeof lastInstalls !== "number" || typeof lastName !== "string") {
      throw new InvalidCursorError();
    }
    return sql`(
      ${installsExpression} < ${lastInstalls}
      or (
        ${installsExpression} = ${lastInstalls}
        and (
          ${nameExpression} > ${lastName}
          or (${nameExpression} = ${lastName} and ${skills.id} > ${cursor.id})
        )
      )
    )`;
  }

  const [lastUpdatedAt] = cursor.key;
  if (typeof lastUpdatedAt !== "number") throw new InvalidCursorError();
  const lastUpdatedAtDate = new Date(lastUpdatedAt);
  if (Number.isNaN(lastUpdatedAtDate.getTime())) throw new InvalidCursorError();
  return sql`(
    ${skills.updatedAt} < ${lastUpdatedAtDate}
    or (${skills.updatedAt} = ${lastUpdatedAtDate} and ${skills.id} > ${cursor.id})
  )`;
}

export async function listPublicSkills(database: CatalogDatabase, query: SkillsQuery) {
  const filterHash = skillsFilterHash(query);
  const cursor = decodeCursor(query.cursor, { scope: "skills", filterHash });
  const conditions: SQL[] = [
    eq(skills.public, true),
    eq(skills.internal, false),
    eq(skills.lifecycle, query.lifecycle),
  ];

  if (query.q) {
    conditions.push(sql`(
      instr(lower(${skills.upstreamName}), lower(${query.q})) > 0
      or instr(lower(coalesce(${skills.upstreamDescription}, '')), lower(${query.q})) > 0
    )`);
  }
  if (query.category) {
    conditions.push(sql`exists (
      select 1
      from skill_categories api_skill_category
      join categories api_category on api_category.id = api_skill_category.category_id
      where api_skill_category.skill_id = ${skills.id}
        and api_category.slug = ${query.category}
    )`);
  }
  if (query.source) {
    conditions.push(sql`exists (
      select 1
      from source_listings api_source_filter
      where api_source_filter.skill_id = ${skills.id}
        and api_source_filter.source_id = ${query.source}
        and api_source_filter.status <> 'removed'
    )`);
  }
  if (query.compatibility) {
    conditions.push(sql`instr(
      lower(coalesce(${skills.compatibility}, '')),
      lower(${query.compatibility})
    ) > 0`);
  }
  if (query.trust) conditions.push(sql`${trustStateExpression} = ${query.trust}`);
  if (query.official !== undefined) {
    conditions.push(eq(skills.officialProvenance, query.official));
  }
  if (query.license) {
    conditions.push(sql`lower(coalesce(${skillRevisions.license}, ${skills.license})) = ${query.license.toLowerCase()}`);
  }
  const cursorCondition = skillCursorCondition(query, cursor);
  if (cursorCondition) conditions.push(cursorCondition);

  const orderBy = query.sort === "name"
    ? [asc(nameExpression), asc(skills.id)]
    : query.sort === "recent"
      ? [desc(skills.updatedAt), asc(skills.id)]
      : [desc(installsExpression), asc(nameExpression), asc(skills.id)];

  const rows = (await database
    .select(skillSelection())
    .from(skills)
    .leftJoin(
      skillRevisions,
      and(eq(skillRevisions.skillId, skills.id), eq(skillRevisions.isCurrent, true)),
    )
    .leftJoin(repositories, eq(repositories.id, skills.repositoryId))
    .leftJoin(skillDuplicates, eq(skillDuplicates.skillId, skills.id))
    .where(and(...conditions))
    .orderBy(...orderBy)
    .limit(query.limit + 1)) as VisibleSkillRow[];

  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  const categoryMap = await categoryMapForSkills(database, pageRows.map((row) => row.id));
  const last = pageRows.at(-1);
  const nextCursor = hasMore && last
    ? encodeCursor({
        scope: "skills",
        filterHash,
        key: query.sort === "popular"
          ? [last.installs, last.sortName]
          : query.sort === "recent"
            ? [last.updatedAt.getTime()]
            : [last.sortName],
        id: last.id,
      })
    : null;

  return { items: pageRows.map((row) => publicSkill(row, categoryMap)), nextCursor };
}

export async function getPublicSkill(database: CatalogDatabase, id: string) {
  const [row] = (await database
    .select(skillSelection())
    .from(skills)
    .leftJoin(
      skillRevisions,
      and(eq(skillRevisions.skillId, skills.id), eq(skillRevisions.isCurrent, true)),
    )
    .leftJoin(repositories, eq(repositories.id, skills.repositoryId))
    .leftJoin(skillDuplicates, eq(skillDuplicates.skillId, skills.id))
    .where(and(eq(skills.id, id), eq(skills.public, true), eq(skills.internal, false)))
    .limit(1)) as VisibleSkillRow[];
  if (!row) return null;
  const categoryMap = await categoryMapForSkills(database, [row.id]);
  return publicSkill(row, categoryMap);
}

export async function listPublicCategories(database: CatalogDatabase) {
  return database
    .select({
      id: categories.id,
      slug: categories.slug,
      name: categories.name,
      description: categories.description,
      visibleCount: sql<number>`(
        select count(*)
        from skill_categories api_category_link
        join skills api_category_skill on api_category_skill.id = api_category_link.skill_id
        where api_category_link.category_id = ${categories.id}
          and api_category_skill.public = 1
          and api_category_skill.internal = 0
          and api_category_skill.lifecycle <> 'removed'
      )`,
      currentCount: sql<number>`(
        select count(*)
        from skill_categories api_current_link
        join skills api_current_skill on api_current_skill.id = api_current_link.skill_id
        where api_current_link.category_id = ${categories.id}
          and api_current_skill.public = 1
          and api_current_skill.internal = 0
          and api_current_skill.lifecycle = 'current'
      )`,
    })
    .from(categories)
    .orderBy(asc(categories.sortOrder), asc(categories.name), asc(categories.id));
}

function packagesFilterHash(query: PackagesQuery): string {
  return apiFilterHash({
    q: query.q ?? null,
    category: query.category ?? null,
    featured: query.featured ?? null,
    sort: query.sort,
  });
}

function packageSummary(row: PublishedPackageSummary) {
  const editorial = packageEditorialSchema.parse(row.editorial);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    version: row.version,
    publishedAt: row.publishedAt.toISOString(),
    memberCount: row.memberCount,
    blueprint: {
      schemaVersion: row.blueprintSchemaVersion,
      digest: row.blueprintDigest,
    },
    editorial,
  };
}

export async function listPublicPackages(
  repository: CatalogRepository,
  query: PackagesQuery,
) {
  const filterHash = packagesFilterHash(query);
  const cursor = decodeCursor(query.cursor, { scope: "packages", filterHash });
  let after: Readonly<{ key: string; id: string }> | null = null;
  if (cursor) {
    const [lastKey] = cursor.key;
    if (typeof lastKey !== "string") throw new InvalidCursorError();
    if (query.sort === "recent" && Number.isNaN(new Date(lastKey).getTime())) {
      throw new InvalidCursorError();
    }
    after = { key: lastKey, id: cursor.id };
  }

  const page = await repository.listPublishedPackagesPage({
    limit: query.limit,
    sort: query.sort,
    query: query.q ?? null,
    category: query.category ?? null,
    ...(query.featured !== undefined ? { featured: query.featured } : {}),
    after,
  });
  return {
    items: page.items.map(packageSummary),
    nextCursor: page.next
      ? encodeCursor({
          scope: "packages",
          filterHash,
          key: [page.next.key],
          id: page.next.id,
        })
      : null,
  };
}

export async function getPublicPackage(
  repository: CatalogRepository,
  slug: string,
  version?: number,
) {
  const members = await repository.resolvePackage(slug, version);
  const first = members[0];
  if (!first) return null;

  return {
    id: first.packageId,
    slug: first.slug,
    title: first.title,
    description: first.description,
    version: first.version,
    publishedAt: first.publishedAt.toISOString(),
    memberCount: members.length,
    blueprint: {
      schemaVersion: first.blueprintSchemaVersion,
      digest: first.blueprintDigest,
    },
    editorial: first.editorial,
    members: members.map((member) => ({
      position: member.position,
      selectedByDefault: member.selectedByDefault,
      binding: {
        skillId: member.skillId,
        revisionId: member.revisionId,
        immutableRef: member.immutableRef,
        contentDigest: `sha256:${member.contentHash}`,
        sourceUrl: member.sourceUrl,
        skillPath: member.skillPath,
      },
      skill: {
        name: member.name,
        description: member.description,
        license: publicLicenseLabel(member.license),
        official: member.officialProvenance,
        trust: { state: member.trustState },
        publisher: {
          owner: member.repositoryOwner,
          repository: member.repositoryName,
          defaultBranch: member.repositoryDefaultBranch,
        },
      },
    })),
  };
}

function boundedPublicExclusions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const exclusions = new Set<string>();
  for (const candidate of value.slice(0, 50)) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate
      .replace(/[\u0000-\u001f\u007f]+/gu, " ")
      .trim()
      .slice(0, 512);
    if (normalized) exclusions.add(normalized);
  }
  return [...exclusions];
}

export async function publicCoverage(repository: CatalogRepository) {
  const rows = await repository.coverage(new Date());
  const sources = rows.map((row) => ({
    id: row.sourceId,
    name: row.name,
    mode: row.mode,
    state: row.state,
    recordCount: row.recordCount,
    unavailableCount: row.unavailableCount,
    lastSuccessfulSyncAt: row.lastSuccessfulSyncAt?.toISOString() ?? null,
    lagMs: row.lagMs,
    degraded: Boolean(row.error) || !["current", "not-configured"].includes(row.state),
    exclusions: boundedPublicExclusions(row.exclusions),
  }));
  return {
    summary: {
      sourceCount: sources.length,
      currentSourceCount: sources.filter((source) => source.state === "current").length,
      degradedSourceCount: sources.filter((source) => source.degraded).length,
      observedRecordCount: sources.reduce((total, source) => total + source.recordCount, 0),
    },
    sources,
  };
}
