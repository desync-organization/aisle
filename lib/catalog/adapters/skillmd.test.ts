// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createCatalogDatabase } from "../../db/client";
import { migrateCatalogDatabase } from "../../db/migrate";
import { CatalogRepository } from "../../db/repository";
import { sourceListings } from "../../db/schema";
import { seedCatalog } from "../../db/seed";
import { CatalogIngestionService } from "../ingestion";
import { createAgentSkillValidator, validateAgentSkillRecord } from "../security";
import type { DiscoveredSkillRecord } from "../source-contract";
import type { SkillMdListItem, SkillMdSkillMetadata } from "./skillmd-client";
import { SkillMdAdapter } from "./skillmd";

const COMMIT = "a".repeat(40);
const SKILL = `---
name: fixture-safe
description: Inert SkillMD adapter fixture.
license: MIT
---

# Fixture
`;
const REFERENCE = "Inert supporting reference.\n";
const LICENSE = "Inert repository license fixture.\n";

function gitBlobSha(contents: string): string {
  const bytes = Buffer.from(contents);
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function item(): SkillMdListItem {
  return {
    slug: "fixture-owner/fixture-safe",
    type: "skill",
    title: "Fixture safe",
    description: "Inert listing fixture.",
    verified: true,
    verified_scope: "provider-badge-only",
  };
}

function detail(overrides: Partial<SkillMdSkillMetadata> = {}): SkillMdSkillMetadata {
  return {
    slug: "fixture-owner/fixture-safe",
    title: "Fixture safe",
    description: "Inert detail fixture.",
    type: "skill",
    verified: true,
    verified_scope: "provider-badge-only",
    license: "MIT",
    source_repo:
      "https://github.com/fixture-owner/fixture-repository/tree/main/skills/fixture-safe",
    commit_sha: COMMIT,
    install_snippet: "never executed",
    inventory: [],
    ...overrides,
  };
}

function client(metadata = detail(), listing = item()) {
  return {
    listSkills: vi.fn(async () => ({
      items: [listing],
      limit: 100,
      offset: 0,
      nextOffset: null,
    })),
    detail: vi.fn(async () => metadata),
  };
}

async function firstPage(adapter: SkillMdAdapter) {
  for await (const page of adapter.enumerate({ cursor: null })) return page;
  throw new Error("adapter did not yield a page");
}

function githubFetch(branchHead = COMMIT): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.github.com" && url.pathname.endsWith("fixture-repository")) {
      return json({
        full_name: "fixture-owner/fixture-repository",
        html_url: "https://github.com/fixture-owner/fixture-repository",
        private: false,
        visibility: "public",
        owner: { login: "fixture-owner" },
        name: "fixture-repository",
        default_branch: "main",
      });
    }
    if (url.hostname === "api.github.com" && url.pathname.endsWith("/commits/main")) {
      return json({ sha: branchHead });
    }
    if (url.hostname === "api.github.com" && url.pathname.includes("/git/commits/")) {
      return json({ sha: COMMIT, tree: { sha: "tree-sha" } });
    }
    if (url.hostname === "api.github.com" && url.pathname.includes("/git/trees/")) {
      return json({
        sha: "tree-sha",
        truncated: false,
        tree: [
          {
            path: "skills/fixture-safe/SKILL.md",
            mode: "100644",
            type: "blob",
            sha: gitBlobSha(SKILL),
            size: Buffer.byteLength(SKILL),
          },
          {
            path: "skills/fixture-safe/reference.md",
            mode: "100644",
            type: "blob",
            sha: gitBlobSha(REFERENCE),
            size: Buffer.byteLength(REFERENCE),
          },
          {
            path: "LICENSE",
            mode: "100644",
            type: "blob",
            sha: gitBlobSha(LICENSE),
            size: Buffer.byteLength(LICENSE),
          },
        ],
      });
    }
    if (url.hostname === "api.github.com" && url.pathname.endsWith("/contents/LICENSE")) {
      return new Response(LICENSE);
    }
    if (url.hostname === "raw.githubusercontent.com") {
      return new Response(url.pathname.endsWith("SKILL.md") ? SKILL : REFERENCE);
    }
    return new Response(null, { status: 404 });
  });
}

