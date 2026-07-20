// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  GITHUB_CODE_SEARCH_MAX_QUERY_LENGTH,
  composeGitHubCodeSearchQuery,
} from "./github-code-search-contract";
import {
  GitHubCodeSearchAuthenticationError,
  GitHubCodeSearchClient,
} from "./github-code-search-client";
import { RegistryBodyTooLargeError, RegistryContractError } from "./http-transport";

const COMMIT_SHA = "1".repeat(40);
const ROOT_TREE_SHA = "2".repeat(40);
const SKILL_TREE_SHA = "3".repeat(40);
const BLOB_SHA = "4".repeat(40);
const OTHER_BLOB_SHA = "5".repeat(40);

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

function searchItem(overrides: Record<string, unknown> = {}) {
  return {
    name: "SKILL.md",
    path: "fixture-skill/SKILL.md",
    sha: BLOB_SHA,
    url: `https://api.github.com/repositories/7/contents/fixture-skill/SKILL.md?ref=${COMMIT_SHA}`,
    git_url: `https://api.github.com/repositories/7/git/blobs/${BLOB_SHA}`,
    html_url: `https://github.com/fixture-owner/fixture-repo/blob/${COMMIT_SHA}/fixture-skill/SKILL.md`,
    repository: {
      id: 7,
      name: "fixture-repo",
      full_name: "fixture-owner/fixture-repo",
      private: false,
      visibility: "public",
      owner: { login: "fixture-owner", ignoredProfile: "not persisted" },
      html_url: "https://github.com/fixture-owner/fixture-repo",
      url: "https://api.github.com/repos/fixture-owner/fixture-repo",
      archived: false,
      disabled: false,
      providerScore: 99,
    },
    text_matches: [{ fragment: "upstream instruction text must not be returned" }],
    score: 999,
    ...overrides,
  };
}

function searchEnvelope(
  items: unknown[] = [searchItem()],
  overrides: Record<string, unknown> = {},
) {
  return {
    total_count: items.length,
    incomplete_results: false,
    items,
    ...overrides,
  };
}

function client(
  fetchImplementation: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof GitHubCodeSearchClient>[0]> = {},
): GitHubCodeSearchClient {
  return new GitHubCodeSearchClient({
    baseUrl: "https://api.example.test/",
    fetch: fetchImplementation,
    tokenProvider: async () => "fixture-server-token",
    maxAttempts: 1,
    ...overrides,
  });
}

describe("GitHub Code Search query contract", () => {
  it("composes only Aisle-owned filename and public qualifiers", () => {
    const composed = composeGitHubCodeSearchQuery("  React   animation  ", 2, 25);
    const url = new URL(composed.requestPath, "https://api.example.test/");

    expect(composed).toMatchObject({
      userQuery: "React animation",
      githubQuery: "React animation filename:SKILL.md is:public",
      page: 2,
      perPage: 25,
    });
    expect(url.searchParams.get("q")).toBe("React animation filename:SKILL.md is:public");
  });

  it("requires at least two Unicode letters or numbers", () => {
    expect(() => composeGitHubCodeSearchQuery("a")).toThrow(/at least two/);
    expect(() => composeGitHubCodeSearchQuery("🧪")).toThrow(/at least two/);
    expect(() => composeGitHubCodeSearchQuery("人工")).not.toThrow();
    expect(() => composeGitHubCodeSearchQuery("3d")).not.toThrow();
  });

  it.each([
    ["", /non-empty/],
    ["react*", /raw qualifiers/],
    ["repo:private skill", /raw qualifiers/],
    ["react OR private", /raw qualifiers/],
    ["-private react", /raw qualifiers/],
    ["react\u0000skill", /control/],
    ["x".repeat(GITHUB_CODE_SEARCH_MAX_QUERY_LENGTH + 1), /cannot exceed/],
  ])("rejects unsafe query %j", (query, message) => {
    expect(() => composeGitHubCodeSearchQuery(query)).toThrow(message);
  });

  it("enforces GitHub page and result-window caps before making a request", () => {
    expect(() => composeGitHubCodeSearchQuery("react", 1, 101)).toThrow(/page size/);
    expect(() => composeGitHubCodeSearchQuery("react", 11, 100)).toThrow(/1,000-result cap/);
    expect(() => composeGitHubCodeSearchQuery("react", 20, 50)).not.toThrow();
    expect(() => composeGitHubCodeSearchQuery("react", 21, 50)).toThrow(/1,000-result cap/);
  });
});

