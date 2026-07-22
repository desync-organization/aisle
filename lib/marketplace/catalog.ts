import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { unstable_cache } from "next/cache";

import { getSharedCatalogDatabase } from "@/lib/db/client";
import { CatalogRepository } from "@/lib/db/repository";
import { normalizeSkillPath, normalizeSourceUrl } from "@/lib/catalog/normalization";
import type {
  PackageBindingIssue,
  PublishedPackageBinding,
  PublishedPackageMemberBinding,
} from "@/lib/marketplace/package-binding";
import type {
  CatalogSelectionGateReason,
  CatalogTrustState,
} from "@/lib/marketplace/selection-gates";
import { packageBlueprintDigest, type PackageBlueprint } from "@/lib/packages";

const DEFAULT_CATALOG_PAGE_SIZE = 48;
const MAX_CATALOG_PAGE_SIZE = 48;
const MAX_CATALOG_PAGE = 2_000;

function isMissingIncrementalCache(error: unknown): boolean {
  return error instanceof Error && error.message.includes("incrementalCache missing");
}

async function withCacheFallback<T>(
  loadCached: () => Promise<T>,
  loadUncached: () => Promise<T>,
): Promise<T> {
  try {
    return await loadCached();
  } catch (error) {
    if (isMissingIncrementalCache(error)) return loadUncached();
    throw error;
  }
}

export type MarketplaceSkillSummary = Readonly<{
  id: string;
  name: string;
  description: string | null;
  sourceUrl: string;
  skillPath: string;
  lifecycle: "current" | "stale" | "unavailable" | "removed";
  officialProvenance: boolean;
  immutableRef: string | null;
  license: string;
  trustState: CatalogTrustState;
  installs: number;
  selectable: boolean;
  gateReasons: ReadonlyArray<CatalogSelectionGateReason>;
}>;

export type MarketplaceSkillDetail = MarketplaceSkillSummary & Readonly<{
  provider: string;
  compatibility: string | null;
  revisionId: string | null;
  contentHash: string | null;
}>;

export type MarketplaceCategoryFacet = Readonly<{
  key: string;
  name: string;
  count: number;
}>;

export type CatalogAvailability = "ready" | "empty" | "not-configured" | "unavailable";

export type MarketplaceCatalogSnapshot = Readonly<{
  availability: CatalogAvailability;
  skills: ReadonlyArray<MarketplaceSkillSummary>;
  categories: ReadonlyArray<MarketplaceCategoryFacet>;
  connectedSources: number;
  pagination: Readonly<{
    page: number;
    pageSize: number;
    hasPrevious: boolean;
    hasNext: boolean;
  }>;
}>;

export type ResolvedPackageSnapshot = Readonly<{
  availability: "resolved" | "pending" | "binding-mismatch" | "not-configured" | "unavailable";
  expectedBlueprintDigest: string;
  binding: PublishedPackageBinding | null;
  mismatchReasons: ReadonlyArray<PackageBindingIssue>;
  members: ReadonlyArray<PublishedPackageMemberBinding>;
}>;

export type MarketplaceSkillSnapshot = Readonly<{
  availability: CatalogAvailability;
  skill: MarketplaceSkillDetail | null;
}>;

export type MarketplaceCoverageSource = Readonly<{
  id: string;
  name: string;
  upstreamIdentifier: string;
  mode: string;
  state: string;
  recordCount: number;
  unavailableCount: number;
  lastSuccessfulSyncAt: string | null;
  lagMs: number | null;
  degraded: boolean;
  exclusions: ReadonlyArray<string>;
}>;

export type MarketplaceCoverageSnapshot = Readonly<{
  availability: "ready" | "not-configured" | "unavailable";
  sources: ReadonlyArray<MarketplaceCoverageSource>;
  summary: Readonly<{
    sourceCount: number;
    currentSourceCount: number;
    observedRecordCount: number;
    latestSuccessfulSyncAt: string | null;
  }>;
}>;

