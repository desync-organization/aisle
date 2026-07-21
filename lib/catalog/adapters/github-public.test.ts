// @vitest-environment node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { validateAgentSkillRecord } from "../security";
import type { DiscoveredSkillRecord } from "../source-contract";
import { GitHubPublicRepositoryAdapter } from "./github-public";

const COMMIT = "a".repeat(40);
const BINARY = new Uint8Array([0, 1, 2, 3]);
const SKILL = `---
name: fixture-safe
description: Inert GitHub adapter fixture.
license: MIT
---

# Fixture
`;
const SKILL_WITHOUT_LICENSE = SKILL.replace("license: MIT\n", "");

function blobSha(contents: string | Uint8Array): string {
  const bytes = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

function repo(privateRepository = false) {
  return {
    full_name: "example/skills",
    html_url: "https://github.com/example/skills",
    private: privateRepository,
    visibility: privateRepository ? "private" : "public",
    default_branch: "main",
    owner: { login: "example" },
    name: "skills",
    topics: ["react", "testing"],
  };
}

function tree(truncated = false) {
  return {
    sha: "tree-sha",
    truncated,
    tree: [
      {
        path: "fixture-safe/SKILL.md",
        mode: "100644",
        type: "blob",
        sha: blobSha(SKILL),
        size: Buffer.byteLength(SKILL),
      },
      {
        path: "fixture-safe/assets/pixel.png",
        mode: "100644",
        type: "blob",
        sha: blobSha(BINARY),
        size: BINARY.byteLength,
      },
    ],
  };
}

function successfulFetch(): typeof fetch {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/example/skills") return json(repo());
    if (url.pathname.includes("/commits/")) return json({ sha: COMMIT });
    if (url.pathname.includes("/git/trees/")) return json(tree());
    if (url.pathname.includes("/assets/pixel.png")) return new Response(BINARY);
    if (url.pathname.includes("/contents/")) return new Response(SKILL);
    return new Response(null, { status: 404 });
  });
}

async function firstPage(adapter: GitHubPublicRepositoryAdapter) {
  for await (const page of adapter.enumerate({ cursor: null })) return page;
  throw new Error("adapter did not yield");
}

async function validateRootLicense(options: {
  advertised: Array<{ path: string; contents: string }>;
  returned?: Record<string, string>;
  maxLicenseBytes?: number;
}) {
  const treeEntries = [
    {
      path: "fixture-safe/SKILL.md",
      mode: "100644",
      type: "blob",
      sha: blobSha(SKILL_WITHOUT_LICENSE),
      size: Buffer.byteLength(SKILL_WITHOUT_LICENSE),
    },
    ...options.advertised.map((entry) => ({
      path: entry.path,
      mode: "100644",
      type: "blob",
      sha: blobSha(entry.contents),
      size: Buffer.byteLength(entry.contents),
    })),
  ];
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/example/skills") return json(repo());
    if (url.pathname.includes("/commits/")) return json({ sha: COMMIT });
    if (url.pathname.includes("/git/trees/")) {
      return json({ sha: "tree-sha", truncated: false, tree: treeEntries });
    }
    if (url.pathname.includes("/fixture-safe/SKILL.md")) {
      return new Response(SKILL_WITHOUT_LICENSE);
    }
    const path = decodeURIComponent(url.pathname.split("/contents/")[1] ?? "");
    const advertised = options.advertised.find((entry) => entry.path === path);
    if (advertised) {
      return new Response(options.returned?.[path] ?? advertised.contents);
    }
    return new Response(null, { status: 404 });
  });
  const page = await firstPage(
    new GitHubPublicRepositoryAdapter({
      repositoryUrl: "https://github.com/example/skills",
      fetch: fetchMock,
      maxLicenseBytes: options.maxLicenseBytes,
    }),
  );
  const record = page.records[0] as DiscoveredSkillRecord;
  return { page, record, result: validateAgentSkillRecord(record), fetchMock };
}

