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
  PERSISTED_FILE_INVENTORY_ENTRY_LIMIT,
} from "../catalog/artifact-fingerprint";
import { CatalogIngestionService } from "../catalog/ingestion";
import type {
  PersistedAuditRaw,
  PersistedSkillRaw,
} from "../catalog/provider-raw";
import { createAgentSkillValidator } from "../catalog/security";
import type { DiscoveredSkillRecord } from "../catalog/source-contract";
import { createCatalogDatabase, type CatalogDatabaseConnection } from "./client";
import { migrateCatalogDatabase } from "./migrate";
import {
  CatalogRepository,
  type CatalogMutationFence,
} from "./repository";
import {
  categories,
  packageMembers,
  packageVersions,
  packages,
  skillCategoryEvidence,
  skillDuplicates,
  skillCategories,
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

function mutationFence(
  sourceId: string,
  run: { id: string; leaseToken: string },
): CatalogMutationFence {
  return { sourceId, runId: run.id, leaseToken: run.leaseToken };
}

async function finishCertifiedRun(
  repository: CatalogRepository,
  run: { id: string; leaseToken: string },
  recordCount: number,
  sourceId = "skills-sh",
): Promise<void> {
  await repository.finishSyncRun({
    runId: run.id,
    leaseToken: run.leaseToken,
    sourceId,
    sourceTotal: recordCount,
    recordCount,
    completeCrawl: true,
    observationSweepComplete: true,
  });
}

function skillsShListingRaw(id: string): PersistedSkillRaw {
  return {
    kind: "skills-sh-listing",
    listing: {
      id,
      slug: id,
      name: id,
      source: "example/fixture",
      sourceType: "github",
      installs: 1,
      installUrl: "https://github.com/example/fixture",
      url: "https://skills.sh/example/fixture",
      hash: null,
      duplicate: false,
    },
  };
}

function fixtureAuditRaw(): PersistedAuditRaw {
  return {
    kind: "skills-sh-audit",
    provider: "fixture-auditor",
    slug: "fixture",
    status: "fail",
    summary: "Inert failure fixture.",
    auditedAt: null,
    riskLevel: null,
  };
}

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
    repository: {
      provider: "github",
      url: sourceUrl,
      owner: "example",
      name: key,
      visibility: "public",
      defaultBranch: "main",
    },
    artifact: {
      type: "skill-md",
      contents,
      complete: true,
      textFiles,
      files,
    },
    raw: {
      kind: "github-skill",
      repository: `example/${key}`,
      manifestPath: "fixture-safe/SKILL.md",
      commit: immutableRef,
    },
  };
}