function hasConfiguredDatabase(): boolean {
  if (process.env.DATABASE_URL) return true;
  return existsSync(resolve(process.cwd(), "data", "aisle.db"));
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  const candidate = Number.isFinite(value) ? Math.trunc(value ?? fallback) : fallback;
  return Math.min(Math.max(candidate, 1), maximum);
}

function boundedExclusions(value: unknown): string[] {
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

async function loadMarketplaceCatalogUncached(
  options: Readonly<{
    query?: string;
    category?: string;
    page?: number;
    pageSize?: number;
    limit?: number;
    includeUnavailable?: boolean;
    includeSkills?: boolean;
    includeFacets?: boolean;
    includeCoverage?: boolean;
  }> = {},
): Promise<MarketplaceCatalogSnapshot> {
  const page = boundedInteger(options.page, 1, MAX_CATALOG_PAGE);
  const pageSize = boundedInteger(
    options.pageSize ?? options.limit,
    DEFAULT_CATALOG_PAGE_SIZE,
    MAX_CATALOG_PAGE_SIZE,
  );
  const pagination = {
    page,
    pageSize,
    hasPrevious: page > 1,
    hasNext: false,
  } as const;

  if (!hasConfiguredDatabase()) {
    return {
      availability: "not-configured",
      skills: [],
      categories: [],
      connectedSources: 0,
      pagination,
    };
  }

  const connection = getSharedCatalogDatabase();
  const repository = new CatalogRepository(connection.db);

  try {
    const [rows, facets, coverage] = await Promise.all([
      options.includeSkills === false
        ? Promise.resolve([])
        : repository.search({
            query: options.query,
            category: options.category,
            includeUnselectable: options.includeUnavailable === true,
            lifecycle: ["current", "stale"],
            limit: pageSize + 1,
            offset: (page - 1) * pageSize,
          }),
      options.includeFacets === false
        ? Promise.resolve({ lifecycle: [], category: [] })
        : repository.facets(),
      options.includeCoverage === false ? Promise.resolve([]) : repository.coverage(),
    ]);

    const hasNext = rows.length > pageSize;
    const skills = rows.slice(0, pageSize).map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      sourceUrl: row.sourceUrl,
      skillPath: row.skillPath,
      lifecycle: row.lifecycle,
      officialProvenance: row.officialProvenance,
      immutableRef: row.immutableRef,
      license: row.license,
      trustState: row.trustState,
      installs: row.installs,
      selectable: row.selectable,
      gateReasons: row.gateReasons,
    }));

    return {
      availability: skills.length > 0 ? "ready" : "empty",
      skills,
      categories: facets.category,
      connectedSources: coverage.filter((source) => source.lastSuccessfulSyncAt !== null).length,
      pagination: { page, pageSize, hasPrevious: page > 1, hasNext },
    };
  } catch {
    return {
      availability: "unavailable",
      skills: [],
      categories: [],
      connectedSources: 0,
      pagination,
    };
  }
}

const loadCachedMarketplaceCatalog = unstable_cache(
  loadMarketplaceCatalogUncached,
  ["marketplace-catalog-v2"],
  { revalidate: 60, tags: ["marketplace-catalog"] },
);

export async function loadMarketplaceCatalog(
  options: Parameters<typeof loadMarketplaceCatalogUncached>[0] = {},
): Promise<MarketplaceCatalogSnapshot> {
  return withCacheFallback(
    () => loadCachedMarketplaceCatalog(options),
    () => loadMarketplaceCatalogUncached(options),
  );
}

