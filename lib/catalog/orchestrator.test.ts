// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeArtifactContentHash,
  createTextArtifactInventory,
} from "./artifact-fingerprint";
import { createCatalogDatabase, type CatalogDatabaseConnection } from "../db/client";
import { migrateCatalogDatabase } from "../db/migrate";
import {
  CatalogRepository,
  CatalogSyncLeaseConflictError,
} from "../db/repository";
import { catalogSources, skills, sourceListings, syncRuns } from "../db/schema";
import { seedCatalog } from "../db/seed";
import type { DiscoveryValidationResult } from "./ingestion";
import { CatalogSyncOrchestrator } from "./orchestrator";
import { createAgentSkillValidator } from "./security";
import type {
  CatalogSourceConnector,
  ConnectorContext,
  ConnectorPage,
  DiscoveredSkillRecord,
} from "./source-contract";

const SKILL = `---
name: fixture-safe
description: Inert orchestrator fixture.
license: MIT
---

# Fixture
`;

function candidate(source = "orchestrator-fixture"): DiscoveredSkillRecord {
  const sourceUrl = `https://github.com/example/${source}`;
  const immutableRef = createHash("sha1").update(source).digest("hex");
  const contents = `${SKILL}\n<!-- ${source} -->\n`;
  const manifestHash = createHash("sha256").update(contents).digest("hex");
  const textFiles = [{ path: "SKILL.md", contents, sha256: manifestHash }];
  const files = createTextArtifactInventory(textFiles);
  return {
    sourceRecordId: `${source}:fixture-safe`,
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

class FixtureConnector implements CatalogSourceConnector {
  readonly descriptor;

  constructor(
    id: string,
    private readonly factory: (context: ConnectorContext) => AsyncIterable<ConnectorPage>,
    options: { enabled?: boolean; mode?: "full" | "incremental" | "federated" | "on-demand" } = {},
  ) {
    this.descriptor = {
      id,
      name: id,
      baseUrl: `https://example.com/${id}`,
      mode: options.mode ?? ("full" as const),
      upstreamIdentifier: id,
      enabled: options.enabled,
      initialCoverageState: options.enabled === false ? "not-configured" : "not-synced",
      knownExclusions: options.enabled === false ? ["Disabled inert fixture."] : [],
    };
  }

  enumerate(context: ConnectorContext): AsyncIterable<ConnectorPage> {
    return this.factory(context);
  }
}

async function* onePage(records: unknown[], completeSnapshot = true): AsyncIterable<ConnectorPage> {
  yield {
    records,
    nextCursor: null,
    hasMore: false,
    reportedTotal: records.length,
    completeSnapshot,
  };
}

describe("CatalogSyncOrchestrator", () => {
  let connection: CatalogDatabaseConnection;
  let repository: CatalogRepository;

  beforeEach(async () => {
    const directory = mkdtempSync(join(tmpdir(), "aisle-orchestrator-test-"));
    connection = createCatalogDatabase({
      url: `file:${join(directory, "catalog.db").replaceAll("\\", "/")}`,
    });
    await migrateCatalogDatabase(connection.client);
    repository = new CatalogRepository(connection.db);
    await seedCatalog(repository);
  });

  afterEach(() => connection.client.close());

  it("isolates connector failures and persists disabled coverage truthfully", async () => {
    const good = new FixtureConnector("good-fixture", () => onePage([candidate("good")]));
    const failing = new FixtureConnector("failing-fixture", async function* () {
      throw new Error("inert connector outage");
    });
    const disabled = new FixtureConnector("disabled-fixture", () => onePage([]), {
      enabled: false,
    });
    const results = await new CatalogSyncOrchestrator(repository, {
      validateRecord: createAgentSkillValidator(),
    }).sync([good, failing, disabled]);

    expect(results).toEqual([
      expect.objectContaining({ sourceId: "good-fixture", status: "current" }),
      expect.objectContaining({ sourceId: "failing-fixture", status: "partial" }),
      expect.objectContaining({ sourceId: "disabled-fixture", status: "not-configured" }),
    ]);
    const [disabledSource] = await connection.db
      .select()
      .from(catalogSources)
      .where(eq(catalogSources.id, "disabled-fixture"));
    expect(disabledSource).toMatchObject({
      coverageState: "not-configured",
      exclusionsJson: ["Disabled inert fixture."],
    });
  });

  it("keeps zero-page and prematurely exhausted connectors partial", async () => {
    const zero = new FixtureConnector("zero-fixture", async function* () {
      return;
    });
    const premature = new FixtureConnector("premature-fixture", async function* () {
      yield {
        records: [candidate("premature")],
        nextCursor: "next",
        hasMore: true,
        reportedTotal: 2,
        completeSnapshot: false,
      };
    });
    const orchestrator = new CatalogSyncOrchestrator(repository, {
      validateRecord: createAgentSkillValidator(),
    });
    await expect(orchestrator.syncConnector(zero)).resolves.toMatchObject({
      status: "partial",
      processed: 0,
    });
    await expect(orchestrator.syncConnector(premature)).resolves.toMatchObject({
      status: "partial",
      processed: 1,
    });
    const coverage = await repository.coverage();
    expect(coverage.find((entry) => entry.sourceId === "zero-fixture")).toMatchObject({
      state: "partial",
      lastSuccessfulSyncAt: null,
    });
    expect(coverage.find((entry) => entry.sourceId === "premature-fixture")).toMatchObject({
      state: "partial",
      recordCount: 1,
      lastSuccessfulSyncAt: null,
    });
  });

  it("starts a new snapshot after terminal partial coverage so omissions accrue misses", async () => {
    const partial = new FixtureConnector("terminal-partial-fixture", async function* () {
      yield {
        records: [candidate("terminal-partial")],
        nextCursor: null,
        hasMore: false,
        reportedTotal: 1,
        completeSnapshot: false,
        degraded: true,
      };
    });
    const complete = new FixtureConnector(
      "terminal-partial-fixture",
      () => onePage([]),
    );
    const orchestrator = new CatalogSyncOrchestrator(repository, {
      validateRecord: createAgentSkillValidator(),
      unavailableAfterCompleteMisses: 2,
    });
    expect((await orchestrator.syncConnector(partial)).status).toBe("partial");
    expect((await orchestrator.syncConnector(complete)).status).toBe("current");
    const runs = await connection.db.select().from(syncRuns);
    expect(new Set(runs.map((run) => run.id)).size).toBe(2);
    const [listing] = await connection.db.select().from(sourceListings);
    expect(listing).toMatchObject({ status: "stale", missedCompleteCrawls: 1 });
  });

  it("does not age missing records from an impossible reported-total terminal page", async () => {
    const sourceId = "impossible-total-fixture";
    const populated = new FixtureConnector(sourceId, () => onePage([candidate("total-proof")]));
    const impossible = new FixtureConnector(sourceId, async function* () {
      yield {
        records: [],
        nextCursor: null,
        hasMore: false,
        reportedTotal: 1,
        completeSnapshot: true,
      };
    });
    const orchestrator = new CatalogSyncOrchestrator(repository, {
      validateRecord: createAgentSkillValidator(),
      unavailableAfterCompleteMisses: 1,
    });
    expect((await orchestrator.syncConnector(populated)).status).toBe("current");
    const result = await orchestrator.syncConnector(impossible);
    const [listing] = await connection.db.select().from(sourceListings);

    expect(result).toMatchObject({ status: "partial", processed: 0 });
    expect(result.failures.join(" ")).toMatch(/reported total 1/);
    expect(listing).toMatchObject({ status: "current", missedCompleteCrawls: 0 });
  });

  it("dead-letters permanent malformed candidates and checkpoints later pages", async () => {
    const connector = new FixtureConnector("malformed-fixture", async function* () {
      yield {
        records: [{ public: false, internal: true }],
        nextCursor: "next",
        hasMore: true,
        reportedTotal: 2,
        completeSnapshot: false,
      };
      yield {
        records: [candidate("later")],
        nextCursor: null,
        hasMore: false,
        reportedTotal: 2,
        completeSnapshot: true,
      };
    });
    const result = await new CatalogSyncOrchestrator(repository, {
      validateRecord: createAgentSkillValidator(),
    }).syncConnector(connector);
    expect(result).toMatchObject({ status: "partial", processed: 1 });
    expect(result.exclusions.some((entry) => entry.includes("Rejected malformed"))).toBe(true);
    expect(await connection.db.select().from(skills)).toHaveLength(1);
  });

  it("invalidates a formerly selectable identity when a later record is malformed", async () => {
    const sourceId = "malformed-reappearance-fixture";
    const valid = new FixtureConnector(sourceId, () => onePage([candidate("formerly-valid")]));
    const malformed = new FixtureConnector(sourceId, () =>
      onePage([
        {
          sourceRecordId: "formerly-valid:fixture-safe",
          public: false,
          internal: true,
        },
      ]),
    );
    const orchestrator = new CatalogSyncOrchestrator(repository, {
      validateRecord: createAgentSkillValidator(),
    });
    expect((await orchestrator.syncConnector(valid)).status).toBe("current");
    expect(await repository.search()).toHaveLength(1);
    expect((await orchestrator.syncConnector(malformed)).status).toBe("partial");
    expect(await repository.search()).toEqual([]);
    const [listing] = await connection.db.select().from(sourceListings);
    expect(listing).toMatchObject({ status: "unresolved", skillId: null });
  });

  it("replays transient validation failures without advancing the page checkpoint", async () => {
    let fail = true;
    const validator = async (): Promise<DiscoveryValidationResult> => {
      if (fail) throw new Error("transient validation dependency outage");
      return {
        valid: true,
        metadata: {
          name: "fixture-safe",
          description: "Inert fixture.",
          compatibility: null,
          license: "MIT",
        },
        trustAssessment: {
          scanner: "fixture",
          scannerVersion: "1",
          state: "pass",
          quarantineReason: null,
          findings: [],
        },
      };
    };
    const connector = new FixtureConnector("replay-fixture", () => onePage([candidate("replay")]));
    const orchestrator = new CatalogSyncOrchestrator(repository, { validateRecord: validator });
    const first = await orchestrator.syncConnector(connector);
    fail = false;
    const second = await orchestrator.syncConnector(connector);
    expect(first).toMatchObject({ status: "partial", processed: 0 });
    expect(second).toMatchObject({ status: "current", processed: 1 });
  });

  it("resumes a no-total snapshot without treating processed fallback as an upstream total", async () => {
    const connector = new FixtureConnector("no-total-resume-fixture", async function* (context) {
      if (context.cursor === null) {
        yield {
          records: [candidate("no-total-first")],
          nextCursor: "next",
          hasMore: true,
          reportedTotal: null,
          completeSnapshot: false,
        };
        throw new Error("Inert interruption after the first no-total page");
      }
      yield {
        records: [candidate("no-total-second")],
        nextCursor: null,
        hasMore: false,
        reportedTotal: null,
        completeSnapshot: true,
      };
    });
    const orchestrator = new CatalogSyncOrchestrator(repository, {
      validateRecord: createAgentSkillValidator(),
    });

    const first = await orchestrator.syncConnector(connector);
    const second = await orchestrator.syncConnector(connector);
    const [run] = await connection.db.select().from(syncRuns);

    expect(first).toMatchObject({ status: "partial", processed: 1 });
    expect(second).toMatchObject({ status: "current", processed: 2 });
    expect(run).toMatchObject({
      status: "succeeded",
      sourceTotal: 2,
      processedCount: 2,
      checkpointJson: expect.objectContaining({ reportedTotalKnown: false }),
    });
  });

  it("heartbeats through a slow page so a concurrent worker cannot steal the lease", async () => {
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const slow = new FixtureConnector("slow-fixture", async function* () {
      startedResolve();
      await new Promise((resolve) => setTimeout(resolve, 240));
      yield* onePage([candidate("slow")]);
    });
    const orchestrator = new CatalogSyncOrchestrator(repository, {
      validateRecord: createAgentSkillValidator(),
      leaseDurationMs: 100,
      heartbeatIntervalMs: 20,
    });
    const running = orchestrator.syncConnector(slow);
    await started;
    await new Promise((resolve) => setTimeout(resolve, 170));
    await expect(repository.acquireSyncRun("slow-fixture", 100)).rejects.toBeInstanceOf(
      CatalogSyncLeaseConflictError,
    );
    await expect(running).resolves.toMatchObject({ status: "current" });
  });

  it("applies complete on-demand misses and lifecycle transitions atomically", async () => {
    const populated = new FixtureConnector(
      "lifecycle-fixture",
      () => onePage([candidate("lifecycle")]),
      { mode: "on-demand" },
    );
    const empty = new FixtureConnector("lifecycle-fixture", () => onePage([]), {
      mode: "on-demand",
    });
    const orchestrator = new CatalogSyncOrchestrator(repository, {
      validateRecord: createAgentSkillValidator(),
      unavailableAfterCompleteMisses: 2,
    });
    await orchestrator.syncConnector(populated);
    await orchestrator.syncConnector(empty);
    let [skill] = await connection.db.select().from(skills);
    let [listing] = await connection.db.select().from(sourceListings);
    expect({ lifecycle: skill?.lifecycle, listing: listing?.status }).toEqual({
      lifecycle: "stale",
      listing: "stale",
    });
    await orchestrator.syncConnector(empty);
    [skill] = await connection.db.select().from(skills);
    [listing] = await connection.db.select().from(sourceListings);
    expect({ lifecycle: skill?.lifecycle, listing: listing?.status }).toEqual({
      lifecycle: "unavailable",
      listing: "unavailable",
    });
  });
});