describe("GitHubCodeSearchClient", () => {
  it("authenticates server-side, normalizes public identity, and reports explicit partial coverage", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(searchEnvelope([searchItem()], { total_count: 1_500, incomplete_results: true })),
    );
    const search = client(fetchMock);

    const page = await search.search("react animation", 1, 1);

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer fixture-server-token");
    expect(headers.get("user-agent")).toBe("Aisle catalog sync");
    expect(headers.get("x-github-api-version")).toBe("2026-03-10");
    expect(page).toMatchObject({
      query: {
        user: "react animation",
        composed: "react animation filename:SKILL.md is:public",
      },
      pagination: { page: 1, perPage: 1, nextPage: 2, reachableTotal: 1_000 },
      coverage: {
        mode: "query_only",
        partial: true,
        sourceComplete: false,
        resultCap: 1_000,
        reportedTotal: 1_500,
        resultSetCapped: true,
        providerIncompleteResults: true,
        reasons: [
          "query_scoped",
          "github_1000_result_cap",
          "github_incomplete_results",
          "page_subset",
        ],
      },
      results: [
        {
          repositoryIdObservation: 7,
          identity: {
            canonicalKey: "github:fixture-owner/fixture-repo/fixture-skill/SKILL.md",
          },
          blobShaObservation: BLOB_SHA,
          blobShaKind: "git_blob",
          commitRefObservation: COMMIT_SHA,
          immutableRevision: null,
          repositoryPublicEvidence: {
            queryQualifierApplied: true,
            private: false,
            visibility: "public",
          },
        },
      ],
    });
    expect(page.results[0]).not.toHaveProperty("score");
    expect(page.results[0]).not.toHaveProperty("text_matches");
  });

  it("requires credentials without retrying a missing token", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const search = new GitHubCodeSearchClient({
      baseUrl: "https://api.example.test/",
      fetch: fetchMock,
      tokenProvider: async () => undefined,
      maxAttempts: 4,
    });

    await expect(search.search("react")).rejects.toBeInstanceOf(
      GitHubCodeSearchAuthenticationError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries GitHub rate-limit responses using reset metadata", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({}, 403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "12",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(searchEnvelope()));
    const search = client(fetchMock, {
      maxAttempts: 2,
      sleep,
      now: () => 10_000,
    });

    await search.search("react", 1, 1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("rejects search results without current public evidence", async () => {
    const item = searchItem({
      repository: { ...searchItem().repository, private: true, visibility: "private" },
    });
    const search = client(
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(searchEnvelope([item]))),
    );

    await expect(search.search("react", 1, 1)).rejects.toBeInstanceOf(RegistryContractError);
  });

  it.each([
    {
      label: "content URL with injected path segments",
      override: {
        url: `https://api.github.com/repositories/7/injected/contents/fixture-skill/SKILL.md?ref=${COMMIT_SHA}`,
      },
    },
    {
      label: "blob URL belonging to another numeric repository",
      override: {
        git_url: `https://api.github.com/repositories/999/git/blobs/${BLOB_SHA}`,
      },
    },
    {
      label: "blob URL with injected owner/repository path",
      override: {
        git_url: `https://api.github.com/repos/attacker/other/git/blobs/${BLOB_SHA}`,
      },
    },
  ])("rejects an adversarial $label", async ({ override }) => {
    const search = client(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse(searchEnvelope([searchItem(override)]))),
    );

    await expect(search.search("react", 1, 1)).rejects.toBeInstanceOf(RegistryContractError);
  });

  it("keeps a branch ref as an observation and refuses exact resolution", async () => {
    const branchItem = searchItem({
      url: "https://api.github.com/repositories/7/contents/fixture-skill/SKILL.md?ref=main",
      html_url:
        "https://github.com/fixture-owner/fixture-repo/blob/main/fixture-skill/SKILL.md",
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(searchEnvelope([branchItem])));
    const search = client(fetchMock);

    const page = await search.search("react", 1, 1);
    const result = page.results[0];

    expect(result?.commitRefObservation).toBeNull();
    expect(result?.blobShaObservation).toBe(BLOB_SHA);
    await expect(search.resolveExactCommit(result!)).resolves.toEqual({
      resolved: false,
      reason: "missing_commit_ref",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("binds a blob to an exact commit only after a bounded non-recursive tree walk", async () => {
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      requestedUrls.push(url.toString());
      if (url.pathname === "/search/code") {
        return jsonResponse(searchEnvelope());
      }
      if (url.pathname === "/repos/fixture-owner/fixture-repo") {
        return jsonResponse({
          id: 7,
          name: "fixture-repo",
          full_name: "fixture-owner/fixture-repo",
          private: false,
          visibility: "public",
          html_url: "https://github.com/fixture-owner/fixture-repo",
          owner: { login: "fixture-owner" },
        });
      }
      if (url.pathname === `/repos/fixture-owner/fixture-repo/git/commits/${COMMIT_SHA}`) {
        return jsonResponse({ sha: COMMIT_SHA, tree: { sha: ROOT_TREE_SHA } });
      }
      if (url.pathname === `/repos/fixture-owner/fixture-repo/git/trees/${ROOT_TREE_SHA}`) {
        return jsonResponse({
          sha: ROOT_TREE_SHA,
          truncated: false,
          tree: [{ path: "fixture-skill", mode: "040000", type: "tree", sha: SKILL_TREE_SHA }],
        });
      }
      if (url.pathname === `/repos/fixture-owner/fixture-repo/git/trees/${SKILL_TREE_SHA}`) {
        return jsonResponse({
          sha: SKILL_TREE_SHA,
          truncated: false,
          tree: [{ path: "SKILL.md", mode: "100644", type: "blob", sha: BLOB_SHA, size: 100 }],
        });
      }
      return jsonResponse({}, 404);
    });
    const search = client(fetchMock);
    const page = await search.search("react", 1, 1);

    const resolution = await search.resolveExactCommit(page.results[0]!);

    expect(resolution).toEqual({
      resolved: true,
      commitSha: COMMIT_SHA,
      rootTreeSha: ROOT_TREE_SHA,
      blobSha: BLOB_SHA,
      immutableRevision: COMMIT_SHA,
      binding: "verified_non_recursive_tree_walk",
      repositoryPublicEvidence: { private: false, visibility: "public" },
    });
    expect(requestedUrls).toHaveLength(5);
    expect(requestedUrls.every((url) => !url.includes("/git/blobs/"))).toBe(true);
    expect(requestedUrls.every((url) => !url.includes("/contents/"))).toBe(true);
  });

  it("does not bind a commit when the final tree blob differs from search", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/search/code") return jsonResponse(searchEnvelope());
      if (path === "/repos/fixture-owner/fixture-repo") {
        return jsonResponse({
          id: 7,
          name: "fixture-repo",
          full_name: "fixture-owner/fixture-repo",
          private: false,
          visibility: "public",
          html_url: "https://github.com/fixture-owner/fixture-repo",
          owner: { login: "fixture-owner" },
        });
      }
      if (path.includes("/git/commits/")) {
        return jsonResponse({ sha: COMMIT_SHA, tree: { sha: ROOT_TREE_SHA } });
      }
      if (path.endsWith(ROOT_TREE_SHA)) {
        return jsonResponse({
          sha: ROOT_TREE_SHA,
          truncated: false,
          tree: [{ path: "fixture-skill", mode: "040000", type: "tree", sha: SKILL_TREE_SHA }],
        });
      }
      return jsonResponse({
        sha: SKILL_TREE_SHA,
        truncated: false,
        tree: [{ path: "SKILL.md", mode: "100644", type: "blob", sha: OTHER_BLOB_SHA }],
      });
    });
    const search = client(fetchMock);
    const page = await search.search("react", 1, 1);

    await expect(search.resolveExactCommit(page.results[0]!)).resolves.toEqual({
      resolved: false,
      reason: "blob_mismatch",
    });
  });

  it("streams within the configured response cap and cancels oversized search JSON", async () => {
    const cancel = vi.fn(async () => undefined);
    const search = client(
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(new ReadableStream<Uint8Array>({ cancel }), {
          headers: { "content-length": "129" },
        }),
      ),
      { maxResponseBytes: 128 },
    );

    await expect(search.search("react", 1, 1)).rejects.toBeInstanceOf(
      RegistryBodyTooLargeError,
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
});
