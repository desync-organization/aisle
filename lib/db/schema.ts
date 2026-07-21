import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const sourceModes = ["full", "incremental", "federated", "on-demand"] as const;
export const syncStatuses = ["running", "succeeded", "partial", "failed"] as const;
export const listingStatuses = ["unresolved", "current", "stale", "unavailable", "removed"] as const;
export const lifecycleStates = ["current", "stale", "unavailable", "removed"] as const;
export const trustStates = ["unreviewed", "pass", "warn", "fail", "quarantined"] as const;

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
};

export const catalogSources = sqliteTable(
  "catalog_sources",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    mode: text("mode", { enum: sourceModes }).notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    upstreamIdentifier: text("upstream_identifier").notNull(),
    termsUrl: text("terms_url"),
    coverageState: text("coverage_state").notNull().default("not-synced"),
    lastSuccessfulSyncAt: integer("last_successful_sync_at", { mode: "timestamp_ms" }),
    recordCount: integer("record_count").notNull().default(0),
    unavailableCount: integer("unavailable_count").notNull().default(0),
    lastError: text("last_error"),
    exclusionsJson: text("exclusions_json", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    ...timestamps,
  },
  (table) => [
    index("catalog_sources_mode_idx").on(table.mode),
    index("catalog_sources_coverage_idx").on(table.coverageState),
  ],
);

export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => catalogSources.id, { onDelete: "cascade" }),
    status: text("status", { enum: syncStatuses }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    cursor: text("cursor"),
    nextPage: integer("next_page").notNull().default(0),
    pageCount: integer("page_count").notNull().default(0),
    sourceTotal: integer("source_total"),
    processedCount: integer("processed_count").notNull().default(0),
    retryCount: integer("retry_count").notNull().default(0),
    nextRetryAt: integer("next_retry_at", { mode: "timestamp_ms" }),
    failure: text("failure"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    completeCrawl: integer("complete_crawl", { mode: "boolean" }).notNull().default(false),
    checkpointJson: text("checkpoint_json", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
  },
  (table) => [
    index("sync_runs_source_started_idx").on(table.sourceId, table.startedAt),
    index("sync_runs_status_idx").on(table.status),
    uniqueIndex("sync_runs_one_running_per_source_uidx")
      .on(table.sourceId)
      .where(sql`${table.status} = 'running'`),
  ],
);

export const repositories = sqliteTable(
  "repositories",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    owner: text("owner"),
    name: text("name"),
    visibility: text("visibility").notNull().default("public"),
    defaultBranch: text("default_branch"),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("repositories_provider_url_uidx").on(table.provider, table.normalizedUrl),
    index("repositories_visibility_idx").on(table.visibility),
  ],
);

export const skills = sqliteTable(
  "skills",
  {
    id: text("id").primaryKey(),
    canonicalKey: text("canonical_key").notNull(),
    provider: text("provider").notNull(),
    repositoryId: text("repository_id").references(() => repositories.id, { onDelete: "restrict" }),
    sourceUrl: text("source_url").notNull(),
    skillPath: text("skill_path").notNull(),
    upstreamName: text("upstream_name").notNull(),
    upstreamDescription: text("upstream_description"),
    compatibility: text("compatibility"),
    license: text("license").notNull().default("unknown"),
    lifecycle: text("lifecycle", { enum: lifecycleStates }).notNull().default("current"),
    public: integer("public", { mode: "boolean" }).notNull().default(true),
    internal: integer("internal", { mode: "boolean" }).notNull().default(false),
    officialProvenance: integer("official_provenance", { mode: "boolean" }).notNull().default(false),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("skills_canonical_key_uidx").on(table.canonicalKey),
    uniqueIndex("skills_provider_source_path_uidx").on(table.provider, table.sourceUrl, table.skillPath),
    index("skills_name_idx").on(table.upstreamName),
    index("skills_lifecycle_public_idx").on(table.lifecycle, table.public, table.internal),
    index("skills_repository_idx").on(table.repositoryId),
  ],
);

