// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CatalogIngestionService } from "../catalog/ingestion";
import { createAgentSkillValidator } from "../catalog/security";
import type { DiscoveredSkillRecord } from "../catalog/source-contract";
import { createCatalogDatabase, type CatalogDatabaseConnection } from "./client";
import { migrateCatalogDatabase } from "./migrate";
import { CatalogRepository } from "./repository";
import {
  packageMembers,
  packageVersions,
  packages,
  skillDuplicates,
  skillRevisions,
  skills,
  sourceListings,
} from "./schema";
import { seedCatalog } from "./seed";

const SKILL = `---
name: fixture-safe
description: Inert repository invariant fixture.
license: MIT
---

# Fixture
`;

function candidate(
  key: string,
  options: { contentHash?: string; immutableRef?: string; sourceRecordId?: string } = {},
): DiscoveredSkillRecord {
  const sourceUrl = `https://github.com/example/${key}`;
  const immutableRef = options.immutableRef ?? createHash("sha1").update(key).digest("hex");
  const manifestHash = createHash("sha256").update(SKILL).digest("hex");
  return {
    sourceRecordId: options.sourceRecordId ?? `${key}:fixture-safe`,
    provider: "github",
    sourceType: "github",
    sourceUrl,
    skillPath: "fixture-safe",
    upstreamName: null,
    upstreamDescription: null,
    compatibility: null,
    license: null,
    installUrl: `${sourceUrl}/tree/${immutableRef}/fixture-safe`,
    installSpec: { kind: "source", sourceUrl, immutableRef, skillPath: "fixture-safe" },
    immutableRef,
    contentHash:
      options.contentHash ?? createHash("sha256").update(`tree:${key}`).digest("hex"),
    public: true,
    internal: false,
    aliases: [],
    repository: null,
    artifact: {
      type: "skill-md",
      contents: SKILL,
      complete: true,
      textFiles: [{ path: "SKILL.md", contents: SKILL, sha256: manifestHash }],
      files: [{ path: "SKILL.md", type: "file", mode: "100644" }],
    },
    raw: {},
  };
}

