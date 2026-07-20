// @vitest-environment node

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { validateAgentSkillRecord } from "../security";
import type { DiscoveredSkillRecord } from "../source-contract";
import { ClawHubAdapter } from "./clawhub";

const SKILL = `---
name: fixture-safe
description: Inert ClawHub adapter fixture.
license: MIT
---

# Fixture
`;
const FILE_HASH = createHash("sha256").update(SKILL).digest("hex");
const FINGERPRINT = "f".repeat(64);

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

function item() {
  return {
    slug: "fixture-safe",
    displayName: "Fixture Safe",
    summary: "Inert fixture.",
    tags: {},
    stats: {},
    createdAt: 1,
    updatedAt: 2,
    latestVersion: { version: "1.0.0", createdAt: 2, changelog: "", license: "MIT" },
  };
}

function detail(owner: string) {
  return {
    skill: {
      slug: "fixture-safe",
      displayName: "Fixture Safe",
      summary: "Inert fixture.",
      url: `https://clawhub.ai/${owner}/skills/fixture-safe`,
      stats: {},
      createdAt: 1,
      updatedAt: 2,
    },
    latestVersion: { version: "1.0.0", createdAt: 2, changelog: "", license: "MIT" },
    metadata: null,
    owner: { handle: owner },
    moderation: null,
  };
}

function clawHubFetch(options: {
  verificationHash?: string;
  fileBody?: string;
  versionSkill?: { slug: string; displayName: string } | null;
  duplicateVersionPath?: boolean;
} = {}) {
  let listCalls = 0;
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/skills") {
      listCalls += 1;
      return listCalls === 1
        ? json({ items: [], nextCursor: "opaque-short-page" })
        : json({ items: [item()], nextCursor: null });
    }
    if (url.pathname === "/api/v1/skills/fixture-safe" && !url.searchParams.has("owner")) {
      return json(
        {
          code: "AMBIGUOUS_SKILL_SLUG",
          slug: "fixture-safe",
          matches: ["alpha", "beta"].map((owner) => ({
            ownerHandle: owner,
            slug: "fixture-safe",
            ref: `@${owner}/fixture-safe`,
            url: `https://clawhub.ai/${owner}/skills/fixture-safe`,
          })),
        },
        409,
      );
    }
    const owner = url.searchParams.get("owner") ?? "alpha";
    if (url.pathname === "/api/v1/skills/fixture-safe") return json(detail(owner));
    if (url.pathname.endsWith("/moderation")) return json({ moderation: null });
    if (url.pathname.endsWith("/scan")) {
      return json({ moderation: null, security: { status: "clean" } });
    }
    if (url.pathname.endsWith("/versions/1.0.0")) {
      const files = [
        {
          path: "SKILL.md",
          size: Buffer.byteLength(SKILL),
          sha256: FILE_HASH,
          contentType: "text/markdown",
        },
      ];
      if (options.duplicateVersionPath) {
        files.push({ ...files[0]!, path: "./SKILL.md" });
      }
      return json({
        skill:
          options.versionSkill === undefined
            ? { slug: "fixture-safe", displayName: "Fixture Safe" }
            : options.versionSkill,
        version: {
          version: "1.0.0",
          createdAt: 2,
          changelog: "",
          license: "MIT",
          files,
          security: { status: "clean" },
        },
      });
    }
    if (url.pathname.endsWith("/verify")) {
      return json({
        schema: "clawhub.skill.verify.v1",
        ok: true,
        decision: "pass",
        version: "1.0.0",
        publisherHandle: owner,
        artifact: {
          sourceFingerprint: FINGERPRINT,
          files: [
            {
              path: "SKILL.md",
              size: Buffer.byteLength(SKILL),
              sha256: options.verificationHash ?? FILE_HASH,
              contentType: "text/markdown",
            },
          ],
        },
        provenance: { source: "fixture" },
        security: { status: "clean" },
        signature: { status: "unsigned" },
      });
    }
    if (url.pathname.endsWith("/file")) return new Response(options.fileBody ?? SKILL);
    return new Response(null, { status: 404 });
  });
}

async function allPages(adapter: ClawHubAdapter) {
  const pages = [];
  for await (const page of adapter.enumerate({ cursor: null })) pages.push(page);
  return pages;
}

