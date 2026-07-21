import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { createCatalogDatabase } from "@/lib/db/client";
import { CatalogRepository } from "@/lib/db/repository";

export type MarketplaceSkillSummary = Readonly<{
  id: string;
  name: string;
  description: string | null;
  sourceUrl: string;
  skillPath: string;
  lifecycle: "current" | "stale" | "unavailable" | "removed";
  officialProvenance: boolean;
  immutableRef: string;
  license: string;
  trustState: "unreviewed" | "pass" | "warn";
  installs: number;
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

function hasConfiguredDatabase(): boolean {
  if (process.env.DATABASE_URL) return true;
  return existsSync(resolve(process.cwd(), "data", "aisle.db"));
}

export async function loadMarketplaceCatalog(
  options: Readonly<{ query?: string; category?: string; limit?: number }> = {},
): Promise<MarketplaceCatalogSnapshot> {
  if (!hasConfiguredDatabase()) {
    return {
      availability: "not-configured",
      skills: [],
      categories: [],
      connectedSources: 0,
    };
  }

  const connection = createCatalogDatabase();
  const repository = new CatalogRepository(connection.db);

  try {
    const [rows, facets, coverage] = await Promise.all([
      repository.search({
        query: options.query,
        category: options.category,
        limit: options.limit ?? 100,
      }),
      repository.facets(),
      repository.coverage(),
    ]);

    const skills = rows.map((row) => ({
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
    }));

    return {
      availability: skills.length > 0 ? "ready" : "empty",
      skills,
      categories: facets.category,
      connectedSources: coverage.filter((source) => source.lastSuccessfulSyncAt !== null).length,
    };
  } catch {
    return {
      availability: "unavailable",
      skills: [],
      categories: [],
      connectedSources: 0,
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
