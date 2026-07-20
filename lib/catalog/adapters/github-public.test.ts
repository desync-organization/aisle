// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { GitHubPublicRepositoryAdapter } from "./github-public";

const COMMIT = "a".repeat(40);
const SKILL = `---
name: fixture-safe
description: Inert GitHub adapter fixture.
license: MIT
---

# Fixture
`;

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
        sha: "blob-sha",
        size: Buffer.byteLength(SKILL),
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
    if (url.pathname.includes("/contents/")) return new Response(SKILL);
    return new Response(null, { status: 404 });
  });
}

async function firstPage(adapter: GitHubPublicRepositoryAdapter) {
  for await (const page of adapter.enumerate({ cursor: null })) return page;
  throw new Error("adapter did not yield");
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
        installSpec: {
          kind: "source",
          sourceUrl: "https://github.com/example/skills",
          immutableRef: COMMIT,
          skillPath: "fixture-safe",
        },
        artifact: expect.objectContaining({ complete: true, contents: SKILL }),
      }),
    ]);
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