describe("ClawHubAdapter", () => {
  it("follows opaque cursors after short pages and expands ambiguous slugs by stable owner", async () => {
    const fetchMock = clawHubFetch();
    const pages = await allPages(new ClawHubAdapter({ fetch: fetchMock }));
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({ records: [], hasMore: true });
    expect(
      pages[1]?.records.map((record) => (record as DiscoveredSkillRecord).sourceRecordId),
    ).toEqual([
      "@alpha/fixture-safe",
      "@beta/fixture-safe",
    ]);
    expect(
      fetchMock.mock.calls
        .map(([input]) => new URL(String(input)))
        .filter((url) => url.pathname === "/api/v1/skills")[0]?.searchParams.has(
          "nonSuspiciousOnly",
        ),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(
        ([input]) => new URL(String(input)).searchParams.get("owner") === "alpha",
      ),
    ).toBe(true);
    expect(
      pages[1]?.records.every(
        (record) =>
          validateAgentSkillRecord(record as DiscoveredSkillRecord).trustAssessment?.state ===
          "pass",
      ),
    ).toBe(true);
    const first = pages[1]?.records[0] as DiscoveredSkillRecord;
    expect(first.contentHash).not.toBe(FINGERPRINT);
    expect(first.raw).toMatchObject({ sourceFingerprint: FINGERPRINT });
    expect(pages[1]?.records.map((record) => (record as DiscoveredSkillRecord).aliases)).toEqual([
      ["@alpha/fixture-safe"],
      ["@beta/fixture-safe"],
    ]);
  });

  it("keeps exact-inventory mismatch and aggregate-byte overflow nonselectable", async () => {
    const mismatchPages = await allPages(
      new ClawHubAdapter({ fetch: clawHubFetch({ verificationHash: "0".repeat(64) }) }),
    );
    expect(
      mismatchPages[1]?.records.every(
        (record) => (record as DiscoveredSkillRecord).artifact?.complete === false,
      ),
    ).toBe(true);

    const oversizedPages = await allPages(
      new ClawHubAdapter({
        fetch: clawHubFetch({ fileBody: `${SKILL}extra bytes` }),
        maxTextFileBytes: 1_000,
        maxTextTotalBytes: Buffer.byteLength(SKILL),
      }),
    );
    expect(
      oversizedPages[1]?.records.every(
        (record) => !(record as DiscoveredSkillRecord).artifact?.complete,
      ),
    ).toBe(true);
  });

  it("parses absent retry headers as fallback delay and cancels the discarded body", async () => {
    let cancelled = false;
    let first = true;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      if (first) {
        first = false;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("limited"));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 429 },
        );
      }
      return json({ items: [], nextCursor: null });
    });
    const sleep = vi.fn(async () => undefined);
    await allPages(
      new ClawHubAdapter({ fetch: fetchMock, sleep, random: () => 0, maxAttempts: 2 }),
    );
    expect(sleep).toHaveBeenCalledWith(500);
    expect(cancelled).toBe(true);
  });

  it("degrades invalid ambiguity contracts without silently merging the slug", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/skills") return json({ items: [item()], nextCursor: null });
      return json({ code: "AMBIGUOUS_SKILL_SLUG", slug: "fixture-safe", matches: [] }, 409);
    });
    const [page] = await allPages(new ClawHubAdapter({ fetch: fetchMock }));
    expect(page).toMatchObject({ degraded: true, completeSnapshot: false, records: [] });
  });

  it("degrades null exact-version identities and duplicate normalized inventory paths", async () => {
    for (const fetchMock of [
      clawHubFetch({ versionSkill: null }),
      clawHubFetch({ duplicateVersionPath: true }),
    ]) {
      const pages = await allPages(new ClawHubAdapter({ fetch: fetchMock }));
      expect(pages[1]).toMatchObject({
        degraded: true,
        completeSnapshot: false,
        records: [],
      });
    }
  });

  it("stops repeated cursors instead of enumerating forever", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      json({ items: [], nextCursor: "loop" }),
    );
    const pages = await allPages(new ClawHubAdapter({ fetch: fetchMock }));
    expect(pages).toHaveLength(2);
    expect(pages[1]).toMatchObject({ degraded: true, hasMore: false, nextCursor: null });
    expect(pages[1]?.exclusions).toEqual([
      expect.stringContaining("repeated cursor"),
    ]);
  });
});
