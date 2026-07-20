// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  SkillMdClient,
  SkillMdPayloadTooLargeError,
  SkillMdSlugError,
  SkillMdTimeoutError,
  parseSkillMdRetryAfter,
} from "./skillmd-client";

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

function listItem(slug: string) {
  const [, name = slug] = slug.split("/");
  return {
    slug,
    type: "skill",
    title: name,
    description: `Inert fixture for ${name}`,
    verified: false,
    agents: "fixture-agent",
    category: "testing",
    avg_rating: null,
    rating_count: 0,
    raw_url: `https://registry.example/api/skills/${slug}/raw`,
  };
}

function listPage(slugs: string[], limit: number, offset: number) {
  return {
    items: slugs.map(listItem),
    limit,
    offset,
  };
}

describe("SkillMdClient", () => {
  it("advances a full offset page and stops on a short page", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          listPage(["fixture-owner/fixture-one", "fixture-owner/fixture-two"], 2, 0),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(listPage(["fixture-owner/fixture-three"], 2, 2)),
      );
    const client = new SkillMdClient({
      baseUrl: "https://registry.example",
      fetch: fetchMock,
      maxAttempts: 1,
    });

    const firstPage = await client.listSkills({ limit: 2, offset: 0 });
    const secondPage = await client.listSkills({
      limit: 2,
      offset: firstPage.nextOffset ?? -1,
    });

    expect(firstPage.nextOffset).toBe(2);
    expect(secondPage.nextOffset).toBeNull();
    expect(secondPage.items).toHaveLength(1);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://registry.example/v1/skills?limit=2&offset=0",
      "https://registry.example/v1/skills?limit=2&offset=2",
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });
  });

  it("uses exponential jitter backoff when Retry-After is missing", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "gateway unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse(listPage([], 100, 0)));
    const client = new SkillMdClient({
      baseUrl: "https://registry.example",
      fetch: fetchMock,
      sleep,
      random: () => 0,
      backoffBaseMs: 125,
      maxAttempts: 2,
    });

    await client.listSkills();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(125);
  });

  it("honors Retry-After on a 429 response", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ message: "Slow down" }, 429, { "retry-after": "1.5" }),
      )
      .mockResolvedValueOnce(jsonResponse(listPage([], 100, 0)));
    const client = new SkillMdClient({
      baseUrl: "https://registry.example",
      fetch: fetchMock,
      sleep,
      random: () => 0,
      maxAttempts: 2,
    });

    await client.listSkills();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1_500);
  });

  it("retries a transient 500 but does not retry a permanent 4xx", async () => {
    const sleep = vi.fn(async () => undefined);
    const transientFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ message: "Temporary failure" }, 500))
      .mockResolvedValueOnce(jsonResponse(listPage([], 100, 0)));
    const transientClient = new SkillMdClient({
      baseUrl: "https://registry.example",
      fetch: transientFetch,
      sleep,
      random: () => 0,
      maxAttempts: 2,
    });

    await transientClient.listSkills();

    const permanentFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ message: "Invalid request" }, 422));
    const permanentClient = new SkillMdClient({
      baseUrl: "https://registry.example",
      fetch: permanentFetch,
      sleep,
      random: () => 0,
      maxAttempts: 3,
    });

    await expect(permanentClient.listSkills()).rejects.toMatchObject({ status: 422 });
    expect(transientFetch).toHaveBeenCalledTimes(2);
    expect(permanentFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a list response that changes the requested page size", async () => {
    const client = new SkillMdClient({
      baseUrl: "https://registry.example",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(listPage([], 50, 0))),
      maxAttempts: 1,
    });

    await expect(client.listSkills({ limit: 100, offset: 0 })).rejects.toThrow(
      /returned limit 50 while limit 100 was requested/,
    );
  });

  it("fails redirects closed without fetching the Location target", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.invalid/redirected" },
      }),
    );
    const client = new SkillMdClient({
      baseUrl: "https://registry.example",
      fetch: fetchMock,
      maxAttempts: 3,
    });

    await expect(client.listSkills()).rejects.toMatchObject({ status: 302 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://registry.example/v1/skills?limit=100&offset=0",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("cancels an oversized raw stream without retaining the full body", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.enqueue(new Uint8Array([5, 6, 7, 8]));
      },
      cancel,
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    const client = new SkillMdClient({
      baseUrl: "https://registry.example",
      fetch: fetchMock,
      maxAttempts: 1,
      maxRawBytes: 6,
    });

    await expect(client.rawSkillMd("fixture-owner/fixture-name")).rejects.toBeInstanceOf(
      SkillMdPayloadTooLargeError,
    );

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed or ambiguous slugs before making a request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new SkillMdClient({
      baseUrl: "https://registry.example",
      fetch: fetchMock,
    });

    await expect(client.detail("../fixture-name")).rejects.toBeInstanceOf(SkillMdSlugError);
    await expect(client.detail("fixture-owner/fixture/name")).rejects.toBeInstanceOf(
      SkillMdSlugError,
    );
    await expect(client.rawSkillMd("fixture-owner/%2Fescape")).rejects.toBeInstanceOf(
      SkillMdSlugError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns only persistable metadata and strips large markdown bodies", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        slug: "fixture-owner/fixture-name",
        title: "Fixture name",
        description: "An inert metadata fixture.",
        type: "skill",
        verified: true,
        avg_rating: 4.5,
        rating_count: 2,
        install_count: 12,
        license: "MIT",
        source_repo: "https://example.invalid/fixture-owner/fixture-repository",
        commit_sha: "0123456789abcdef0123456789abcdef01234567",
        last_synced_at: "2026-07-20 12:00:00",
        category: "testing",
        install_snippet: "fixture install command",
        raw_url: "https://registry.example/api/skills/fixture-owner/fixture-name/raw",
        bundle_url: "https://registry.example/api/skills/fixture-owner/fixture-name/bundle",
        files: [
          {
            path: "references/fixture.txt",
            size_bytes: 42,
            is_script: 0,
            storage: "db",
            provider_only_field: "ignored",
          },
        ],
        body_md: "x".repeat(50_000),
        raw_md: "y".repeat(50_000),
        future_large_field: "z".repeat(50_000),
      }),
    );
    const client = new SkillMdClient({
      baseUrl: "https://registry.example",
      fetch: fetchMock,
      maxAttempts: 1,
    });

    const metadata = await client.detail("fixture-owner/fixture-name");

    expect(metadata).toMatchObject({
      verified: true,
      verified_scope: "provider-badge-only",
      commit_sha: "0123456789abcdef0123456789abcdef01234567",
      license: "MIT",
      source_repo: "https://example.invalid/fixture-owner/fixture-repository",
      install_snippet: "fixture install command",
      inventory: [
        {
          path: "references/fixture.txt",
          size_bytes: 42,
          is_script: 0,
          storage: "db",
        },
      ],
    });
    expect(metadata).not.toHaveProperty("body_md");
    expect(metadata).not.toHaveProperty("raw_md");
    expect(metadata).not.toHaveProperty("future_large_field");
    expect(JSON.stringify(metadata)).not.toContain("x".repeat(1_000));
  });

  it("aborts a request at the configured timeout", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const client = new SkillMdClient({
      baseUrl: "https://registry.example",
      fetch: fetchMock,
      maxAttempts: 1,
      requestTimeoutMs: 5,
    });

    await expect(client.listSkills()).rejects.toBeInstanceOf(SkillMdTimeoutError);
  });

  it("parses delta-seconds and HTTP-date Retry-After values", () => {
    expect(parseSkillMdRetryAfter("0.25", 0)).toBe(250);
    expect(
      parseSkillMdRetryAfter("Thu, 01 Jan 1970 00:00:05 GMT", 1_000),
    ).toBe(4_000);
    expect(parseSkillMdRetryAfter("invalid", 0)).toBeNull();
  });
});
