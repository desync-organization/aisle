// @vitest-environment node

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCatalogDatabase, type CatalogDatabaseConnection } from "../../db/client";
import { migrateCatalogDatabase } from "../../db/migrate";
import { CatalogRepository } from "../../db/repository";
import { auditRecords, skillRevisions, sourceListings, syncRuns } from "../../db/schema";
import { seedCatalog } from "../../db/seed";
import {
  computeArtifactContentHash,
  createTextArtifactInventory,
} from "../artifact-fingerprint";
import { CatalogIngestionService } from "../ingestion";
import { createAgentSkillValidator } from "../security";
import { SkillsShClient } from "./skills-sh-client";
import { SkillsShSync } from "./skills-sh-sync";

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

function listing(index: number) {
  return {
    id: `fixture-org/fixture-repo/fixture-skill-${index}`,
    slug: `fixture-skill-${index}`,
    name: `fixture-skill-${index}`,
    source: "fixture-org/fixture-repo",
    installs: index + 1,
    sourceType: "github",
    installUrl: index === 1 ? null : "https://github.com/fixture-org/fixture-repo",
    url: `https://skills.sh/fixture-org/fixture-repo/fixture-skill-${index}`,
  };
}

describe("SkillsShSync", () => {
  let connection: CatalogDatabaseConnection;
  let repository: CatalogRepository;
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "aisle-sync-test-"));
    connection = createCatalogDatabase({
      url: `file:${join(temporaryDirectory, "catalog.db").replaceAll("\\", "/")}`,
    });
    await migrateCatalogDatabase(connection.client);
    repository = new CatalogRepository(connection.db);
    await seedCatalog(repository);
  });

  afterEach(() => {
    connection?.client.close();
  });

  it("walks until hasMore is false, caches hydration, and remains idempotent", async () => {
    const conditionalRequests: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      const headers = new Headers(init?.headers);
      if (url.pathname.endsWith("/api/v1/skills")) {
        const page = Number(url.searchParams.get("page"));
        return json({
          data: [{ ...listing(page), hash: `sha256-fixture-org/fixture-repo/fixture-skill-${page}` }],
          pagination: { page, perPage: 1, total: 3, hasMore: page < 2 },
        });
      }
      if (url.pathname.includes("/skills/audit/")) {
        const id = url.pathname.split("/skills/audit/")[1]!;
        return json({
          id,
          source: "fixture-org/fixture-repo",
          slug: id.split("/").at(-1),
          audits: [
            {
              provider: "Fixture Auditor",
              slug: "fixture-auditor",
              status: "pass",
              summary: "No findings in inert fixture metadata.",
              auditedAt: "2026-07-20T12:00:00.000Z",
            },
          ],
        });
      }

      const id = url.pathname.split("/skills/")[1]!;
      if (headers.get("if-none-match")) {
        conditionalRequests.push(headers.get("if-none-match")!);
        return new Response(null, { status: 304, headers: { etag: `\"etag-${id}\"` } });
      }
      return json(
        {
          id,
          source: "fixture-org/fixture-repo",
          slug: id.split("/").at(-1),
          installs: 1,
          hash: `sha256-${id}`,
          files: null,
        },
        200,
        { etag: `\"etag-${id}\"`, "cache-control": "public, max-age=60" },
      );
    });
    const client = new SkillsShClient({
      fetch: fetchMock,
      tokenProvider: async () => "fixture-request-token",
      maxAttempts: 1,
    });
    const sync = new SkillsShSync(repository, client, { perPage: 1, detailConcurrency: 2 });

    const first = await sync.run();
    const second = await sync.run();
    const [listingCount] = await connection.db
      .select({ count: sql<number>`count(*)` })
      .from(sourceListings);
    const audits = await connection.db.select().from(auditRecords);

    expect(first).toMatchObject({
      status: "current",
      pages: 3,
      processed: 3,
      sourceTotal: 3,
      resumed: false,
    });
    expect(second).toMatchObject({ status: "current", pages: 3, processed: 3, resumed: false });
    expect(listingCount?.count).toBe(3);
    expect(conditionalRequests).toHaveLength(0);
    expect(audits).toHaveLength(3);
    expect(audits.every((audit) => audit.scope === "observation" && audit.revisionId === null)).toBe(
      true,
    );
  });

  it("checkpoints a partial listing crawl and resumes from the failed page", async () => {
    let failPageOne = true;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/api/v1/skills")) {
        const page = Number(url.searchParams.get("page"));
        if (page === 1 && failPageOne) {
          return json({ error: "temporarily_unavailable", message: "Fixture outage" }, 503);
        }
        return json({
          data: [listing(page)],
          pagination: { page, perPage: 1, total: 2, hasMore: page === 0 },
        });
      }
      if (url.pathname.includes("/skills/audit/")) {
        const id = url.pathname.split("/skills/audit/")[1]!;
        return json({
          id,
          source: "fixture-org/fixture-repo",
          slug: id.split("/").at(-1),
          audits: [],
        });
      }
      const id = url.pathname.split("/skills/")[1]!;
      return json({
        id,
        source: "fixture-org/fixture-repo",
        slug: id.split("/").at(-1),
        installs: 1,
        hash: `sha256-${id}`,
        files: null,
      });
    });
    const client = new SkillsShClient({
      fetch: fetchMock,
      tokenProvider: async () => "fixture-request-token",
      maxAttempts: 1,
    });
    const sync = new SkillsShSync(repository, client, { perPage: 1 });

    const interrupted = await sync.run();
    failPageOne = false;
    const resumed = await sync.run();
    const [run] = await connection.db
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.id, interrupted.runId));

    expect(interrupted).toMatchObject({ status: "partial", pages: 1, processed: 1 });
    expect(resumed).toMatchObject({
      status: "current",
      runId: interrupted.runId,
      resumed: true,
      pages: 2,
      processed: 2,
    });
    expect(run).toMatchObject({ status: "succeeded", nextPage: 2, completeCrawl: true });
    expect(await repository.countSourceListings("skills-sh")).toBe(2);
  });

  it.each([
    {
      label: "short terminal page",
      pages: [{ data: [], pagination: { page: 0, perPage: 1, total: 1, hasMore: false } }],
      error: /terminal page ended at 0 of 1/,
    },
    {
      label: "duplicate ids across pages",
      pages: [
        { data: [listing(0)], pagination: { page: 0, perPage: 1, total: 2, hasMore: true } },
        { data: [listing(0)], pagination: { page: 1, perPage: 1, total: 2, hasMore: false } },
      ],
      error: /duplicate listing id/,
    },
    {
      label: "reported-total drift",
      pages: [
        { data: [listing(0)], pagination: { page: 0, perPage: 1, total: 2, hasMore: true } },
        { data: [listing(1)], pagination: { page: 1, perPage: 1, total: 3, hasMore: false } },
      ],
      error: /total drifted/,
    },
    {
      label: "hasMore after total",
      pages: [
        { data: [listing(0)], pagination: { page: 0, perPage: 1, total: 1, hasMore: true } },
      ],
      error: /claimed more pages after reaching/,
    },
    {
      label: "echoed page-size mismatch",
      pages: [{ data: [], pagination: { page: 0, perPage: 2, total: 0, hasMore: false } }],
      error: /echoed perPage=2/,
    },
  ])("keeps an inconsistent skills.sh $label snapshot partial", async ({ pages, error }) => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/api/v1/skills")) {
        const page = Number(url.searchParams.get("page"));
        return json(pages[page] ?? pages.at(-1));
      }
      const id = url.pathname.split(/\/skills\/(?:audit\/)?/)[1]!;
      if (url.pathname.includes("/skills/audit/")) {
        return json({ id, source: "fixture-org/fixture-repo", slug: id.split("/").at(-1), audits: [] });
      }
      return json({
        id,
        source: "fixture-org/fixture-repo",
        slug: id.split("/").at(-1),
        installs: 1,
        hash: `provider-${id}`,
        files: null,
      });
    });
    const result = await new SkillsShSync(
      repository,
      new SkillsShClient({
        fetch: fetchMock,
        tokenProvider: async () => "fixture-token",
        maxAttempts: 1,
      }),
      { perPage: 1 },
    ).run();

    expect(result.status).toBe("partial");
    expect(result.failures.join(" ")).toMatch(error);
    expect((await repository.coverage()).find((entry) => entry.sourceId === "skills-sh")?.state)
      .toBe("partial");
  });

  it("persists a credentials-required coverage state without throwing", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new SkillsShClient({
      fetch: fetchMock,
      tokenProvider: async () => undefined,
    });

    const result = await new SkillsShSync(repository, client).run();
    const coverage = await repository.coverage();
    const [run] = await connection.db
      .select()
      .from(syncRuns)
      .where(and(eq(syncRuns.id, result.runId), eq(syncRuns.sourceId, "skills-sh")));

    expect(result.status).toBe("credentials-required");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(coverage.find((source) => source.sourceId === "skills-sh")?.state).toBe(
      "credentials-required",
    );
    expect(run?.status).toBe("partial");
  });

  it("persists the same coverage state for an upstream 401", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ error: "unauthorized", message: "Expired fixture token" }, 401));
    const client = new SkillsShClient({
      fetch: fetchMock,
      tokenProvider: async () => "expired-fixture-token",
      maxAttempts: 1,
    });

    const result = await new SkillsShSync(repository, client).run();
    const coverage = await repository.coverage();

    expect(result.status).toBe("credentials-required");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(coverage.find((source) => source.sourceId === "skills-sh")).toMatchObject({
      state: "credentials-required",
      error: "Expired fixture token",
    });
  });

  it("replays a final page when one record was not durably hydrated", async () => {
    let failDetail = true;
    let listingRequests = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/api/v1/skills")) {
        listingRequests += 1;
        return json({
          data: [listing(0)],
          pagination: { page: 0, perPage: 1, total: 1, hasMore: false },
        });
      }
      if (url.pathname.includes("/skills/audit/")) {
        return json({
          id: "fixture-org/fixture-repo/fixture-skill-0",
          source: "fixture-org/fixture-repo",
          slug: "fixture-skill-0",
          audits: [],
        });
      }
      if (failDetail) {
        failDetail = false;
        return json({ message: "inert detail outage" }, 503);
      }
      return json({
        id: "fixture-org/fixture-repo/fixture-skill-0",
        source: "fixture-org/fixture-repo",
        slug: "fixture-skill-0",
        installs: 1,
        hash: "a".repeat(64),
        files: null,
      });
    });
    const sync = new SkillsShSync(
      repository,
      new SkillsShClient({
        fetch: fetchMock,
        tokenProvider: async () => "fixture-token",
        maxAttempts: 1,
      }),
      { perPage: 1 },
    );
    const first = await sync.run();
    const second = await sync.run();
    expect(first).toMatchObject({ status: "partial", pages: 0, processed: 0 });
    expect(second).toMatchObject({
      status: "current",
      resumed: false,
      pages: 1,
      processed: 1,
    });
    expect(second.runId).not.toBe(first.runId);
    expect(listingRequests).toBe(2);
  });

  it("turns a real-shaped skills.sh detail into a validated canonical revision", async () => {
    const manifest = `---
name: fixture-skill-0
description: Inert skills.sh canonical integration fixture.
license: MIT
---

# Fixture
`;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/api/v1/skills")) {
        return json({
          data: [listing(0)],
          pagination: { page: 0, perPage: 1, total: 1, hasMore: false },
        });
      }
      if (url.pathname.includes("/skills/audit/")) {
        return json({
          id: "fixture-org/fixture-repo/fixture-skill-0",
          source: "fixture-org/fixture-repo",
          slug: "fixture-skill-0",
          audits: [],
        });
      }
      return json({
        id: "fixture-org/fixture-repo/fixture-skill-0",
        source: "fixture-org/fixture-repo",
        slug: "fixture-skill-0",
        installs: 1,
        hash: "b".repeat(64),
        files: [{ path: "SKILL.md", contents: manifest }],
      });
    });
    const ingestion = new CatalogIngestionService(repository, createAgentSkillValidator());
    const result = await new SkillsShSync(
      repository,
      new SkillsShClient({
        fetch: fetchMock,
        tokenProvider: async () => "fixture-token",
        maxAttempts: 1,
      }),
      { perPage: 1, ingestion },
    ).run();
    const selected = await repository.search();
    const [storedListing] = await connection.db.select().from(sourceListings);

    expect(result.status).toBe("current");
    expect(selected).toEqual([
      expect.objectContaining({
        name: "fixture-skill-0",
        immutableRef: "b".repeat(64),
        contentHash: computeArtifactContentHash(
          createTextArtifactInventory([{ path: "SKILL.md", contents: manifest }]),
        ),
        installs: 1,
        installSpec: {
          kind: "registry",
          registry: "skills.sh",
          identifier: "fixture-org/fixture-repo/fixture-skill-0",
          version: "b".repeat(64),
        },
      }),
    ]);
    expect(storedListing?.skillId).toBe(selected[0]?.id);
  });

  it("persists only allowlisted skills.sh listing and audit metadata", async () => {
    const providerMarker = "provider-opaque-marker-must-not-persist";
    const artifactBodyMarker = "transient-artifact-body-must-not-persist";
    const manifest = `---
name: fixture-skill-0
description: Inert skills.sh provider-boundary fixture.
license: MIT
---

# ${artifactBodyMarker}
`;
    const providerHash = "d".repeat(64);
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/api/v1/skills")) {
        return json({
          data: [
            {
              ...listing(0),
              hash: providerHash,
              futureOpaqueListingPayload: { nested: providerMarker },
            },
          ],
          pagination: { page: 0, perPage: 1, total: 1, hasMore: false },
        });
      }
      if (url.pathname.includes("/skills/audit/")) {
        return json({
          id: "fixture-org/fixture-repo/fixture-skill-0",
          source: "fixture-org/fixture-repo",
          slug: "fixture-skill-0",
          audits: [
            {
              provider: "Fixture Auditor",
              slug: "fixture-auditor",
              status: "pass",
              summary: "No findings in the inert fixture.",
              auditedAt: "2026-07-20T12:00:00.000Z",
              futureOpaqueAuditPayload: { nested: providerMarker },
            },
          ],
          futureOpaqueAuditEnvelope: providerMarker,
        });
      }
      return json({
        id: "fixture-org/fixture-repo/fixture-skill-0",
        source: "fixture-org/fixture-repo",
        slug: "fixture-skill-0",
        installs: 1,
        hash: providerHash,
        files: [
          {
            path: "SKILL.md",
            contents: manifest,
            futureOpaqueFilePayload: providerMarker,
          },
        ],
        futureOpaqueDetailPayload: { nested: providerMarker },
      });
    });
    const result = await new SkillsShSync(
      repository,
      new SkillsShClient({
        fetch: fetchMock,
        tokenProvider: async () => "fixture-token",
        maxAttempts: 1,
      }),
      {
        perPage: 1,
        ingestion: new CatalogIngestionService(repository, createAgentSkillValidator()),
      },
    ).run();
    const [storedListing] = await connection.db.select().from(sourceListings);
    const storedAudits = await connection.db.select().from(auditRecords);
    const persistedJson = JSON.stringify({
      listing: storedListing?.rawJson,
      audits: storedAudits.map((audit) => audit.rawJson),
    });

    expect(result.status).toBe("current");
    expect(storedListing?.rawJson).toMatchObject({
      listing: {
        id: "fixture-org/fixture-repo/fixture-skill-0",
        hash: providerHash,
      },
      detail: {
        id: "fixture-org/fixture-repo/fixture-skill-0",
        fileCount: 1,
      },
    });
    expect(storedAudits).toHaveLength(1);
    expect(storedAudits[0]?.rawJson).toEqual({
      provider: "Fixture Auditor",
      slug: "fixture-auditor",
      status: "pass",
      summary: "No findings in the inert fixture.",
      auditedAt: "2026-07-20T12:00:00.000Z",
      riskLevel: null,
    });
    expect(persistedJson).not.toContain(providerMarker);
    expect(persistedJson).not.toContain(artifactBodyMarker);
    expect(persistedJson).not.toContain("fileInventory");
  });

  it("never sends old validators after a listing hash changes or audits new hash against old bytes", async () => {
    let run = 0;
    let audits = 0;
    let changedIfNoneMatch: string | null = null;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/api/v1/skills")) {
        return json({
          data: [{ ...listing(0), hash: run === 0 ? "a".repeat(64) : "b".repeat(64) }],
          pagination: { page: 0, perPage: 1, total: 1, hasMore: false },
        });
      }
      if (url.pathname.includes("/skills/audit/")) {
        audits += 1;
        return json({
          id: "fixture-org/fixture-repo/fixture-skill-0",
          source: "fixture-org/fixture-repo",
          slug: "fixture-skill-0",
          audits: [],
        });
      }
      if (run === 0) {
        return json(
          {
            id: "fixture-org/fixture-repo/fixture-skill-0",
            source: "fixture-org/fixture-repo",
            slug: "fixture-skill-0",
            installs: 1,
            hash: "a".repeat(64),
            files: null,
          },
          200,
          { etag: '"old"' },
        );
      }
      changedIfNoneMatch = new Headers(init?.headers).get("if-none-match");
      return new Response(null, { status: 304 });
    });
    const sync = new SkillsShSync(
      repository,
      new SkillsShClient({
        fetch: fetchMock,
        tokenProvider: async () => "fixture-token",
        maxAttempts: 1,
      }),
      { perPage: 1 },
    );
    expect((await sync.run()).status).toBe("current");
    run = 1;
    expect((await sync.run()).status).toBe("partial");
    expect(changedIfNoneMatch).toBeNull();
    expect(audits).toBe(1);
  });

  it.each([
    ["changed", "b".repeat(64)],
    ["removed", null],
  ])("detaches the old revision when a listing hash is %s and hydration fails", async (_label, nextHash) => {
    let run = 0;
    const manifest = `---\nname: fixture-skill-0\ndescription: Inert changed-hash fixture.\nlicense: MIT\n---\n`;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/api/v1/skills")) {
        return json({
          data: [
            {
              ...listing(0),
              ...(run === 0
                ? { hash: "a".repeat(64) }
                : nextHash
                  ? { hash: nextHash }
                  : {}),
            },
          ],
          pagination: { page: 0, perPage: 1, total: 1, hasMore: false },
        });
      }
      if (url.pathname.includes("/skills/audit/")) {
        return json({
          id: "fixture-org/fixture-repo/fixture-skill-0",
          source: "fixture-org/fixture-repo",
          slug: "fixture-skill-0",
          audits: [],
        });
      }
      if (run > 0) return json({ message: "inert upstream outage" }, 503);
      return json({
        id: "fixture-org/fixture-repo/fixture-skill-0",
        source: "fixture-org/fixture-repo",
        slug: "fixture-skill-0",
        installs: 1,
        hash: "a".repeat(64),
        files: [{ path: "SKILL.md", contents: manifest }],
      });
    });
    const sync = new SkillsShSync(
      repository,
      new SkillsShClient({
        fetch: fetchMock,
        tokenProvider: async () => "fixture-token",
        maxAttempts: 1,
      }),
      {
        perPage: 1,
        ingestion: new CatalogIngestionService(repository, createAgentSkillValidator()),
      },
    );
    expect((await sync.run()).status).toBe("current");
    run = 1;
    expect((await sync.run()).status).toBe("partial");
    expect(await repository.search()).toEqual([]);
    const [stored] = await connection.db.select().from(sourceListings);
    expect(stored).toMatchObject({
      status: "unresolved",
      skillId: null,
      sourceHash: nextHash,
    });
    expect(await connection.db.select().from(skillRevisions)).toHaveLength(1);
  });

  it("does not reuse a provider revision hash for changed scanned bytes", async () => {
    let changed = false;
    const firstManifest = `---\nname: fixture-skill-0\ndescription: First inert bytes.\nlicense: MIT\n---\n`;
    const secondManifest = firstManifest.replace("First inert bytes.", "Changed inert bytes.");
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/api/v1/skills")) {
        return json({
          data: [{ ...listing(0), hash: "a".repeat(64) }],
          pagination: { page: 0, perPage: 1, total: 1, hasMore: false },
        });
      }
      if (url.pathname.includes("/skills/audit/")) {
        return json({
          id: "fixture-org/fixture-repo/fixture-skill-0",
          source: "fixture-org/fixture-repo",
          slug: "fixture-skill-0",
          audits: [],
        });
      }
      return json({
        id: "fixture-org/fixture-repo/fixture-skill-0",
        source: "fixture-org/fixture-repo",
        slug: "fixture-skill-0",
        installs: 1,
        hash: "a".repeat(64),
        files: [{ path: "SKILL.md", contents: changed ? secondManifest : firstManifest }],
      });
    });
    const sync = new SkillsShSync(
      repository,
      new SkillsShClient({
        fetch: fetchMock,
        tokenProvider: async () => "fixture-token",
        maxAttempts: 1,
      }),
      {
        perPage: 1,
        ingestion: new CatalogIngestionService(repository, createAgentSkillValidator()),
      },
    );
    expect((await sync.run()).status).toBe("current");
    const invalidationRun = await repository.acquireSyncRun("skills-sh");
    await repository.markSourceRecordUnresolved(
      {
        sourceId: "skills-sh",
        runId: invalidationRun.id,
        leaseToken: invalidationRun.leaseToken,
      },
      "fixture-org/fixture-repo/fixture-skill-0",
      "a".repeat(64),
    );
    await repository.failSyncRun({
      runId: invalidationRun.id,
      leaseToken: invalidationRun.leaseToken,
      sourceId: "skills-sh",
      message: "Complete the fixture invalidation run.",
    });
    changed = true;
    const second = await sync.run();
    expect(second.status).toBe("partial");
    expect(second.failures.join(" ")).toMatch(/changed content hash/);
    expect(await repository.search()).toEqual([]);
    const revisions = await connection.db.select().from(skillRevisions);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.contentHash).toBe(
      computeArtifactContentHash(
        createTextArtifactInventory([{ path: "SKILL.md", contents: firstManifest }]),
      ),
    );
  });

  it("settles sibling hydration workers before finalizing an authentication failure", async () => {
    let siblingSettled = false;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/api/v1/skills")) {
        return json({
          data: [listing(0), listing(1)],
          pagination: { page: 0, perPage: 2, total: 2, hasMore: false },
        });
      }
      if (url.pathname.includes("fixture-skill-0")) {
        return json({ message: "expired" }, 401);
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
      siblingSettled = true;
      return json({
        id: "fixture-org/fixture-repo/fixture-skill-1",
        source: "fixture-org/fixture-repo",
        slug: "fixture-skill-1",
        installs: 1,
        hash: "c".repeat(64),
        files: null,
      });
    });
    const result = await new SkillsShSync(
      repository,
      new SkillsShClient({
        fetch: fetchMock,
        tokenProvider: async () => "fixture-token",
        maxAttempts: 1,
      }),
      { perPage: 2, detailConcurrency: 2 },
    ).run();
    expect(result.status).toBe("credentials-required");
    expect(siblingSettled).toBe(true);
  });
});
