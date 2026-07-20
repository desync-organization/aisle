// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  SkillsShAuthenticationError,
  SkillsShClient,
  parseRetryAfter,
} from "./skills-sh-client";

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

const emptyPage = {
  data: [],
  pagination: { page: 0, perPage: 1, total: 0, hasMore: false },
};

describe("SkillsShClient", () => {
  it("honors Retry-After before retrying a rate-limited request", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ error: "rate_limited", message: "Slow down" }, 429, { "retry-after": "2" }))
      .mockResolvedValueOnce(response(emptyPage));
    const client = new SkillsShClient({
      fetch: fetchMock,
      tokenProvider: async () => "fixture-oidc-token",
      sleep,
      random: () => 0,
      maxAttempts: 2,
    });

    const result = await client.listSkills(0, 1);

    expect(result.notModified).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
    const requestHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(requestHeaders.get("authorization")).toBe("Bearer fixture-oidc-token");
  });

  it("does not retry authentication failures", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ error: "unauthorized", message: "Expired token" }, 401));
    const client = new SkillsShClient({
      fetch: fetchMock,
      tokenProvider: async () => "expired-fixture-token",
      maxAttempts: 4,
    });

    await expect(client.listSkills(0)).rejects.toBeInstanceOf(SkillsShAuthenticationError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a missing audit resource as no upstream observation", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ error: "not_found", message: "No audits" }, 404));
    const client = new SkillsShClient({
      fetch: fetchMock,
      tokenProvider: async () => "fixture-request-token",
      maxAttempts: 1,
    });

    const audit = await client.audit("fixture-org/fixture-repo/fixture-skill");

    expect(audit).toMatchObject({
      notModified: false,
      data: {
        id: "fixture-org/fixture-repo/fixture-skill",
        audits: [],
      },
    });
  });

  it("parses delta-seconds and HTTP-date Retry-After values", () => {
    expect(parseRetryAfter("1.5", 0)).toBe(1_500);
    expect(parseRetryAfter("Thu, 01 Jan 1970 00:00:05 GMT", 1_000)).toBe(4_000);
    expect(parseRetryAfter("invalid", 0)).toBeNull();
  });
});
