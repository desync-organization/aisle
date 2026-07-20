// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { ASKSKILL_MAX_RAW_BYTES, AskSkillClient } from "./askskill-client";
import { RegistryBodyTooLargeError, RegistryContractError } from "./http-transport";

function response(body: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

function skill(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    installRef: "gh:fixture-owner/fixture-repo/skills/sample-skill",
    name: "sample-skill",
    skillName: "sample-skill",
    description: "An inert AskSkill fixture.",
    tags: ["testing"],
    stars: 9,
    favoriteCount: 2,
    aiScore: 88,
    llmScore: 87,
    aiBreakdown: { safety: 99, clarity: 76 },
    owner: "fixture-owner",
    repoOwner: "fixture-owner",
    repo: "fixture-repo",
    repoName: "fixture-repo",
    path: "skills/sample-skill",
    filePath: "skills/sample-skill/SKILL.md",
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: "fixture-indexer",
    verified: true,
    badges: { reviewed: true, hidden: false },
    rawContent: "upstream instructions are intentionally not returned",
    llmScoreMeta: { verbose: "also not returned" },
    ...overrides,
  };
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    data: [skill()],
    pagination: {
      page: 1,
      limit: 1,
      total: 260_000,
      totalPages: 1_201,
      totalIsEstimate: true,
      hasMore: true,
      pageWindowLimited: true,
    },
    ...overrides,
  };
}

describe("AskSkillClient", () => {
  it("preserves estimated window pagination without claiming source completeness", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(envelope()));
    const client = new AskSkillClient({
      baseUrl: "https://registry.example.test/api/v1/",
      fetch: fetchMock,
      maxAttempts: 1,
    });

    const page = await client.listSkills(1, 1);

    expect(page.pagination).toEqual({
      page: 1,
      limit: 1,
      reportedTotal: 260_000,
      reportedTotalPages: 1_201,
      totalIsEstimate: true,
      hasMore: true,
      pageWindowLimited: true,
      nextPage: 2,
      reachableWindowExhausted: false,
    });
    expect(page.snapshot).toEqual({
      immutable: false,
      complete: false,
      reason: "provider_page_window",
    });
    expect(page.skills[0]).toMatchObject({
      providerRecordId: "42",
      immutableRef: null,
      installRefObservation: "gh:fixture-owner/fixture-repo/skills/sample-skill",
      identity: {
        canonicalKey: "github:fixture-owner/fixture-repo/skills/sample-skill/SKILL.md",
      },
      providerObservations: {
        aiScore: 88,
        verifiedBadge: true,
        badges: ["reviewed"],
      },
    });
    expect(page.skills[0]).not.toHaveProperty("rawContent");
    expect(page.skills[0]).not.toHaveProperty("llmScoreMeta");
  });

  it("caps page sizes and makes the provider page window terminal", async () => {
    const client = new AskSkillClient({
      baseUrl: "https://registry.example.test/api/v1/",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        response(
          envelope({
            data: [],
            pagination: {
              page: 1_201,
              limit: 1,
              total: 260_000,
              totalPages: 1_201,
              totalIsEstimate: true,
              hasMore: true,
              pageWindowLimited: true,
            },
          }),
        ),
      ),
      maxAttempts: 1,
    });

    await expect(client.listSkills(0, 1)).rejects.toThrow(/page/);
    await expect(client.listSkills(1, 101)).rejects.toThrow(/limit/);
    const terminal = await client.listSkills(1_201, 1);
    expect(terminal.pagination).toMatchObject({
      hasMore: true,
      nextPage: null,
      reachableWindowExhausted: true,
    });
    expect(terminal.snapshot.complete).toBe(false);
  });

  it("uses GitHub owner/repository/path as identity, never the numeric provider id", async () => {
    const client = new AskSkillClient({
      baseUrl: "https://registry.example.test/api/v1/",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response(skill({ id: 999_999 }))),
      maxAttempts: 1,
    });

    const detail = await client.detail("999999");

    expect(detail.providerRecordId).toBe("999999");
    expect(detail.identity.canonicalKey).toBe(
      "github:fixture-owner/fixture-repo/skills/sample-skill/SKILL.md",
    );
    expect(detail.identity.canonicalKey).not.toContain("999999");
  });

  it("rejects conflicting GitHub paths in provider metadata", async () => {
    const client = new AskSkillClient({
      baseUrl: "https://registry.example.test/api/v1/",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        response(skill({ filePath: "skills/a-different-skill/SKILL.md" })),
      ),
      maxAttempts: 1,
    });

    await expect(client.detail("42")).rejects.toBeInstanceOf(RegistryContractError);
  });

  it("streams raw instructions transiently and enforces a hard 200 KiB ceiling", async () => {
    const markdown = "# inert fixture\n";
    const success = new AskSkillClient({
      baseUrl: "https://registry.example.test/api/v1/",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(markdown, { headers: { "content-type": "text/markdown" } })),
      maxAttempts: 1,
    });

    await expect(success.rawForValidation("42")).resolves.toEqual({
      content: markdown,
      byteLength: new TextEncoder().encode(markdown).byteLength,
      contentType: "text/markdown",
      transient: true,
    });

    const oversizeCancel = vi.fn(async () => undefined);
    const oversized = new AskSkillClient({
      baseUrl: "https://registry.example.test/api/v1/",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(new ReadableStream<Uint8Array>({ cancel: oversizeCancel }), {
          headers: { "content-length": String(ASKSKILL_MAX_RAW_BYTES + 1) },
        }),
      ),
      maxAttempts: 1,
    });

    await expect(oversized.rawForValidation("42")).rejects.toBeInstanceOf(
      RegistryBodyTooLargeError,
    );
    expect(oversizeCancel).toHaveBeenCalledOnce();
  });
});