describe("SkillMdAdapter", () => {
  it("binds SkillMD discovery to exact public GitHub tree bytes", async () => {
    const fetchMock = githubFetch();
    const page = await firstPage(
      new SkillMdAdapter({
        client: client(detail({ category: "Data & AI" })),
        fetch: fetchMock,
        githubToken: "fixture-github-token",
      }),
    );
    expect(page).toMatchObject({ completeSnapshot: false, degraded: true, hasMore: false });
    const record = page.records[0] as DiscoveredSkillRecord;
    expect(record).toMatchObject({
      provider: "skillmd",
      sourceUrl: "https://github.com/fixture-owner/fixture-repository",
      skillPath: "skills/fixture-safe",
      immutableRef: COMMIT,
      categoryHints: { categories: ["Data & AI"], tags: [] },
      installSpec: {
        kind: "source",
        sourceUrl: "https://github.com/fixture-owner/fixture-repository",
        immutableRef: COMMIT,
        skillPath: "skills/fixture-safe",
      },
      repository: {
        observedBranchHead: { branch: "main", headSha: COMMIT },
      },
      repositoryLicenseEvidence: {
        path: "LICENSE",
        contents: LICENSE,
        sha256: createHash("sha256").update(LICENSE).digest("hex"),
        sourceUrl: "https://github.com/fixture-owner/fixture-repository",
        immutableRef: COMMIT,
      },
      artifact: { complete: true },
    });
    expect(record.contentHash).not.toBe(createHash("sha256").update(COMMIT).digest("hex"));
    expect(validateAgentSkillRecord(record).trustAssessment?.state).toBe("pass");
    expect(record.raw).toMatchObject({ providerVerifiedScope: "provider-badge-only" });
    expect(
      fetchMock.mock.calls.every(([, init]) => init?.redirect === "manual"),
    ).toBe(true);
    expect(
      fetchMock.mock.calls
        .filter(([input]) => new URL(String(input)).hostname === "api.github.com")
        .every(([, init]) => new Headers(init?.headers).get("authorization") === "Bearer fixture-github-token"),
    ).toBe(true);
  });

  it("persists only a bounded SkillMD metadata summary", async () => {
    const providerMarker = "skillmd-opaque-marker-must-not-persist";
    const installCommandMarker = "skillmd-install-command-must-not-persist";
    const inventoryPathMarker = "references/provider-inventory-path-must-not-persist.md";
    const markedItem = {
      ...item(),
      futureOpaqueListingPayload: { nested: providerMarker },
    } as SkillMdListItem;
    const markedDetail = {
      ...detail({
        install_snippet: installCommandMarker,
        raw_url: "https://registry.example/raw/provider-body",
        bundle_url: "https://registry.example/bundle/provider-body",
        inventory: [
          {
            path: inventoryPathMarker,
            size_bytes: Number.MAX_SAFE_INTEGER,
            is_script: 1,
            storage: "provider",
          },
          {
            path: "references/second-provider-path.md",
            size_bytes: 42,
            is_script: 0,
            storage: "provider",
          },
        ],
      }),
      futureOpaqueDetailPayload: { nested: providerMarker },
    } as SkillMdSkillMetadata;
    const page = await firstPage(
      new SkillMdAdapter({
        client: client(markedDetail, markedItem),
        fetch: githubFetch(),
        githubToken: "fixture-github-token",
      }),
    );
    const record = page.records[0] as DiscoveredSkillRecord;
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "aisle-skillmd-boundary-test-"));
    const connection = createCatalogDatabase({
      url: `file:${join(temporaryDirectory, "catalog.db").replaceAll("\\", "/")}`,
    });

    try {
      await migrateCatalogDatabase(connection.client);
      const repository = new CatalogRepository(connection.db);
      await seedCatalog(repository);
      const run = await repository.acquireSyncRun("skillmd");
      const persisted = await new CatalogIngestionService(
        repository,
        createAgentSkillValidator(),
      ).persist(
        { sourceId: "skillmd", runId: run.id, leaseToken: run.leaseToken },
        record,
      );
      const [storedListing] = await connection.db.select().from(sourceListings);
      const persistedJson = JSON.stringify(storedListing?.rawJson);

      expect(persisted.resolved).toBe(true);
      expect(storedListing?.rawJson).toMatchObject({
        listing: {
          slug: "fixture-owner/fixture-safe",
          verifiedScope: "provider-badge-only",
        },
        detail: {
          commitSha: COMMIT,
          inventory: {
            fileCount: 2,
            totalBytes: Number.MAX_SAFE_INTEGER,
            scriptCount: 1,
          },
        },
        sourceTreeSha: "tree-sha",
      });
      expect(persistedJson).not.toContain(providerMarker);
      expect(persistedJson).not.toContain(installCommandMarker);
      expect(persistedJson).not.toContain(inventoryPathMarker);
      expect(persistedJson).not.toContain("raw/provider-body");
      expect(persistedJson).not.toContain("bundle/provider-body");
    } finally {
      connection.client.close();
    }
  });

  it("keeps entries without immutable public source metadata unresolved", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const page = await firstPage(
      new SkillMdAdapter({
        client: client(detail({ source_repo: null, commit_sha: null })),
        fetch: fetchMock,
      }),
    );
    expect(page.records).toEqual([
      expect.objectContaining({
        sourceRecordId: "fixture-owner/fixture-safe",
        installSpec: null,
        artifact: null,
      }),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a nominated commit that is not the default-branch head unresolved", async () => {
    const page = await firstPage(
      new SkillMdAdapter({
        client: client(),
        fetch: githubFetch("b".repeat(40)),
      }),
    );

    expect(page.records).toEqual([
      expect.objectContaining({ installSpec: null, artifact: null }),
    ]);
    expect(page.exclusions).toEqual([
      expect.stringContaining("no stable snapshot token"),
      expect.stringContaining("not the current public default-branch head"),
    ]);
  });

  it("degrades GitHub redirects without following their target", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.invalid/source" },
      }),
    );
    const page = await firstPage(
      new SkillMdAdapter({ client: client(), fetch: fetchMock }),
    );
    expect(page).toMatchObject({ degraded: true, completeSnapshot: false });
    expect(page.records).toEqual([
      expect.objectContaining({ installSpec: null, artifact: null }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a short mutable offset page non-retiring", async () => {
    const page = await firstPage(
      new SkillMdAdapter({
        client: client(detail({ source_repo: null, commit_sha: null })),
        fetch: vi.fn<typeof fetch>(),
      }),
    );
    expect(page).toMatchObject({ hasMore: false, completeSnapshot: false, degraded: true });
    expect(page.exclusions).toEqual([
      expect.stringContaining("no stable snapshot token"),
      expect.stringContaining("immutable public GitHub source metadata was unavailable"),
    ]);
  });
});
