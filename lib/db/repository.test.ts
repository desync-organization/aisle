// @vitest-environment node

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCatalogDatabase, type CatalogDatabaseConnection } from "./client";
import type { PersistedAuditRaw } from "../catalog/provider-raw";
import { migrateCatalogDatabase } from "./migrate";
import { CatalogRepository } from "./repository";
import {
  categories,
  packageMembers,
  packages,
  packageVersions,
  repositories,
  skillRevisions,
  skills,
  sourceListings,
  trustAssessments,
} from "./schema";
import { seedCatalog, sourceDescriptorSeed, taxonomySeed } from "./seed";

function fixtureAuditRaw(
  status: "pass" | "warn" | "fail",
  summary: string,
  auditedAt: string,
): PersistedAuditRaw {
  return {
    kind: "skills-sh-audit",
    provider: "Fixture upstream",
    slug: "fixture-upstream",
    status,
    summary,
    auditedAt,
    riskLevel: null,
  };
}

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
    const run = await repository.acquireSyncRun("skills-sh");
    const fence = {
      sourceId: "skills-sh",
      runId: run.id,
      leaseToken: run.leaseToken,
    };
    const now = new Date("2026-07-20T12:00:00.000Z");
    const repoId = "repo_fixture_public";
    const skillId = "skill_fixture_public";
    const revisionId = "revision_fixture_public";
    const observedHead = "0000000000000000000000000000000000000000";
    const contentHash = "0".repeat(64);
    const packageSummary = "Inert package fixture used by repository resolution tests only.";
    const packageEditorial = {
      title: "Fixture stack",
      summary: packageSummary,
      outcome: "Proves package resolution keeps exact public provenance bindings.",
      audience: ["Repository tests"],
      category: "frontend",
      tags: ["fixture", "repository"],
      featured: false,
      reviewedAt: "2026-07-20",
      visual: {
        iconToken: "brackets",
        colorToken: "iris",
      },
    };

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
      immutableRef: observedHead,
      contentHash,
      upstreamHash: observedHead,
      installUrl:
        "https://github.com/example/public-skill-fixture/tree/0000000000000000000000000000000000000000/skills/catalog-fixture",
      installSpecJson: {
        kind: "source",
        sourceUrl: "https://github.com/example/public-skill-fixture",
        immutableRef: observedHead,
        skillPath: "skills/catalog-fixture",
      },
      license: "MIT",
      metadataJson: {
        fileInventory: {
          schemaVersion: 1,
          complete: true,
          fileCount: 1,
          aggregateSha256: contentHash,
        },
        licenseEvidence: {
          source: "frontmatter-spdx",
          path: "SKILL.md",
          sha256: contentHash,
        },
      },
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
      sourceHash: observedHead,
      installs: 42,
      status: "current",
      rawJson: { fixture: true },
      lastSeenRunId: run.id,
      firstSeenAt: now,
      lastSeenAt: now,
    });
    await connection.db.insert(trustAssessments).values({
      id: "assessment_fixture_baseline",
      revisionId,
      scanner: "fixture-baseline-scanner",
      scannerVersion: "1.0.0",
      immutableRef: observedHead,
      contentHash,
      state: "pass",
      scannedAt: now,
    });

    const [frontend] = await connection.db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.slug, "frontend"));
    expect(frontend).toBeDefined();
    await repository.replaceSkillCategoryEvidence({
      fence,
      listingId: "listing_fixture_public",
      skillId,
      revisionId,
      sourceHash: observedHead,
      categorySlugs: ["frontend"],
    });
    await repository.finishSyncRun({
      runId: run.id,
      leaseToken: run.leaseToken,
      sourceId: "skills-sh",
      sourceTotal: 1,
      recordCount: 1,
      completeCrawl: true,
      observationSweepComplete: true,
    });

    await connection.db.insert(packages).values({
      id: "package_fixture",
      slug: "fixture-stack",
      title: "Fixture stack",
      description: packageSummary,
      published: true,
      createdAt: now,
      updatedAt: now,
    });
    await connection.db.insert(packageVersions).values({
      id: "package_version_fixture",
      packageId: "package_fixture",
      version: 1,
      blueprintSchemaVersion: 1,
      blueprintDigest: `sha256:${"1".repeat(64)}`,
      editorialJson: packageEditorial,
      publishedAt: now,
      createdAt: now,
    });
    await connection.db.insert(packageVersions).values({
      id: "package_version_fixture_v2",
      packageId: "package_fixture",
      version: 2,
      blueprintSchemaVersion: 1,
      blueprintDigest: `sha256:${"2".repeat(64)}`,
      editorialJson: packageEditorial,
      publishedAt: now,
      createdAt: now,
    });
    await connection.db.insert(packageMembers).values({
      packageVersionId: "package_version_fixture",
      skillId,
      revisionId,
      position: 0,
      upstreamRepositoryUrl: "https://github.com/example/public-skill-fixture",
      upstreamSkillPath: "skills/catalog-fixture",
      upstreamSkillName: "catalog-fixture",
      observedHead,
      observedLicense: "MIT",
      licenseEvidenceClass: "skill-frontmatter",
      licenseEvidencePath: "skills/catalog-fixture/SKILL.md",
      publisherClass: "community",
    });
    await connection.db.insert(packageMembers).values({
      packageVersionId: "package_version_fixture_v2",
      skillId,
      revisionId,
      position: 0,
      upstreamRepositoryUrl: "https://github.com/example/public-skill-fixture",
      upstreamSkillPath: "skills/catalog-fixture",
      upstreamSkillName: "catalog-fixture",
      observedHead,
      observedLicense: "MIT",
      licenseEvidenceClass: "skill-frontmatter",
      licenseEvidencePath: "skills/catalog-fixture/SKILL.md",
      publisherClass: "community",
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

    async function completeObservedAudit(
      status: "pass" | "fail",
      summary: string,
      auditedAt: string,
    ) {
      const auditRun = await repository.acquireSyncRun("skills-sh", undefined, {
        resumePartial: false,
      });
      const auditFence = {
        sourceId: "skills-sh",
        runId: auditRun.id,
        leaseToken: auditRun.leaseToken,
      };
      await connection.db
        .update(sourceListings)
        .set({ lastSeenRunId: auditRun.id })
        .where(eq(sourceListings.id, "listing_fixture_public"));
      await repository.replaceSkillCategoryEvidence({
        fence: auditFence,
        listingId: "listing_fixture_public",
        skillId,
        revisionId,
        sourceHash: observedHead,
        categorySlugs: ["frontend"],
      });
      await repository.recordObservedAudits({
        fence: auditFence,
        listingId: "listing_fixture_public",
        upstreamContentHash: observedHead,
        audits: [
          {
            provider: "Fixture upstream",
            providerSlug: "fixture-upstream",
            status,
            summary,
            auditedAt,
            raw: fixtureAuditRaw(status, summary, auditedAt),
          },
        ],
      });
      await repository.finishSyncRun({
        runId: auditRun.id,
        leaseToken: auditRun.leaseToken,
        sourceId: "skills-sh",
        sourceTotal: 1,
        recordCount: 1,
        completeCrawl: true,
        observationSweepComplete: true,
      });
    }

    await completeObservedAudit(
      "fail",
      "First inert observation failed.",
      "2026-07-20T10:00:00.000Z",
    );
    expect(await repository.search()).toEqual([]);
    expect(await repository.resolvePackage("fixture-stack")).toEqual([]);

    await completeObservedAudit(
      "pass",
      "Later inert observation passed.",
      "2026-07-20T11:00:00.000Z",
    );
    expect(await repository.search()).toHaveLength(1);
    expect(await repository.resolvePackage("fixture-stack")).toHaveLength(1);

    await completeObservedAudit(
      "fail",
      "Newest inert observation failed.",
      "2026-07-20T12:00:00.000Z",
    );
    expect(await repository.search()).toEqual([]);
    expect(await repository.resolvePackage("fixture-stack")).toEqual([]);

    await completeObservedAudit(
      "pass",
      "Final inert observation passed before local blocking test.",
      "2026-07-20T13:00:00.000Z",
    );

    await connection.db.insert(trustAssessments).values([
      {
        id: "assessment_fixture_pass",
        revisionId,
        scanner: "fixture-pass-scanner",
        scannerVersion: "1.0.0",
        immutableRef: observedHead,
        contentHash,
        state: "pass",
        scannedAt: now,
      },
      {
        id: "assessment_fixture_fail",
        revisionId,
        scanner: "fixture-fail-scanner",
        scannerVersion: "1.0.0",
        immutableRef: observedHead,
        contentHash,
        state: "fail",
        quarantineReason: "Critical inert test finding.",
        scannedAt: now,
      },
    ]);

    expect(await repository.search({ query: "catalog-fixture" })).toEqual([]);
    expect(await repository.resolvePackage("fixture-stack")).toEqual([]);
  });
});
