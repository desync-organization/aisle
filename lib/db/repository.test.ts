// @vitest-environment node

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCatalogDatabase, type CatalogDatabaseConnection } from "./client";
import { migrateCatalogDatabase } from "./migrate";
import { CatalogRepository } from "./repository";
import {
  categories,
  packageMembers,
  packages,
  packageVersions,
  repositories,
  skillCategories,
  skillRevisions,
  skills,
  sourceListings,
  trustAssessments,
} from "./schema";
import { seedCatalog, sourceDescriptorSeed, taxonomySeed } from "./seed";

describe("catalog database and repository", () => {
  let connection: CatalogDatabaseConnection;
  let repository: CatalogRepository;
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "aisle-catalog-test-"));
    connection = createCatalogDatabase({
      url: `file:${join(temporaryDirectory, "catalog.db").replaceAll("\\", "/")}`,
    });
    await migrateCatalogDatabase(connection.client);
    repository = new CatalogRepository(connection.db);
  });

  afterEach(() => {
    connection?.client.close();
  });

  it("applies migrations and deterministic seeds idempotently", async () => {
    await migrateCatalogDatabase(connection.client);
    await seedCatalog(repository);
    await seedCatalog(repository);

    const categoryRows = await connection.db
      .select({ count: sql<number>`count(*)` })
      .from(categories);
    const sources = await repository.coverage();
    const foreignKeys = await connection.client.execute("PRAGMA foreign_key_list('skill_revisions')");

    expect(categoryRows[0]?.count).toBe(taxonomySeed.length);
    expect(sources).toHaveLength(sourceDescriptorSeed.length);
    expect(sources.find((source) => source.sourceId === "skills-sh")).toMatchObject({
      mode: "full",
      state: "not-synced",
      recordCount: 0,
    });
    expect(
      sourceDescriptorSeed.find((source) => source.id === "well-known-skills")?.baseUrl,
    ).toContain("/.well-known/agent-skills/index.json");
    expect(foreignKeys.rows.some((row) => row.table === "skills")).toBe(true);
  });

  it("supports searchable catalog rows, facets, and ordered package resolution", async () => {
    await seedCatalog(repository);
    const now = new Date("2026-07-20T12:00:00.000Z");
    const repoId = "repo_fixture_public";
    const skillId = "skill_fixture_public";
    const revisionId = "revision_fixture_public";

    await connection.db.insert(repositories).values({
      id: repoId,
      provider: "github",
      normalizedUrl: "https://github.com/example/public-skill-fixture",
      owner: "example",
      name: "public-skill-fixture",
      visibility: "public",
      defaultBranch: "main",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await connection.db.insert(skills).values({
      id: skillId,
      canonicalKey: "github:https://github.com/example/public-skill-fixture:skills/catalog-fixture",
      provider: "github",
      repositoryId: repoId,
      sourceUrl: "https://github.com/example/public-skill-fixture",
      skillPath: "skills/catalog-fixture",
      upstreamName: "catalog-fixture",
      upstreamDescription: "Inert database fixture used only by repository tests.",
      license: "MIT",
      lifecycle: "current",
      public: true,
      internal: false,
      createdAt: now,
      updatedAt: now,
    });
    await connection.db.insert(skills).values({
      id: "skill_fixture_unresolved",
      canonicalKey: "github:https://github.com/example/unresolved:skills/catalog-fixture-unresolved",
      provider: "github",
      sourceUrl: "https://github.com/example/unresolved",
      skillPath: "skills/catalog-fixture-unresolved",
      upstreamName: "catalog-fixture-unresolved",
      upstreamDescription: "This unresolved fixture has no immutable revision.",
      lifecycle: "current",
      public: true,
      internal: false,
      createdAt: now,
      updatedAt: now,
    });
    await connection.db.insert(skillRevisions).values({
      id: revisionId,
      skillId,
      immutableRef: "0000000000000000000000000000000000000000",
      contentHash: "0".repeat(64),
      installUrl:
        "https://github.com/example/public-skill-fixture/tree/0000000000000000000000000000000000000000/skills/catalog-fixture",
      isCurrent: true,
      firstSeenAt: now,
      lastSeenAt: now,
    });
    await connection.db.insert(sourceListings).values({
      id: "listing_fixture_public",
      sourceId: "skills-sh",
      upstreamId: "example/public-skill-fixture/catalog-fixture",
      skillId,
      sourceType: "github",
      installUrl: "https://github.com/example/public-skill-fixture",
      sourceHash: "0".repeat(64),
      installs: 42,
      status: "current",
      rawJson: { fixture: true },
      firstSeenAt: now,
      lastSeenAt: now,
    });
    await connection.db.insert(trustAssessments).values({
      id: "assessment_fixture_baseline",
      revisionId,
      scanner: "fixture-baseline-scanner",
      scannerVersion: "1.0.0",
      immutableRef: "0000000000000000000000000000000000000000",
      contentHash: "0".repeat(64),
      state: "pass",
      scannedAt: now,
    });

    const [frontend] = await connection.db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.slug, "frontend"));
    expect(frontend).toBeDefined();
    await connection.db.insert(skillCategories).values({
      skillId,
      categoryId: frontend!.id,
    });

    await connection.db.insert(packages).values({
      id: "package_fixture",
      slug: "fixture-stack",
      title: "Fixture stack",
      description: "Inert package fixture.",
      published: true,
      createdAt: now,
      updatedAt: now,
    });
    await connection.db.insert(packageVersions).values({
      id: "package_version_fixture",
      packageId: "package_fixture",
      version: 1,
      publishedAt: now,
      createdAt: now,
    });
    await connection.db.insert(packageVersions).values({
      id: "package_version_fixture_v2",
      packageId: "package_fixture",
      version: 2,
      publishedAt: now,
      createdAt: now,
    });
    await connection.db.insert(packageMembers).values({
      packageVersionId: "package_version_fixture",
      skillId,
      revisionId,
      position: 0,
    });
    await connection.db.insert(packageMembers).values({
      packageVersionId: "package_version_fixture_v2",
      skillId,
      revisionId,
      position: 0,
    });

    const results = await repository.search({ query: "database fixture", category: "frontend" });
    const facets = await repository.facets();
    const resolvedPackage = await repository.resolvePackage("fixture-stack");

    expect(results).toEqual([
      expect.objectContaining({
        id: skillId,
        revisionId,
        installs: 42,
      }),
    ]);
    expect(facets.category.find((facet) => facet.key === "frontend")?.count).toBe(1);
    expect(facets.category.find((facet) => facet.key === "backend")?.count).toBe(0);
    expect(resolvedPackage).toEqual([
      expect.objectContaining({
        slug: "fixture-stack",
        version: 2,
        skillId,
        revisionId,
        position: 0,
      }),
    ]);

    await repository.recordObservedAudits({
      listingId: "listing_fixture_public",
      upstreamContentHash: "0".repeat(64),
      audits: [
        {
          provider: "Fixture upstream",
          providerSlug: "fixture-upstream",
          status: "fail",
          summary: "First inert observation failed.",
          auditedAt: "2026-07-20T10:00:00.000Z",
          raw: {},
        },
      ],
    });
    expect(await repository.search()).toEqual([]);
    expect(await repository.resolvePackage("fixture-stack")).toEqual([]);

    await repository.recordObservedAudits({
      listingId: "listing_fixture_public",
      upstreamContentHash: "0".repeat(64),
      audits: [
        {
          provider: "Fixture upstream",
          providerSlug: "fixture-upstream",
          status: "pass",
          summary: "Later inert observation passed.",
          auditedAt: "2026-07-20T11:00:00.000Z",
          raw: {},
        },
      ],
    });
    expect(await repository.search()).toHaveLength(1);
    expect(await repository.resolvePackage("fixture-stack")).toHaveLength(1);

    await repository.recordObservedAudits({
      listingId: "listing_fixture_public",
      upstreamContentHash: "0".repeat(64),
      audits: [
        {
          provider: "Fixture upstream",
          providerSlug: "fixture-upstream",
          status: "fail",
          summary: "Newest inert observation failed.",
          auditedAt: "2026-07-20T12:00:00.000Z",
          raw: {},
        },
      ],
    });
    expect(await repository.search()).toEqual([]);
    expect(await repository.resolvePackage("fixture-stack")).toEqual([]);

    await repository.recordObservedAudits({
      listingId: "listing_fixture_public",
      upstreamContentHash: "0".repeat(64),
      audits: [
        {
          provider: "Fixture upstream",
          providerSlug: "fixture-upstream",
          status: "pass",
          summary: "Final inert observation passed before local blocking test.",
          auditedAt: "2026-07-20T13:00:00.000Z",
          raw: {},
        },
      ],
    });

    await connection.db.insert(trustAssessments).values([
      {
        id: "assessment_fixture_pass",
        revisionId,
        scanner: "fixture-pass-scanner",
        scannerVersion: "1.0.0",
        state: "pass",
        scannedAt: now,
      },
      {
        id: "assessment_fixture_fail",
        revisionId,
        scanner: "fixture-fail-scanner",
        scannerVersion: "1.0.0",
        state: "fail",
        quarantineReason: "Critical inert test finding.",
        scannedAt: now,
      },
    ]);

    expect(await repository.search({ query: "catalog-fixture" })).toEqual([]);
    expect(await repository.resolvePackage("fixture-stack")).toEqual([]);
  });
});