export const skillAliases = sqliteTable(
  "skill_aliases",
  {
    id: text("id").primaryKey(),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    alias: text("alias").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("skill_aliases_provider_alias_uidx").on(table.provider, table.alias)],
);

export const skillRevisions = sqliteTable(
  "skill_revisions",
  {
    id: text("id").primaryKey(),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    immutableRef: text("immutable_ref").notNull(),
    contentHash: text("content_hash").notNull(),
    upstreamHash: text("upstream_hash"),
    installUrl: text("install_url").notNull(),
    installSpecJson: text("install_spec_json", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    license: text("license").notNull().default("unknown"),
    metadataJson: text("metadata_json", { mode: "json" }).$type<Record<string, unknown>>(),
    isCurrent: integer("is_current", { mode: "boolean" }).notNull().default(false),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("skill_revisions_skill_ref_uidx").on(table.skillId, table.immutableRef),
    uniqueIndex("skill_revisions_id_skill_uidx").on(table.id, table.skillId),
    index("skill_revisions_content_hash_idx").on(table.contentHash),
    uniqueIndex("skill_revisions_one_current_uidx")
      .on(table.skillId)
      .where(sql`${table.isCurrent} = 1`),
  ],
);

export const skillDuplicates = sqliteTable(
  "skill_duplicates",
  {
    skillId: text("skill_id")
      .primaryKey()
      .references(() => skills.id, { onDelete: "cascade" }),
    duplicateOfSkillId: text("duplicate_of_skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    detectedAt: integer("detected_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("skill_duplicates_canonical_idx").on(table.duplicateOfSkillId)],
);

export const sourceListings = sqliteTable(
  "source_listings",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => catalogSources.id, { onDelete: "cascade" }),
    upstreamId: text("upstream_id").notNull(),
    skillId: text("skill_id").references(() => skills.id, { onDelete: "set null" }),
    sourceType: text("source_type").notNull(),
    installUrl: text("install_url"),
    sourceHash: text("source_hash"),
    detailEtag: text("detail_etag"),
    detailLastModified: text("detail_last_modified"),
    hydratedAt: integer("hydrated_at", { mode: "timestamp_ms" }),
    installs: integer("installs").notNull().default(0),
    duplicateIndicator: integer("duplicate_indicator", { mode: "boolean" }).notNull().default(false),
    status: text("status", { enum: listingStatuses }).notNull().default("unresolved"),
    rawJson: text("raw_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    lastSeenRunId: text("last_seen_run_id").references(() => syncRuns.id, { onDelete: "set null" }),
    missedCompleteCrawls: integer("missed_complete_crawls").notNull().default(0),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("source_listings_source_upstream_uidx").on(table.sourceId, table.upstreamId),
    index("source_listings_skill_idx").on(table.skillId),
    index("source_listings_status_idx").on(table.status),
    index("source_listings_hash_idx").on(table.sourceHash),
  ],
);

export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    sortOrder: integer("sort_order").notNull(),
  },
  (table) => [uniqueIndex("categories_slug_uidx").on(table.slug)],
);

export const skillCategories = sqliteTable(
  "skill_categories",
  {
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    attribution: text("attribution").notNull().default("aisle"),
  },
  (table) => [primaryKey({ columns: [table.skillId, table.categoryId] })],
);

export const auditRecords = sqliteTable(
  "audit_records",
  {
    id: text("id").primaryKey(),
    revisionId: text("revision_id").references(() => skillRevisions.id, { onDelete: "cascade" }),
    sourceListingId: text("source_listing_id").references(() => sourceListings.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: ["revision", "observation"] }).notNull(),
    provider: text("provider").notNull(),
    providerSlug: text("provider_slug"),
    status: text("status", { enum: ["pass", "warn", "fail"] }).notNull(),
    summary: text("summary").notNull(),
    riskLevel: text("risk_level"),
    upstreamContentHash: text("upstream_content_hash"),
    scannerVersion: text("scanner_version"),
    observedAt: integer("observed_at", { mode: "timestamp_ms" }).notNull(),
    rawJson: text("raw_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    index("audit_records_revision_idx").on(table.revisionId),
    index("audit_records_listing_idx").on(table.sourceListingId),
    index("audit_records_provider_idx").on(table.provider, table.observedAt),
  ],
);

