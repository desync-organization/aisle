// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeArtifactContentHash,
  createTextArtifactInventory,
} from "../catalog/artifact-fingerprint";
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
  options: { contents?: string; immutableRef?: string; sourceRecordId?: string } = {},
): DiscoveredSkillRecord {
  const sourceUrl = `https://github.com/example/${key}`;
  const immutableRef = options.immutableRef ?? createHash("sha1").update(key).digest("hex");
  const contents = options.contents ?? `${SKILL}\n<!-- ${key} -->\n`;
  const manifestHash = createHash("sha256").update(contents).digest("hex");
  const textFiles = [{ path: "SKILL.md", contents, sha256: manifestHash }];
  const files = createTextArtifactInventory(textFiles);
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
    contentHash: computeArtifactContentHash(files),
    upstreamHash: immutableRef,
    public: true,
    internal: false,
    aliases: [],
    repository: null,
    artifact: {
      type: "skill-md",
      contents,
      complete: true,
      textFiles,
      files,
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
    });
    const invalidSourceHash = invalid.upstreamHash;
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
      sourceHash: invalidSourceHash,
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

  it("requires a fresh trust assessment instead of reusing an old pass", async () => {
    const run = await repository.acquireSyncRun("skills-sh");
    const fixture = candidate("fresh-trust");
    const first = await ingestion.persist("skills-sh", run.id, fixture);
    expect(first.resolved).toBe(true);

    const noAssessment = new CatalogIngestionService(repository, async () => ({
      valid: true,
      metadata: {
        name: "fixture-safe",
        description: "Inert fixture.",
        compatibility: null,
        license: "MIT",
      },
    }));
    const repeated = await noAssessment.persist("skills-sh", run.id, fixture);
    expect(repeated).toMatchObject({ resolved: false, skillId: null, revisionId: null });
    expect(await repository.search()).toEqual([]);
    expect(await repository.countSourceListings("skills-sh")).toBe(1);
  });

  it("requires exact trust bindings and ignores an unbound failure", async () => {
    const run = await repository.acquireSyncRun("skills-sh");
    const persisted = await ingestion.persist("skills-sh", run.id, candidate("trust-binding"));
    const revision = candidate("trust-binding");

    await connection.client.execute({
      sql: "update trust_assessments set immutable_ref = ?, content_hash = ? where revision_id = ?",
      args: ["wrong-ref", "0".repeat(64), persisted.revisionId!],
    });
    expect(await repository.search()).toEqual([]);

    await repository.recordTrustAssessment({
      revisionId: persisted.revisionId!,
      immutableRef: revision.immutableRef!,
      contentHash: revision.contentHash!,
      scanner: "bound-pass",
      scannerVersion: "1",
      state: "pass",
      quarantineReason: null,
      findings: [],
    });
    await connection.client.execute({
      sql: `insert into trust_assessments
        (id, revision_id, scanner, scanner_version, immutable_ref, content_hash, state, scanned_at)
        values (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        "unbound-fail",
        persisted.revisionId!,
        "unbound-fail",
        "1",
        "wrong-ref",
        "f".repeat(64),
        "fail",
        Date.now(),
      ],
    });
    expect(await repository.search()).toEqual([
      expect.objectContaining({ id: persisted.skillId, trustState: "pass" }),
    ]);
  });

  it("never lets delayed or equal-time assessments weaken a quarantine", async () => {
    const run = await repository.acquireSyncRun("skills-sh");
    const fixture = candidate("monotonic-trust");
    const persisted = await ingestion.persist("skills-sh", run.id, fixture);
    const scannedAt = new Date(Date.now() + 60_000);
    await repository.recordTrustAssessment({
      revisionId: persisted.revisionId!,
      immutableRef: fixture.immutableRef!,
      contentHash: fixture.contentHash!,
      scanner: "monotonic-scanner",
      scannerVersion: "2",
      state: "quarantined",
      quarantineReason: "Inert monotonic fixture.",
      findings: [
        {
          code: "MONOTONIC_FIXTURE",
          severity: "critical",
          path: null,
          message: "Inert.",
          evidence: null,
        },
      ],
      scannedAt,
    });
    for (const delayedAt of [new Date(scannedAt.getTime() - 1), scannedAt]) {
      await repository.recordTrustAssessment({
        revisionId: persisted.revisionId!,
        immutableRef: fixture.immutableRef!,
        contentHash: fixture.contentHash!,
        scanner: "monotonic-scanner",
        scannerVersion: "1",
        state: "pass",
        quarantineReason: null,
        findings: [],
        scannedAt: delayedAt,
      });
    }
    expect(await repository.trustDetails(persisted.revisionId!)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
        scanner: "monotonic-scanner",
        state: "quarantined",
        code: "MONOTONIC_FIXTURE",
        }),
      ]),
    );
  });

  it("binds observation failures to the explicit provider hash, not local scan bytes", async () => {
    const run = await repository.acquireSyncRun("skills-sh");
    const upstreamHash = "provider-revision-v1";
    const fixture = candidate("audit-binding", { sourceRecordId: "audit-binding" });
    fixture.upstreamHash = upstreamHash;
    const persisted = await ingestion.persist("skills-sh", run.id, fixture);
    const audit = async (hash: string) => repository.recordObservedAudits({
      listingId: persisted.listingId,
      upstreamContentHash: hash,
      audits: [{
        provider: "fixture-auditor",
        providerSlug: "fixture",
        status: "fail" as const,
        summary: "Inert failure fixture.",
        raw: {},
      }],
    });

    await audit(fixture.contentHash!);
    expect(await repository.search()).toHaveLength(1);
    await audit(upstreamHash);
    expect(await repository.search()).toEqual([]);
  });

  it("restores stale and unavailable listings only when the bound provider hash reappears", async () => {
    const firstRun = await repository.acquireSyncRun("skills-sh");
    const fixture = candidate("reappearance", { sourceRecordId: "reappearance" });
    const persisted = await ingestion.persist("skills-sh", firstRun.id, fixture);
    await repository.failSyncRun({
      runId: firstRun.id,
      leaseToken: firstRun.leaseToken,
      sourceId: "skills-sh",
      message: "Inert fixture transition.",
    });

    const staleRun = await repository.acquireSyncRun("skills-sh");
    await repository.markCompleteCrawlMisses("skills-sh", staleRun.id, 2);
    let [listing] = await connection.db.select().from(sourceListings);
    expect(listing?.status).toBe("stale");
    await repository.upsertSourceListing({
      sourceId: "skills-sh",
      runId: staleRun.id,
      upstreamId: "reappearance",
      sourceType: "github",
      sourceHash: fixture.upstreamHash,
      installs: 1,
      raw: {},
    });
    [listing] = await connection.db.select().from(sourceListings);
    expect(listing?.status).toBe("current");
    await repository.failSyncRun({
      runId: staleRun.id,
      leaseToken: staleRun.leaseToken,
      sourceId: "skills-sh",
      message: "Inert fixture transition.",
    });

    const unavailableRun = await repository.acquireSyncRun("skills-sh");
    await repository.markCompleteCrawlMisses("skills-sh", unavailableRun.id, 1);
    await repository.upsertSourceListing({
      sourceId: "skills-sh",
      runId: unavailableRun.id,
      upstreamId: "reappearance",
      sourceType: "github",
      sourceHash: fixture.upstreamHash,
      installs: 1,
      raw: {},
    });
    [listing] = await connection.db.select().from(sourceListings);
    const [skill] = await connection.db
      .select()
      .from(skills)
      .where(eq(skills.id, persisted.skillId!));
    expect(listing?.status).toBe("current");
    expect(skill?.lifecycle).toBe("current");
  });

  it("rejects immutable-ref hash mutation without changing the current revision", async () => {
    const run = await repository.acquireSyncRun("skills-sh");
    const original = candidate("immutable");
    const first = await ingestion.persist("skills-sh", run.id, original);
    const changed = candidate("immutable", {
      immutableRef: original.immutableRef!,
      contents: `${SKILL}\nChanged exact bytes.\n`,
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
    const sharedContents = `${SKILL}\nShared exact bytes.\n`;
    await ingestion.persist("skills-sh", run.id, candidate("a", { contents: sharedContents }));
    await ingestion.persist("skills-sh", run.id, candidate("b", { contents: sharedContents }));
    await ingestion.persist("skills-sh", run.id, candidate("c", { contents: sharedContents }));
    let duplicates = await connection.db.select().from(skillDuplicates);
    expect(duplicates).toHaveLength(2);
    expect(new Set(duplicates.map((entry) => entry.duplicateOfSkillId)).size).toBe(1);
    expect(duplicates.every((entry) => entry.skillId !== entry.duplicateOfSkillId)).toBe(true);

    await ingestion.persist(
      "skills-sh",
      run.id,
      candidate("a", { contents: `${SKILL}\nNew exact bytes.\n`, immutableRef: "1".repeat(40) }),
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
    expect(await repository.countSourceListings("skills-sh")).toBe(0);
    expect(await repository.countSourceListings("second-source")).toBe(0);
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
    await connection.db
      .update(skills)
      .set({ license: "unknown" })
      .where(eq(skills.id, first.skillId!));
    const resolved = await repository.resolvePackage("invariants", 1);
    expect(resolved).toHaveLength(2);
    expect(resolved.every((entry) => entry.license === "MIT")).toBe(true);
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

  it("allows package resolution from exact repository-root license evidence", async () => {
    const run = await repository.acquireSyncRun("skills-sh");
    const license = readFileSync("node_modules/clsx/license", "utf8");
    const contents = SKILL.replace("license: MIT\n", "");
    const fixture = candidate("root-license-package", { contents });
    fixture.repository = {
      provider: "github",
      url: fixture.sourceUrl,
      owner: "example",
      name: "root-license-package",
      visibility: "public",
      defaultBranch: "main",
    };
    fixture.repositoryLicenseEvidence = {
      path: "LICENSE",
      contents: license,
      sha256: createHash("sha256").update(license).digest("hex"),
      sourceUrl: fixture.sourceUrl,
      immutableRef: fixture.immutableRef!,
    };
    const persisted = await ingestion.persist("skills-sh", run.id, fixture);
    const now = new Date();
    await connection.db.insert(packages).values({
      id: "root-license-package",
      slug: "root-license-package",
      title: "Root license package",
      description: "Inert repository-root license fixture.",
      published: true,
      createdAt: now,
      updatedAt: now,
    });
    await connection.db.insert(packageVersions).values({
      id: "root-license-package-v1",
      packageId: "root-license-package",
      version: 1,
      publishedAt: now,
      createdAt: now,
    });
    await connection.db.insert(packageMembers).values({
      packageVersionId: "root-license-package-v1",
      skillId: persisted.skillId!,
      revisionId: persisted.revisionId!,
      position: 0,
    });

    expect(await repository.resolvePackage("root-license-package")).toEqual([
      expect.objectContaining({
        skillId: persisted.skillId,
        license: "MIT",
        revisionMetadata: {
          licenseEvidence: expect.objectContaining({
            source: "repository-root-license-text",
            immutableRef: fixture.immutableRef,
          }),
        },
      }),
    ]);
  });
});