async function loadMarketplaceCoverageUncached(): Promise<MarketplaceCoverageSnapshot> {
  const emptySummary = {
    sourceCount: 0,
    currentSourceCount: 0,
    observedRecordCount: 0,
    latestSuccessfulSyncAt: null,
  } as const;
  if (!hasConfiguredDatabase()) {
    return { availability: "not-configured", sources: [], summary: emptySummary };
  }

  const connection = getSharedCatalogDatabase();
  const repository = new CatalogRepository(connection.db);
  try {
    const rows = await repository.coverage(new Date());
    const sources = rows.map((row) => ({
      id: row.sourceId,
      name: row.name,
      upstreamIdentifier: row.upstreamIdentifier,
      mode: row.mode,
      state: row.state,
      recordCount: row.recordCount,
      unavailableCount: row.unavailableCount,
      lastSuccessfulSyncAt: row.lastSuccessfulSyncAt?.toISOString() ?? null,
      lagMs: row.lagMs,
      degraded: Boolean(row.error) || !["current", "not-configured"].includes(row.state),
      exclusions: boundedExclusions(row.exclusions),
    }));
    const successful = sources
      .map((source) => source.lastSuccessfulSyncAt)
      .filter((value): value is string => value !== null)
      .sort();
    return {
      availability: "ready",
      sources,
      summary: {
        sourceCount: sources.length,
        currentSourceCount: sources.filter((source) => source.state === "current").length,
        observedRecordCount: sources.reduce(
          (total, source) => total + source.recordCount,
          0,
        ),
        latestSuccessfulSyncAt: successful.at(-1) ?? null,
      },
    };
  } catch {
    return { availability: "unavailable", sources: [], summary: emptySummary };
  }
}

const loadCachedMarketplaceCoverage = unstable_cache(
  loadMarketplaceCoverageUncached,
  ["marketplace-coverage-v2"],
  { revalidate: 60, tags: ["marketplace-coverage"] },
);

export async function loadMarketplaceCoverage(): Promise<MarketplaceCoverageSnapshot> {
  return withCacheFallback(loadCachedMarketplaceCoverage, loadMarketplaceCoverageUncached);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value) ?? null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) ?? null : null;
  }
  if (Array.isArray(value)) {
    const entries = value.map(canonicalJson);
    return entries.some((entry) => entry === null) ? null : `[${entries.join(",")}]`;
  }
  if (!isRecord(value)) return null;
  const entries = Object.keys(value).sort().map((key) => {
    const serialized = canonicalJson(value[key]);
    return serialized === null ? null : `${JSON.stringify(key) ?? '""'}:${serialized}`;
  });
  return entries.some((entry) => entry === null) ? null : `{${entries.join(",")}}`;
}

