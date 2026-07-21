import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { createCatalogDatabase } from "@/lib/db/client";
import { CatalogRepository } from "@/lib/db/repository";
import type {
  CatalogSelectionGateReason,
  CatalogTrustState,
} from "@/lib/marketplace/selection-gates";

const DEFAULT_CATALOG_PAGE_SIZE = 48;
const MAX_CATALOG_PAGE_SIZE = 48;
const MAX_CATALOG_PAGE = 2_000;

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
  availability: "resolved" | "pending" | "not-configured" | "unavailable";
  members: ReadonlyArray<
    Readonly<{
      position: number;
      skillId: string;
      name: string;
      trustState: "unreviewed" | "pass" | "warn";
      immutableRef: string;
    }>
  >;
}>;

export type MarketplaceSkillSnapshot = Readonly<{
  availability: CatalogAvailability;
  skill: MarketplaceSkillDetail | null;
}>;

function hasConfiguredDatabase(): boolean {
  if (process.env.DATABASE_URL) return true;
  return existsSync(resolve(process.cwd(), "data", "aisle.db"));
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  const candidate = Number.isFinite(value) ? Math.trunc(value ?? fallback) : fallback;
  return Math.min(Math.max(candidate, 1), maximum);
}

export async function loadMarketplaceCatalog(
  options: Readonly<{
    query?: string;
    category?: string;
    page?: number;
    pageSize?: number;
    limit?: number;
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

  const connection = createCatalogDatabase();
  const repository = new CatalogRepository(connection.db);

  try {
    const [rows, facets, coverage] = await Promise.all([
      repository.search({
        query: options.query,
        category: options.category,
        includeUnselectable: true,
        lifecycle: ["current", "stale"],
        limit: pageSize + 1,
        offset: (page - 1) * pageSize,
      }),
      repository.facets(),
      repository.coverage(),
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
  } finally {
    connection.client.close();
  }
}

export async function loadResolvedPackage(slug: string): Promise<ResolvedPackageSnapshot> {
  if (!hasConfiguredDatabase()) {
    return { availability: "not-configured", members: [] };
  }

  const connection = createCatalogDatabase();
  const repository = new CatalogRepository(connection.db);

  try {
    const rows = await repository.resolvePackage(slug);
    if (rows.length === 0) return { availability: "pending", members: [] };

    return {
      availability: "resolved",
      members: rows.map((row) => ({
        position: row.position,
        skillId: row.skillId,
        name: row.name,
        trustState: row.trustState,
        immutableRef: row.immutableRef,
      })),
    };
  } catch {
    return { availability: "unavailable", members: [] };
  } finally {
    connection.client.close();
  }
}

export async function loadMarketplaceSkill(id: string): Promise<MarketplaceSkillSnapshot> {
  if (!hasConfiguredDatabase()) {
    return { availability: "not-configured", skill: null };
  }

  const connection = createCatalogDatabase();
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
  } finally {
    connection.client.close();
  }
}