describe("GitHubPublicRepositoryAdapter", () => {
  it("pins public repository records to an exact commit and scans bounded text", async () => {
    const page = await firstPage(
      new GitHubPublicRepositoryAdapter({
        repositoryUrl: "https://github.com/example/skills",
        fetch: successfulFetch(),
      }),
    );
    expect(page).toMatchObject({ completeSnapshot: true, degraded: false });
    expect(page.records).toEqual([
      expect.objectContaining({
        sourceRecordId: "example/skills:fixture-safe",
        immutableRef: COMMIT,
        categoryHints: { categories: [], tags: ["react", "testing"] },
        installSpec: {
          kind: "source",
          sourceUrl: "https://github.com/example/skills",
          immutableRef: COMMIT,
          skillPath: "fixture-safe",
        },
        artifact: expect.objectContaining({
          complete: true,
          contents: SKILL,
          files: expect.arrayContaining([
            expect.objectContaining({ path: "assets/pixel.png", type: "binary", size: 4 }),
          ]),
        }),
      }),
    ]);
  });

  it.each([
    ["MIT", "node_modules/clsx/license"],
    ["Apache-2.0", "node_modules/aria-query/LICENSE"],
  ])("accepts exact repository-root %s license evidence without changing installed inventory", async (spdx, path) => {
    const license = readFileSync(path, "utf8");
    const { record, result } = await validateRootLicense({
      advertised: [{ path: "LICENSE", contents: license }],
    });

    expect(result.metadata).toMatchObject({
      license: spdx,
      licenseEvidence: {
        path: "LICENSE",
        sha256: createHash("sha256").update(license).digest("hex"),
        source: "repository-root-license-text",
        sourceUrl: "https://github.com/example/skills",
        immutableRef: COMMIT,
      },
    });
    expect(record.artifact?.files?.map((file) => file.path)).toEqual(["SKILL.md"]);
  });

  it.each([
    ["missing", [], undefined, undefined],
    [
      "mismatched",
      [{ path: "LICENSE", contents: readFileSync("node_modules/clsx/license", "utf8") }],
      { LICENSE: "tampered license fixture" },
      undefined,
    ],
    [
      "ambiguous",
      [
        { path: "LICENSE", contents: readFileSync("node_modules/clsx/license", "utf8") },
        { path: "COPYING", contents: readFileSync("node_modules/aria-query/LICENSE", "utf8") },
      ],
      undefined,
      undefined,
    ],
    [
      "oversized",
      [{ path: "LICENSE", contents: readFileSync("node_modules/clsx/license", "utf8") }],
      undefined,
      64,
    ],
  ])("keeps %s repository-root license evidence unknown", async (_label, advertised, returned, maxLicenseBytes) => {
    const { result } = await validateRootLicense({
      advertised,
      returned,
      maxLicenseBytes,
    });
    expect(result.metadata).toMatchObject({ license: "unknown", licenseEvidence: null });
  });

  it("uses exponential fallback when Retry-After is absent and cancels retry bodies", async () => {
    let cancelled = false;
    let first = true;
    const fallback = successfulFetch();
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (first) {
        first = false;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("rate limited"));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 429 },
        );
      }
      return fallback(input, init);
    });
    const sleep = vi.fn(async () => undefined);
    await firstPage(
      new GitHubPublicRepositoryAdapter({
        repositoryUrl: "https://github.com/example/skills",
        fetch: fetchMock,
        sleep,
        maxAttempts: 2,
      }),
    );
    expect(sleep).toHaveBeenCalledWith(500);
    expect(cancelled).toBe(true);
  });

  it("streams oversized manifests into unresolved seen records instead of retiring them", async () => {
    let cancelled = false;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/repos/example/skills") return json(repo());
      if (url.pathname.includes("/commits/")) return json({ sha: COMMIT });
      if (url.pathname.includes("/git/trees/")) return json(tree());
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(8));
            controller.enqueue(new Uint8Array(8));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    });
    const page = await firstPage(
      new GitHubPublicRepositoryAdapter({
        repositoryUrl: "https://github.com/example/skills",
        fetch: fetchMock,
        maxManifestBytes: 10,
      }),
    );
    expect(cancelled).toBe(true);
    expect(page).toMatchObject({ degraded: true, completeSnapshot: false });
    expect(page.records).toEqual([
      expect.objectContaining({ sourceRecordId: "example/skills:fixture-safe", artifact: null }),
    ]);
  });

  it("rejects private repositories and truncated recursive trees", async () => {
    const privateFetch = vi.fn<typeof fetch>().mockResolvedValue(json(repo(true)));
    await expect(
      firstPage(
        new GitHubPublicRepositoryAdapter({
          repositoryUrl: "https://github.com/example/skills",
          fetch: privateFetch,
        }),
      ),
    ).rejects.toThrow(/Private or internal/);

    const truncatedFetch = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/repos/example/skills") return json(repo());
      if (url.pathname.includes("/commits/")) return json({ sha: COMMIT });
      return json(tree(true));
    });
    await expect(
      firstPage(
        new GitHubPublicRepositoryAdapter({
          repositoryUrl: "https://github.com/example/skills",
          fetch: truncatedFetch,
        }),
      ),
    ).rejects.toThrow(/truncated/);
  });
});