async function insertPackageFixture(
  connection: CatalogDatabaseConnection,
  input: {
    packageId: string;
    slug: string;
    title: string;
    summary: string;
    versionId: string;
    members: Array<{
      skillId: string;
      revisionId: string;
      position: number;
      fixture: DiscoveredSkillRecord;
      licenseEvidenceClass?: "repository-license" | "skill-frontmatter";
      licenseEvidencePath?: string;
    }>;
    draftVersionId?: string;
  },
): Promise<void> {
  const now = new Date();
  const editorial = {
    title: input.title,
    summary: input.summary,
    outcome: "Proves exact package resolution preserves current provenance contracts.",
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
  await connection.db.insert(packages).values({
    id: input.packageId,
    slug: input.slug,
    title: input.title,
    description: input.summary,
    published: true,
    createdAt: now,
    updatedAt: now,
  });
  await connection.db.insert(packageVersions).values({
    id: input.versionId,
    packageId: input.packageId,
    version: 1,
    blueprintSchemaVersion: 1,
    blueprintDigest: `sha256:${createHash("sha256").update(input.slug).digest("hex")}`,
    editorialJson: editorial,
    publishedAt: now,
    createdAt: now,
  });
  if (input.draftVersionId) {
    await connection.db.insert(packageVersions).values({
      id: input.draftVersionId,
      packageId: input.packageId,
      version: 2,
      blueprintSchemaVersion: 1,
      blueprintDigest: `sha256:${createHash("sha256").update(`${input.slug}:draft`).digest("hex")}`,
      editorialJson: editorial,
      publishedAt: null,
      createdAt: now,
    });
  }
  await connection.db.insert(packageMembers).values(
    input.members.map((member) => ({
      packageVersionId: input.versionId,
      skillId: member.skillId,
      revisionId: member.revisionId,
      position: member.position,
      upstreamRepositoryUrl: member.fixture.sourceUrl,
      upstreamSkillPath: member.fixture.skillPath,
      upstreamSkillName: "fixture-safe",
      observedHead: member.fixture.immutableRef!,
      observedLicense: "MIT",
      licenseEvidenceClass: member.licenseEvidenceClass ?? "skill-frontmatter",
      licenseEvidencePath: member.licenseEvidencePath ?? `${member.fixture.skillPath}/SKILL.md`,
      publisherClass: "community" as const,
    })),
  );
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

  it("fences deterministic category replacement without bypassing trust", async () => {
    const run = await repository.acquireSyncRun("skills-sh");
    const untrustedIngestion = new CatalogIngestionService(repository, async () => ({
      valid: true,
      metadata: {
        name: "fixture-safe",
        description: "Inert categorized fixture.",
        compatibility: null,
        license: "MIT",
      },
      trustAssessment: {
        scanner: "fixture",
        scannerVersion: "1",
        state: "fail",
        quarantineReason: "Inert test-only rejection.",
        findings: [],
      },
    }));
    const categorized = candidate("categorized-untrusted");
    categorized.categoryHints = { categories: ["Cybersecurity"], tags: [] };
    const persisted = await untrustedIngestion.persist(
      mutationFence("skills-sh", run),
      categorized,
    );
    const evidence = await connection.db
      .select({ slug: categories.slug })
      .from(skillCategoryEvidence)
      .innerJoin(categories, eq(categories.id, skillCategoryEvidence.categoryId));

    expect(evidence).toEqual([{ slug: "security" }]);
    expect(await connection.db.select().from(skillCategories)).toEqual([]);
    expect(await repository.search()).toEqual([]);

    await repository.failSyncRun({
      runId: run.id,
      leaseToken: run.leaseToken,
      sourceId: "skills-sh",
      message: "Inert fixture transition.",
    });
    const assigned = await connection.db
      .select({ slug: categories.slug, attribution: skillCategories.attribution })
      .from(skillCategories)
      .innerJoin(categories, eq(categories.id, skillCategories.categoryId));
    expect(assigned).toEqual([
      { slug: "security", attribution: "aisle:source-metadata-v1" },
    ]);
    expect(await repository.search()).toEqual([]);
    await expect(
      repository.replaceSkillCategoryEvidence({
        fence: mutationFence("skills-sh", run),
        listingId: persisted.listingId,
        skillId: persisted.skillId!,
        revisionId: persisted.revisionId!,
        sourceHash: categorized.upstreamHash!,
        categorySlugs: ["frontend"],
      }),
    ).rejects.toThrow(/lease/i);
  });

  it("keeps the last certified categories while a newer sweep is running or incomplete", async () => {
    await repository.upsertSource({
      id: "skills-sh",
      name: "skills.sh",
      baseUrl: "https://skills.sh/api/v1",
      mode: "full",
      freshnessPolicy: "latest-completed-observation",
      upstreamIdentifier: "skills.sh API v1",
      termsUrl: "https://skills.sh",
    });
    const fixture = candidate("category-certificate");
    fixture.categoryHints = { categories: ["Cybersecurity"], tags: [] };
    const firstRun = await repository.acquireSyncRun("skills-sh", undefined, {
      resumePartial: false,
    });
    await ingestion.persist(mutationFence("skills-sh", firstRun), fixture);
    await repository.finishSyncRun({
      runId: firstRun.id,
      leaseToken: firstRun.leaseToken,
      sourceId: "skills-sh",
      sourceTotal: 1,
      recordCount: 1,
      completeCrawl: true,
      observationSweepComplete: true,
    });

    const assignedSlugs = async () => connection.db
      .select({ slug: categories.slug })
      .from(skillCategories)
      .innerJoin(categories, eq(categories.id, skillCategories.categoryId));
    expect(await assignedSlugs()).toEqual([{ slug: "security" }]);

    const secondRun = await repository.acquireSyncRun("skills-sh", undefined, {
      resumePartial: false,
    });
    fixture.categoryHints = { categories: ["Frontend"], tags: [] };
    await ingestion.persist(mutationFence("skills-sh", secondRun), fixture);
    expect(await assignedSlugs()).toEqual([{ slug: "security" }]);

    await repository.failSyncRun({
      runId: secondRun.id,
      leaseToken: secondRun.leaseToken,
      sourceId: "skills-sh",
      message: "Inert incomplete observation fixture.",
    });
    expect(await assignedSlugs()).toEqual([{ slug: "security" }]);
  });

  it("promotes an empty retain snapshot and retains categories for stale listings", async () => {
    const fixture = candidate("category-retain");
    fixture.categoryHints = { categories: ["Cybersecurity"], tags: [] };
    const firstRun = await repository.acquireSyncRun("skills-sh", undefined, {
      resumePartial: false,
    });
    await ingestion.persist(mutationFence("skills-sh", firstRun), fixture);
    await repository.finishSyncRun({
      runId: firstRun.id,
      leaseToken: firstRun.leaseToken,
      sourceId: "skills-sh",
      sourceTotal: 1,
      recordCount: 1,
      completeCrawl: true,
    });
    expect(await connection.db.select().from(skillCategories)).toHaveLength(1);

    const staleRun = await repository.acquireSyncRun("skills-sh", undefined, {
      resumePartial: false,
    });
    await repository.finishSyncRun({
      runId: staleRun.id,
      leaseToken: staleRun.leaseToken,
      sourceId: "skills-sh",
      sourceTotal: 0,
      recordCount: 1,
      completeCrawl: true,
    });
    expect(await connection.db.select().from(skillCategories)).toHaveLength(1);

    const emptyRun = await repository.acquireSyncRun("skills-sh", undefined, {
      resumePartial: false,
    });
    fixture.categoryHints = { categories: [], tags: [] };
    await ingestion.persist(mutationFence("skills-sh", emptyRun), fixture);
    expect(await connection.db.select().from(skillCategories)).toHaveLength(1);
    await repository.finishSyncRun({
      runId: emptyRun.id,
      leaseToken: emptyRun.leaseToken,
      sourceId: "skills-sh",
      sourceTotal: 1,
      recordCount: 1,
      completeCrawl: true,
    });
    expect(await connection.db.select().from(skillCategories)).toEqual([]);
  });

  it("atomically detaches a formerly valid listing when a new observation is invalid", async () => {
    const run = await repository.acquireSyncRun("skills-sh");
    const first = await ingestion.persist(mutationFence("skills-sh", run), candidate("detach"));
    const invalid = candidate("detach", {
      sourceRecordId: "detach:fixture-safe",
      immutableRef: "b".repeat(40),
    });
    const invalidSourceHash = invalid.upstreamHash;
    invalid.artifact = null;
    await ingestion.persist(mutationFence("skills-sh", run), invalid);

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
      unsafeIngestion.persist(mutationFence("skills-sh", run), candidate("trust-rollback")),
    ).rejects.toThrow(/Critical trust findings/);
    expect(await connection.db.select().from(skills)).toEqual([]);
    expect(await connection.db.select().from(skillRevisions)).toEqual([]);
  });

  it("requires a fresh trust assessment instead of reusing an old pass", async () => {
    const run = await repository.acquireSyncRun("skills-sh");
    const fixture = candidate("fresh-trust");
    const first = await ingestion.persist(mutationFence("skills-sh", run), fixture);
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
    const repeated = await noAssessment.persist(mutationFence("skills-sh", run), fixture);
    expect(repeated).toMatchObject({ resolved: false, skillId: null, revisionId: null });
    expect(await repository.search()).toEqual([]);
    expect(await repository.countSourceListings("skills-sh")).toBe(1);
  });

  it("requires exact trust bindings and ignores an unbound failure", async () => {
    const run = await repository.acquireSyncRun("skills-sh");
    const persisted = await ingestion.persist(
      mutationFence("skills-sh", run),
      candidate("trust-binding"),
    );
    const revision = candidate("trust-binding");

    await connection.client.execute({
      sql: "update trust_assessments set immutable_ref = ?, content_hash = ? where revision_id = ?",
      args: ["wrong-ref", "0".repeat(64), persisted.revisionId!],
    });
    expect(await repository.search()).toEqual([]);

    await repository.recordTrustAssessment({
      fence: mutationFence("skills-sh", run),
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
    await finishCertifiedRun(repository, run, 1);
    expect(await repository.search()).toEqual([
      expect.objectContaining({ id: persisted.skillId, trustState: "pass" }),
    ]);
  });

  it("never lets delayed or equal-time assessments weaken a quarantine", async () => {
    const run = await repository.acquireSyncRun("skills-sh");
    const fixture = candidate("monotonic-trust");
    const persisted = await ingestion.persist(mutationFence("skills-sh", run), fixture);
    const scannedAt = new Date(Date.now() + 60_000);
    await repository.recordTrustAssessment({
      fence: mutationFence("skills-sh", run),
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
        fence: mutationFence("skills-sh", run),
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

  it("does not let canonical re-ingestion overwrite a newer quarantine for the same scanner", async () => {
    const run = await repository.acquireSyncRun("skills-sh");
    const fixture = candidate("canonical-monotonic-trust");
    const persisted = await ingestion.persist(mutationFence("skills-sh", run), fixture);
    await repository.recordTrustAssessment({
      fence: mutationFence("skills-sh", run),
      revisionId: persisted.revisionId!,
      immutableRef: fixture.immutableRef!,
      contentHash: fixture.contentHash!,
      scanner: "aisle-static",
      scannerVersion: "manual-review-1",
      state: "quarantined",
      quarantineReason: "Inert future quarantine fixture.",
      findings: [
        {
          code: "FUTURE_QUARANTINE_FIXTURE",
          severity: "critical",
          path: "SKILL.md",
          message: "Inert.",
          evidence: null,
        },
      ],
      scannedAt: new Date(Date.now() + 60_000),
    });

    await ingestion.persist(mutationFence("skills-sh", run), fixture);

    expect(await repository.trustDetails(persisted.revisionId!)).toEqual([
      expect.objectContaining({
        scanner: "aisle-static",
        scannerVersion: "manual-review-1",
        state: "quarantined",
        code: "FUTURE_QUARANTINE_FIXTURE",
      }),
    ]);
    expect(await repository.search()).toEqual([]);
  });

  it("binds observation failures to the explicit provider hash, not local scan bytes", async () => {
    const run = await repository.acquireSyncRun("skills-sh");
    const upstreamHash = "provider-revision-v1";
    const fixture = candidate("audit-binding", { sourceRecordId: "audit-binding" });
    fixture.upstreamHash = upstreamHash;
    const persisted = await ingestion.persist(mutationFence("skills-sh", run), fixture);
    const audit = async (hash: string) => repository.recordObservedAudits({
      fence: mutationFence("skills-sh", run),
      listingId: persisted.listingId,
      upstreamContentHash: hash,
      audits: [{
        provider: "fixture-auditor",
        providerSlug: "fixture",
        status: "fail" as const,
        summary: "Inert failure fixture.",
        raw: fixtureAuditRaw(),
      }],
    });

    await audit(fixture.contentHash!);
    await finishCertifiedRun(repository, run, 1);
    expect(await repository.search()).toHaveLength(1);

    const secondRun = await repository.acquireSyncRun("skills-sh");
    const second = await ingestion.persist(mutationFence("skills-sh", secondRun), fixture);
    await repository.recordObservedAudits({
      fence: mutationFence("skills-sh", secondRun),
      listingId: second.listingId,
      upstreamContentHash: upstreamHash,
      audits: [{
        provider: "fixture-auditor",
        providerSlug: "fixture",
        status: "fail" as const,
        summary: "Inert failure fixture.",
        raw: fixtureAuditRaw(),
      }],
    });
    await finishCertifiedRun(repository, secondRun, 1);
    expect(await repository.search()).toEqual([]);
  });

  it("restores stale and unavailable listings only when the bound provider hash reappears", async () => {
    const firstRun = await repository.acquireSyncRun("skills-sh");
    const fixture = candidate("reappearance", { sourceRecordId: "reappearance" });
    const persisted = await ingestion.persist(mutationFence("skills-sh", firstRun), fixture);
    await repository.failSyncRun({
      runId: firstRun.id,
      leaseToken: firstRun.leaseToken,
      sourceId: "skills-sh",
      message: "Inert fixture transition.",
    });

    const staleRun = await repository.acquireSyncRun("skills-sh");
    await repository.markCompleteCrawlMisses(mutationFence("skills-sh", staleRun), 2);
    let [listing] = await connection.db.select().from(sourceListings);
    expect(listing?.status).toBe("stale");
    await repository.upsertSourceListing({
      fence: mutationFence("skills-sh", staleRun),
      upstreamId: "reappearance",
      sourceType: "github",
      sourceHash: fixture.upstreamHash,
      installs: 1,
      raw: skillsShListingRaw("reappearance"),
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
    await repository.markCompleteCrawlMisses(mutationFence("skills-sh", unavailableRun), 1);
    await repository.upsertSourceListing({
      fence: mutationFence("skills-sh", unavailableRun),
      upstreamId: "reappearance",
      sourceType: "github",
      sourceHash: fixture.upstreamHash,
      installs: 1,
      raw: skillsShListingRaw("reappearance"),
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
    const first = await ingestion.persist(mutationFence("skills-sh", run), original);
    const changed = candidate("immutable", {
      immutableRef: original.immutableRef!,
      contents: `${SKILL}\nChanged exact bytes.\n`,
    });
    await expect(ingestion.persist(mutationFence("skills-sh", run), changed)).rejects.toThrow(
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
    await ingestion.persist(mutationFence("skills-sh", run), candidate("a", { contents: sharedContents }));
    await ingestion.persist(mutationFence("skills-sh", run), candidate("b", { contents: sharedContents }));
    await ingestion.persist(mutationFence("skills-sh", run), candidate("c", { contents: sharedContents }));
    let duplicates = await connection.db.select().from(skillDuplicates);
    expect(duplicates).toHaveLength(2);
    expect(new Set(duplicates.map((entry) => entry.duplicateOfSkillId)).size).toBe(1);
    expect(duplicates.every((entry) => entry.skillId !== entry.duplicateOfSkillId)).toBe(true);

    await ingestion.persist(
      mutationFence("skills-sh", run),
      candidate("a", { contents: `${SKILL}\nNew exact bytes.\n`, immutableRef: "1".repeat(40) }),
    );
    duplicates = await connection.db.select().from(skillDuplicates);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.skillId).not.toBe(duplicates[0]?.duplicateOfSkillId);
  });

  it("aggregates lifecycle across listings and only removes the final active source", async () => {
    const runOne = await repository.acquireSyncRun("skills-sh");
    const firstRecord = candidate("multi-source", { sourceRecordId: "first" });
    const first = await ingestion.persist(mutationFence("skills-sh", runOne), firstRecord);
    await repository.upsertSource({
      id: "second-source",
      name: "Second source",
      baseUrl: "https://example.com/second",
      mode: "full",
      upstreamIdentifier: "second",
    });
    const runTwo = await repository.acquireSyncRun("second-source");
    await ingestion.persist(mutationFence("second-source", runTwo), {
      ...firstRecord,
      sourceRecordId: "second",
    });
    await repository.markSourceListingRemoved(mutationFence("skills-sh", runOne), "first");
    let [skill] = await connection.db
      .select()
      .from(skills)
      .where(eq(skills.id, first.skillId!));
    expect(skill?.lifecycle).toBe("current");
    await repository.markSourceListingRemoved(mutationFence("second-source", runTwo), "second");
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
    const firstFixture = candidate("package-one");
    const secondFixture = candidate("package-two");
    const first = await ingestion.persist(mutationFence("skills-sh", run), firstFixture);
    const second = await ingestion.persist(mutationFence("skills-sh", run), secondFixture);
    await insertPackageFixture(connection, {
      packageId: "package-invariants",
      slug: "invariants",
      title: "Invariants",
      summary: "Inert fixture package used by repository invariant tests.",
      versionId: "package-invariants-v1",
      draftVersionId: "package-invariants-draft",
      members: [
        {
          skillId: first.skillId!,
          revisionId: first.revisionId!,
          position: 0,
          fixture: firstFixture,
        },
        {
          skillId: second.skillId!,
          revisionId: second.revisionId!,
          position: 1,
          fixture: secondFixture,
        },
      ],
    });
    await expect(
      connection.db.insert(packageMembers).values({
        packageVersionId: "package-invariants-v1",
        skillId: first.skillId!,
        revisionId: second.revisionId!,
        position: 0,
      }),
    ).rejects.toThrow();
    expect(await repository.resolvePackage("invariants", 2)).toEqual([]);
    await connection.db
      .update(skills)
      .set({ license: "unknown" })
      .where(eq(skills.id, first.skillId!));
    await finishCertifiedRun(repository, run, 2);
    const resolved = await repository.resolvePackage("invariants", 1);
    expect(resolved).toHaveLength(2);
    expect(resolved.every((entry) => entry.license === "MIT")).toBe(true);
    const trustRun = await repository.acquireSyncRun("skills-sh");
    await repository.recordTrustAssessment({
      fence: mutationFence("skills-sh", trustRun),
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

  it("blocks an unlinked unresolved package member while retaining its provenance", async () => {
    const run = await repository.acquireSyncRun("skills-sh");
    const fixture = candidate("unresolved-package", { sourceRecordId: "unresolved-package" });
    const persisted = await ingestion.persist(mutationFence("skills-sh", run), fixture);
    await insertPackageFixture(connection, {
      packageId: "unresolved-package",
      slug: "unresolved-package",
      title: "Unresolved package",
      summary: "Inert unresolved listing fixture used by repository tests.",
      versionId: "unresolved-package-v1",
      members: [{
        skillId: persisted.skillId!,
        revisionId: persisted.revisionId!,
        position: 0,
        fixture,
      }],
    });
    await finishCertifiedRun(repository, run, 1);
    expect(await repository.resolvePackage("unresolved-package")).toHaveLength(1);

    const unseenRun = await repository.acquireSyncRun("skills-sh");
    await repository.markCompleteCrawlMisses(mutationFence("skills-sh", unseenRun), 2);
    expect(await repository.resolvePackage("unresolved-package")).toEqual([]);

    const unresolved = { ...fixture, artifact: null };
    expect(
      await ingestion.persist(mutationFence("skills-sh", unseenRun), unresolved),
    ).toMatchObject({
      resolved: false,
      skillId: null,
      revisionId: null,
    });
    expect(await repository.resolvePackage("unresolved-package")).toEqual([]);

    const [listing] = await connection.db
      .select()
      .from(sourceListings)
      .where(eq(sourceListings.id, persisted.listingId));
    const [retainedSkill] = await connection.db
      .select()
      .from(skills)
      .where(eq(skills.id, persisted.skillId!));
    const [retainedRevision] = await connection.db
      .select()
      .from(skillRevisions)
      .where(eq(skillRevisions.id, persisted.revisionId!));
    expect(listing).toMatchObject({ status: "unresolved", skillId: null });
    expect(retainedSkill?.id).toBe(persisted.skillId);
    expect(retainedRevision?.id).toBe(persisted.revisionId);
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
    const persisted = await ingestion.persist(mutationFence("skills-sh", run), fixture);
    await insertPackageFixture(connection, {
      packageId: "root-license-package",
      slug: "root-license-package",
      title: "Root license package",
      summary: "Inert repository root license fixture used by package tests.",
      versionId: "root-license-package-v1",
      members: [{
        skillId: persisted.skillId!,
        revisionId: persisted.revisionId!,
        position: 0,
        fixture,
        licenseEvidenceClass: "repository-license",
        licenseEvidencePath: "LICENSE",
      }],
    });
    await finishCertifiedRun(repository, run, 1);

    expect(await repository.resolvePackage("root-license-package")).toEqual([
      expect.objectContaining({
        skillId: persisted.skillId,
        license: "MIT",
        revisionMetadata: expect.objectContaining({
          licenseEvidence: expect.objectContaining({
            source: "repository-root-license-text",
            immutableRef: fixture.immutableRef,
          }),
        }),
      }),
    ]);
  });

  it("persists content-free file metadata for text, binary, and executable inventory entries", async () => {
    const run = await repository.acquireSyncRun("skills-sh");
    const bodyMarker = "INVENTORY_BODY_MUST_NOT_PERSIST";
    const helperMarker = "INVENTORY_HELPER_BODY_MUST_NOT_PERSIST";
    const manifest = `${SKILL}\n<!-- ${bodyMarker} -->\n`;
    const helper = `export const fixture = "${helperMarker}";\n`;
    const binary = Buffer.from([0, 1, 2, 3]);
    const textFiles = [
      { path: "SKILL.md", contents: manifest, sha256: createHash("sha256").update(manifest).digest("hex") },
      { path: "scripts/run.ts", contents: helper, sha256: createHash("sha256").update(helper).digest("hex") },
    ];
    const files = [
      {
        path: "SKILL.md",
        type: "file",
        mode: "100644",
        size: Buffer.byteLength(manifest),
        sha: textFiles[0]!.sha256,
      },
      {
        path: "scripts/run.ts",
        type: "file",
        mode: "100755",
        size: Buffer.byteLength(helper),
        sha: textFiles[1]!.sha256,
      },
      {
        path: "assets/tool.bin",
        type: "binary",
        mode: "100644",
        size: binary.byteLength,
        sha: createHash("sha256").update(binary).digest("hex"),
      },
    ];
    const fixture = candidate("persisted-inventory", { contents: manifest });
    fixture.contentHash = computeArtifactContentHash(files);
    fixture.artifact = {
      type: "skill-md",
      contents: manifest,
      complete: true,
      textFiles,
      files,
    };

    const persisted = await ingestion.persist(mutationFence("skills-sh", run), fixture);
    const [revision] = await connection.db
      .select()
      .from(skillRevisions)
      .where(eq(skillRevisions.id, persisted.revisionId!));

    expect(revision?.metadataJson).toMatchObject({
      fileInventory: {
        schemaVersion: 1,
        complete: true,
        fileCount: 3,
        listedFileCount: 3,
        regularFileCount: 2,
        binaryFileCount: 1,
        executableFileCount: 1,
        aggregateSha256: fixture.contentHash,
        truncated: false,
        files: [
          expect.objectContaining({
            path: "SKILL.md",
            type: "file",
            mode: "100644",
            sha256: textFiles[0]!.sha256,
          }),
          expect.objectContaining({
            path: "assets/tool.bin",
            type: "binary",
            mode: "100644",
          }),
          expect.objectContaining({
            path: "scripts/run.ts",
            type: "file",
            mode: "100755",
            sha256: textFiles[1]!.sha256,
          }),
        ],
      },
    });
    const persistedMetadata = JSON.stringify(revision?.metadataJson);
    expect(persistedMetadata).not.toContain(bodyMarker);
    expect(persistedMetadata).not.toContain(helperMarker);
    expect(persistedMetadata).not.toContain("contents");
  });

  it("bounds persisted file entries while retaining the complete aggregate inventory", async () => {
    const run = await repository.acquireSyncRun("skills-sh");
    const fixture = candidate("bounded-persisted-inventory");
    const manifestFile = fixture.artifact!.files![0]!;
    const extraFiles = Array.from(
      { length: PERSISTED_FILE_INVENTORY_ENTRY_LIMIT + 4 },
      (_, index) => ({
        path: `generated/${String(index).padStart(4, "0")}.txt`,
        type: "file",
        mode: "100644",
        size: 0,
        sha: createHash("sha256").update(`empty-${index}`).digest("hex"),
      }),
    );
    const files = [manifestFile, ...extraFiles];
    fixture.artifact = { ...fixture.artifact!, files };
    fixture.contentHash = computeArtifactContentHash(files);

    const persisted = await ingestion.persist(mutationFence("skills-sh", run), fixture);
    const [revision] = await connection.db
      .select()
      .from(skillRevisions)
      .where(eq(skillRevisions.id, persisted.revisionId!));
    const metadata = revision?.metadataJson as {
      fileInventory?: {
        fileCount: number;
        listedFileCount: number;
        aggregateSha256: string;
        truncated: boolean;
        files: unknown[];
      };
    };

    expect(metadata.fileInventory).toMatchObject({
      fileCount: PERSISTED_FILE_INVENTORY_ENTRY_LIMIT + 5,
      listedFileCount: PERSISTED_FILE_INVENTORY_ENTRY_LIMIT,
      aggregateSha256: fixture.contentHash,
      truncated: true,
    });
    expect(metadata.fileInventory?.files).toHaveLength(PERSISTED_FILE_INVENTORY_ENTRY_LIMIT);
  });
});
