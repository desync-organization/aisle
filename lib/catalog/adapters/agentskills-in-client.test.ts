// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { AgentSkillsInClient } from "./agentskills-in-client";
import { RegistryContractError } from "./http-transport";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function skill(overrides: Record<string, unknown> = {}) {
  return {
    id: "fixture-owner-fixture-repo-sample-skill",
    name: "sample-skill",
    description: "An inert registry fixture.",
    author: "fixture-owner",
    stars: 12,
    forks: 3,
    githubUrl: "https://github.com/fixture-owner/fixture-repo/tree/main/skills/sample-skill",
    scopedName: "@fixture-owner/sample-skill",
    repoFullName: "fixture-owner/fixture-repo",
    path: "skills/sample-skill/SKILL.md",
    category: "testing",
    hasContent: true,
    ignoredRawContent: "this must never enter the persistable model",
    ...overrides,
  };
}

describe("AgentSkillsInClient", () => {
  it("enumerates with deterministic offset progression and exposes the mutable snapshot boundary", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        skills: [skill(), skill({ id: "second", name: "other", scopedName: "@fixture-owner/other", path: "skills/other/SKILL.md" })],
        total: 3,
        limit: 2,
        offset: 0,
        ignoredEnvelopeBody: "not persisted",
      }),
    );
    const client = new AgentSkillsInClient({
      baseUrl: "https://registry.example.test/api/",
      fetch: fetchMock,
      maxAttempts: 1,
    });

    const page = await client.listSkills(0, 2);

    expect(page.pagination).toEqual({
      offset: 0,
      limit: 2,
      reportedTotal: 3,
      nextOffset: 2,
      hasMore: true,
      stalledBeforeReportedEnd: false,
    });
    expect(page.snapshot).toEqual({
      immutable: false,
      complete: false,
      reason: "mutable_offset_listing_requires_stable_sweeps",
    });
    expect(page.skills[0]).toMatchObject({
      immutableRef: null,
      branchHint: "main",
      identity: {
        repositoryFullName: "fixture-owner/fixture-repo",
        skillFilePath: "skills/sample-skill/SKILL.md",
      },
    });
    expect(page.skills[0]).not.toHaveProperty("ignoredRawContent");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("search=&offset=0&limit=2");
  });

  it("bounds requested pages and rejects mismatched pagination metadata", async () => {
    const client = new AgentSkillsInClient({
      baseUrl: "https://registry.example.test/api/",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        response({ skills: [], total: 0, limit: 1, offset: 1 }),
      ),
      maxAttempts: 1,
    });

    await expect(client.listSkills(-1, 1)).rejects.toThrow(/offset/);
    await expect(client.listSkills(0, 101)).rejects.toThrow(/limit/);
    await expect(client.listSkills(0, 1)).rejects.toBeInstanceOf(RegistryContractError);
  });

  it("fails closed when upstream GitHub identity or URLs conflict", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        skills: [skill({ githubUrl: "https://example.test/not-github" })],
        total: 1,
        limit: 1,
        offset: 0,
      }),
    );
    const client = new AgentSkillsInClient({
      baseUrl: "https://registry.example.test/api/",
      fetch: fetchMock,
      maxAttempts: 1,
    });

    await expect(client.listSkills(0, 1)).rejects.toBeInstanceOf(RegistryContractError);
  });

  it("marks a zero-item page before the reported end as stalled rather than complete", async () => {
    const client = new AgentSkillsInClient({
      baseUrl: "https://registry.example.test/api/",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        response({ skills: [], total: 5, limit: 2, offset: 0 }),
      ),
      maxAttempts: 1,
    });

    const page = await client.listSkills(0, 2);

    expect(page.pagination).toMatchObject({
      nextOffset: null,
      hasMore: false,
      stalledBeforeReportedEnd: true,
    });
    expect(page.snapshot.complete).toBe(false);
  });
});