function inspectPublishedPackage(
  rows: ReadonlyArray<unknown>,
  blueprint: PackageBlueprint,
  expectedBlueprintDigest: string,
): Omit<ResolvedPackageSnapshot, "availability" | "expectedBlueprintDigest"> & Readonly<{
  exact: boolean;
}> {
  const mismatchReasons = new Set<PackageBindingIssue>();
  const records = rows.filter(isRecord);
  const first = records[0];
  if (!first || records.length !== rows.length) {
    return {
      exact: false,
      binding: null,
      mismatchReasons: ["publication-metadata-missing"],
      members: [],
    };
  }

  const versionId = typeof first.versionId === "string" && first.versionId.length > 0
    ? first.versionId
    : null;
  const version = typeof first.version === "number" && Number.isSafeInteger(first.version) && first.version > 0
    ? first.version
    : null;
  const blueprintSchemaVersion = typeof first.blueprintSchemaVersion === "number" &&
    Number.isSafeInteger(first.blueprintSchemaVersion) &&
    first.blueprintSchemaVersion > 0
    ? first.blueprintSchemaVersion
    : null;
  const blueprintDigest = typeof first.blueprintDigest === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(first.blueprintDigest)
    ? first.blueprintDigest
    : null;
  const editorial = isRecord(first.editorial) ? first.editorial : null;

  if (!versionId || version === null || blueprintSchemaVersion === null || !blueprintDigest || !editorial) {
    mismatchReasons.add("publication-metadata-missing");
  }

  const binding: PublishedPackageBinding | null = versionId &&
    version !== null &&
    blueprintSchemaVersion !== null &&
    blueprintDigest &&
    editorial
    ? { versionId, version, blueprintSchemaVersion, blueprintDigest, editorial }
    : null;

  if (blueprintDigest && blueprintDigest !== expectedBlueprintDigest) {
    mismatchReasons.add("blueprint-digest-mismatch");
  }
  if (blueprintSchemaVersion !== null && blueprintSchemaVersion !== blueprint.schemaVersion) {
    mismatchReasons.add("schema-version-mismatch");
  }
  if (
    editorial &&
    canonicalJson(editorial) !== canonicalJson(blueprint.editorial)
  ) {
    mismatchReasons.add("editorial-mismatch");
  }
  if (
    first.slug !== blueprint.slug ||
    first.title !== blueprint.editorial.title ||
    first.description !== blueprint.editorial.summary
  ) {
    mismatchReasons.add("editorial-mismatch");
  }
  if (records.length !== blueprint.members.length) {
    mismatchReasons.add("member-count-mismatch");
  }

  const members: PublishedPackageMemberBinding[] = [];
  const recordsByPosition = new Map<number, Record<string, unknown>>();
  for (const row of records) {
    if (typeof row.position !== "number" || !Number.isSafeInteger(row.position)) {
      mismatchReasons.add("member-count-mismatch");
      continue;
    }
    if (recordsByPosition.has(row.position)) mismatchReasons.add("member-count-mismatch");
    recordsByPosition.set(row.position, row);

    if (
      row.versionId !== versionId ||
      row.version !== version ||
      row.blueprintSchemaVersion !== blueprintSchemaVersion ||
      row.blueprintDigest !== blueprintDigest ||
      canonicalJson(row.editorial) !== canonicalJson(editorial)
    ) {
      mismatchReasons.add("publication-metadata-missing");
    }
  }

  for (const expected of blueprint.members) {
    const row = recordsByPosition.get(expected.position);
    if (!row) {
      mismatchReasons.add("member-count-mismatch");
      continue;
    }

    let normalizedLocatorMatches = false;
    if (typeof row.sourceUrl === "string" && typeof row.skillPath === "string") {
      try {
        normalizedLocatorMatches =
          normalizeSourceUrl(row.sourceUrl) === normalizeSourceUrl(expected.locator.repositoryUrl) &&
          normalizeSkillPath(row.skillPath) === normalizeSkillPath(expected.locator.skillPath);
      } catch {
        normalizedLocatorMatches = false;
      }
    }
    const locatorMatches = normalizedLocatorMatches &&
      row.name === expected.locator.upstreamSkillName &&
      row.selectedByDefault === expected.defaultSelected;
    if (!locatorMatches) mismatchReasons.add("member-locator-mismatch");

    const expectedHead = expected.observedSource?.headSha;
    const revisionMatches = typeof expectedHead === "string" &&
      row.immutableRef === expectedHead &&
      typeof row.skillId === "string" &&
      row.skillId.length > 0 &&
      typeof row.revisionId === "string" &&
      row.revisionId.length > 0 &&
      typeof row.contentHash === "string" &&
      row.contentHash.length > 0 &&
      (row.trustState === "pass" || row.trustState === "warn");
    if (!revisionMatches) mismatchReasons.add("member-revision-mismatch");
    if (row.license !== expected.observedLicense.spdx) {
      mismatchReasons.add("member-license-mismatch");
    }

    if (
      typeof row.skillId === "string" &&
      typeof row.name === "string" &&
      typeof row.sourceUrl === "string" &&
      typeof row.skillPath === "string" &&
      typeof row.revisionId === "string" &&
      typeof row.immutableRef === "string" &&
      typeof row.contentHash === "string" &&
      typeof row.license === "string" &&
      (row.trustState === "pass" || row.trustState === "warn")
    ) {
      members.push({
        position: expected.position,
        skillId: row.skillId,
        name: row.name,
        sourceUrl: row.sourceUrl,
        skillPath: row.skillPath,
        revisionId: row.revisionId,
        immutableRef: row.immutableRef,
        contentHash: row.contentHash,
        license: row.license,
        trustState: row.trustState,
      });
    }
  }

  if (members.length !== blueprint.members.length) mismatchReasons.add("member-count-mismatch");
  if (
    new Set(members.map((member) => member.skillId)).size !== members.length ||
    new Set(members.map((member) => member.revisionId)).size !== members.length ||
    new Set(members.map((member) => member.contentHash)).size !== members.length
  ) {
    mismatchReasons.add("member-revision-mismatch");
  }
  return {
    exact: mismatchReasons.size === 0 && binding !== null,
    binding,
    mismatchReasons: [...mismatchReasons],
    members,
  };
}