describe("CatalogRepository invariants", () => {
  let connection: CatalogDatabaseConnection;
  let repository: CatalogRepository;
  let ingestion: CatalogIngestionService;

  beforeEach(async () => {
    const directory = mkdtempSync(join(tmpdir(), "aisle-invariant-test-"));
    connection = createCatalogDatabase({
      url: `file:${join(directory, "catalog.db").replaceAll("\\", "/")}`,
    });
    await migrateCatalogDatabase(connection.client);
    repository = new CatalogRepository(connection.db);
    await seedCatalog(repository);
    ingestion = new CatalogIngestionService(repository, createAgentSkillValidator());
  });

  afterEach(() => connection.client.close());

  it("atomically detaches a formerly valid listing when a new observation is invalid", async () => {
    const run = await repository.acquireSyncRun("skills-sh");
    const first = await ingestion.persist("skills-sh", run.id, candidate("detach"));
    const invalid = candidate("detach", {
      sourceRecordId: "detach:fixture-safe",
      immutableRef: "b".repeat(40),
      contentHash: "c".repeat(64),
    });
    invalid.artifact = null;
    await ingestion.persist("skills-sh", run.id, invalid);

    const [listing] = await connection.db.select().from(sourceListings);
    const [skill] = await connection.db
      .select()
      .from(skills)
      .where(eq(skills.id, first.skillId!));
    expect(listing).toMatchObject({
      skillId: null,
      status: "unresolved",
      sourceHash: "c".repeat(64),
    });
    expect(skill?.lifecycle).toBe("stale");
    expect(await repository.search()).toEqual([]);
  });

  it("rolls back publication when repository trust invariants reject a critical PASS", async () => {
    const run = await repository.acquireSyncRun("skills-sh");
    const unsafeIngestion = new CatalogIngestionService(repository, async () => ({
      valid: true,
      metadata: {
        name: "fixture-safe",
        description: "Inert fixture.",
        compatibility: null,
        license: "MIT",
      },
      trustAssessment: {
        scanner: "broken-fixture-scanner",
        scannerVersion: "1",
        state: "pass",
        quarantineReason: null,
        findings: [
          {
            code: "CRITICAL_FIXTURE",
            severity: "critical",
            path: "SKILL.md",
            message: "Inert critical finding.",
            evidence: null,
          },
        ],
      },
    }));
    await expect(
      unsafeIngestion.persist("skills-sh", run.id, candidate("trust-rollback")),
    ).rejects.toThrow(/Critical trust findings/);
    expect(await connection.db.select().from(skills)).toEqual([]);
    expect(await connection.db.select().from(skillRevisions)).toEqual([]);
  });

  it("rejects immutable-ref hash mutation without changing the current revision", async () => {
    const run = await repository.acquireSyncRun("skills-sh");
    const original = candidate("immutable");
    const first = await ingestion.persist("skills-sh", run.id, original);
    const changed = candidate("immutable", {
      immutableRef: original.immutableRef!,
      contentHash: "d".repeat(64),
    });
    await expect(ingestion.persist("skills-sh", run.id, changed)).rejects.toThrow(
      /changed content hash/,
    );
    const [revision] = await connection.db
      .select()
      .from(skillRevisions)
      .where(eq(skillRevisions.id, first.revisionId!));
    expect(revision).toMatchObject({ contentHash: original.contentHash, isCurrent: true });
  });

  it("rebuilds same-hash duplicate groups around one deterministic root without cycles", async () => {
    const run = await repository.acquireSyncRun("skills-sh");
    const sharedHash = "e".repeat(64);
    await ingestion.persist("skills-sh", run.id, candidate("a", { contentHash: sharedHash }));
    await ingestion.persist("skills-sh", run.id, candidate("b", { contentHash: sharedHash }));
    await ingestion.persist("skills-sh", run.id, candidate("c", { contentHash: sharedHash }));
    let duplicates = await connection.db.select().from(skillDuplicates);
    expect(duplicates).toHaveLength(2);
    expect(new Set(duplicates.map((entry) => entry.duplicateOfSkillId)).size).toBe(1);
    expect(duplicates.every((entry) => entry.skillId !== entry.duplicateOfSkillId)).toBe(true);

    await ingestion.persist(
      "skills-sh",
      run.id,
      candidate("a", { contentHash: "f".repeat(64), immutableRef: "1".repeat(40) }),
    );
    duplicates = await connection.db.select().from(skillDuplicates);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.skillId).not.toBe(duplicates[0]?.duplicateOfSkillId);
  });

  it("aggregates lifecycle across listings and only removes the final active source", async () => {
    const runOne = await repository.acquireSyncRun("skills-sh");
    const firstRecord = candidate("multi-source", { sourceRecordId: "first" });
    const first = await ingestion.persist("skills-sh", runOne.id, firstRecord);
    await repository.upsertSource({
      id: "second-source",
      name: "Second source",
      baseUrl: "https://example.com/second",
      mode: "full",
      upstreamIdentifier: "second",
    });
    const runTwo = await repository.acquireSyncRun("second-source");
    await ingestion.persist("second-source", runTwo.id, {
      ...firstRecord,
      sourceRecordId: "second",
    });
    await repository.markSourceListingRemoved("skills-sh", "first");
    let [skill] = await connection.db
      .select()
      .from(skills)
      .where(eq(skills.id, first.skillId!));
    expect(skill?.lifecycle).toBe("current");
    await repository.markSourceListingRemoved("second-source", "second");
    [skill] = await connection.db
      .select()
      .from(skills)
      .where(eq(skills.id, first.skillId!));
    expect(skill?.lifecycle).toBe("removed");
  });

  it("enforces revision/skill package pairs, publication, atomic blocking, and licenses", async () => {
    const run = await repository.acquireSyncRun("skills-sh");
    const first = await ingestion.persist("skills-sh", run.id, candidate("package-one"));
    const second = await ingestion.persist("skills-sh", run.id, candidate("package-two"));
    const now = new Date();
    await connection.db.insert(packages).values({
      id: "package-invariants",
      slug: "invariants",
      title: "Invariants",
      description: "Inert fixture package.",
      published: true,
      createdAt: now,
      updatedAt: now,
    });
    await connection.db.insert(packageVersions).values([
      {
        id: "package-invariants-v1",
        packageId: "package-invariants",
        version: 1,
        publishedAt: now,
        createdAt: now,
      },
      {
        id: "package-invariants-draft",
        packageId: "package-invariants",
        version: 2,
        publishedAt: null,
        createdAt: now,
      },
    ]);
    await expect(
      connection.db.insert(packageMembers).values({
        packageVersionId: "package-invariants-v1",
        skillId: first.skillId!,
        revisionId: second.revisionId!,
        position: 0,
      }),
    ).rejects.toThrow();
    await connection.db.insert(packageMembers).values([
      {
        packageVersionId: "package-invariants-v1",
        skillId: first.skillId!,
        revisionId: first.revisionId!,
        position: 0,
      },
      {
        packageVersionId: "package-invariants-v1",
        skillId: second.skillId!,
        revisionId: second.revisionId!,
        position: 1,
      },
      {
        packageVersionId: "package-invariants-draft",
        skillId: first.skillId!,
        revisionId: first.revisionId!,
        position: 0,
      },
    ]);
    expect(await repository.resolvePackage("invariants", 2)).toEqual([]);
    expect(await repository.resolvePackage("invariants", 1)).toHaveLength(2);
    await repository.recordTrustAssessment({
      revisionId: second.revisionId!,
      immutableRef: candidate("package-two").immutableRef!,
      contentHash: candidate("package-two").contentHash!,
      scanner: "aisle-static",
      scannerVersion: "2",
      state: "quarantined",
      quarantineReason: "Inert package blocking fixture.",
      findings: [
        {
          code: "BLOCKED_FIXTURE",
          severity: "critical",
          path: null,
          message: "Inert.",
          evidence: null,
        },
      ],
    });
    expect(await repository.resolvePackage("invariants", 1)).toEqual([]);
  });
});