export const trustAssessments = sqliteTable(
  "trust_assessments",
  {
    id: text("id").primaryKey(),
    revisionId: text("revision_id")
      .notNull()
      .references(() => skillRevisions.id, { onDelete: "cascade" }),
    scanner: text("scanner").notNull(),
    scannerVersion: text("scanner_version").notNull(),
    immutableRef: text("immutable_ref").notNull().default(""),
    contentHash: text("content_hash").notNull().default(""),
    state: text("state", { enum: trustStates }).notNull(),
    quarantineReason: text("quarantine_reason"),
    scannedAt: integer("scanned_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("trust_assessments_revision_scanner_uidx").on(table.revisionId, table.scanner),
    index("trust_assessments_state_idx").on(table.state),
  ],
);

export const trustFindings = sqliteTable(
  "trust_findings",
  {
    id: text("id").primaryKey(),
    assessmentId: text("assessment_id")
      .notNull()
      .references(() => trustAssessments.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    severity: text("severity", { enum: ["info", "warning", "critical"] }).notNull(),
    path: text("path"),
    message: text("message").notNull(),
    evidence: text("evidence"),
  },
  (table) => [index("trust_findings_assessment_idx").on(table.assessmentId)],
);

export const packages = sqliteTable(
  "packages",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    published: integer("published", { mode: "boolean" }).notNull().default(false),
    ...timestamps,
  },
  (table) => [uniqueIndex("packages_slug_uidx").on(table.slug)],
);

export const packageVersions = sqliteTable(
  "package_versions",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    blueprintSchemaVersion: integer("blueprint_schema_version").notNull().default(1),
    blueprintDigest: text("blueprint_digest").notNull().default(""),
    editorialJson: text("editorial_json", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("package_versions_package_version_uidx").on(table.packageId, table.version)],
);

export const packageMembers = sqliteTable(
  "package_members",
  {
    packageVersionId: text("package_version_id")
      .notNull()
      .references(() => packageVersions.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "restrict" }),
    revisionId: text("revision_id")
      .notNull()
      .references(() => skillRevisions.id, { onDelete: "restrict" }),
    position: integer("position").notNull(),
    selectedByDefault: integer("selected_by_default", { mode: "boolean" }).notNull().default(true),
  },
  (table) => [
    primaryKey({ columns: [table.packageVersionId, table.skillId] }),
    uniqueIndex("package_members_position_uidx").on(table.packageVersionId, table.position),
    foreignKey({
      columns: [table.revisionId, table.skillId],
      foreignColumns: [skillRevisions.id, skillRevisions.skillId],
      name: "package_members_revision_skill_fk",
    }).onDelete("restrict"),
  ],
);

export const packageMemberQuarantines = sqliteTable(
  "package_member_quarantines",
  {
    id: text("id").primaryKey(),
    packageVersionId: text("package_version_id").notNull(),
    skillId: text("skill_id").notNull(),
    revisionId: text("revision_id").notNull(),
    position: integer("position").notNull(),
    selectedByDefault: integer("selected_by_default", { mode: "boolean" }).notNull(),
    reason: text("reason").notNull(),
    quarantinedAt: integer("quarantined_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("package_member_quarantines_version_idx").on(table.packageVersionId)],
);

export const schema = {
  auditRecords,
  catalogSources,
  categories,
  packageMembers,
  packageMemberQuarantines,
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
};

export type CatalogDatabaseSchema = typeof schema;