async function loadResolvedPackagesUncached(
  blueprints: readonly PackageBlueprint[],
): Promise<ResolvedPackageSnapshot[]> {
  if (!hasConfiguredDatabase()) {
    return blueprints.map((blueprint) => ({
      availability: "not-configured",
      expectedBlueprintDigest: packageBlueprintDigest(blueprint),
      binding: null,
      mismatchReasons: [],
      members: [],
    }));
  }

  const connection = getSharedCatalogDatabase();
  const repository = new CatalogRepository(connection.db);

  try {
    const rowsBySlug = await repository.resolvePackages(blueprints.map((blueprint) => blueprint.slug));
    return blueprints.map((blueprint) => {
      const expectedBlueprintDigest = packageBlueprintDigest(blueprint);
      const rows = rowsBySlug.get(blueprint.slug) ?? [];
      if (rows.length === 0) {
        return {
          availability: "pending",
          expectedBlueprintDigest,
          binding: null,
          mismatchReasons: [],
          members: [],
        };
      }
      const inspected = inspectPublishedPackage(rows, blueprint, expectedBlueprintDigest);
      return {
        availability: inspected.exact ? "resolved" : "binding-mismatch",
        expectedBlueprintDigest,
        binding: inspected.binding,
        mismatchReasons: inspected.mismatchReasons,
        members: inspected.members,
      };
    });
  } catch {
    return blueprints.map((blueprint) => ({
      availability: "unavailable",
      expectedBlueprintDigest: packageBlueprintDigest(blueprint),
      binding: null,
      mismatchReasons: [],
      members: [],
    }));
  }
}

const loadCachedResolvedPackages = unstable_cache(
  loadResolvedPackagesUncached,
  ["resolved-packages-v2"],
  { revalidate: 300, tags: ["resolved-packages"] },
);

export async function loadResolvedPackages(
  blueprints: readonly PackageBlueprint[],
): Promise<ResolvedPackageSnapshot[]> {
  return withCacheFallback(
    () => loadCachedResolvedPackages(blueprints),
    () => loadResolvedPackagesUncached(blueprints),
  );
}

export async function loadResolvedPackage(
  blueprint: PackageBlueprint,
): Promise<ResolvedPackageSnapshot> {
  const [resolved] = await loadResolvedPackages([blueprint]);
  return resolved!;
}

async function loadMarketplaceSkillUncached(id: string): Promise<MarketplaceSkillSnapshot> {
  if (!hasConfiguredDatabase()) {
    return { availability: "not-configured", skill: null };
  }

  const connection = getSharedCatalogDatabase();
  const repository = new CatalogRepository(connection.db);

  try {
    const [row] = await repository.search({
      id,
      includeUnselectable: true,
      lifecycle: ["current", "stale"],
      limit: 1,
    });
    if (!row) return { availability: "empty", skill: null };

    return {
      availability: "ready",
      skill: {
        id: row.id,
        name: row.name,
        description: row.description,
        provider: row.provider,
        sourceUrl: row.sourceUrl,
        skillPath: row.skillPath,
        compatibility: row.compatibility,
        lifecycle: row.lifecycle,
        officialProvenance: row.officialProvenance,
        revisionId: row.revisionId,
        immutableRef: row.immutableRef,
        contentHash: row.contentHash,
        license: row.license,
        trustState: row.trustState,
        installs: row.installs,
        selectable: row.selectable,
        gateReasons: row.gateReasons,
      },
    };
  } catch {
    return { availability: "unavailable", skill: null };
  }
}

const loadCachedMarketplaceSkill = unstable_cache(
  loadMarketplaceSkillUncached,
  ["marketplace-skill-v2"],
  { revalidate: 300, tags: ["marketplace-skill"] },
);

export async function loadMarketplaceSkill(id: string): Promise<MarketplaceSkillSnapshot> {
  return withCacheFallback(
    () => loadCachedMarketplaceSkill(id),
    () => loadMarketplaceSkillUncached(id),
  );
}
