// @vitest-environment node

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { WellKnownSkillsAdapter, wellKnownDiscoverySchemaUri } from "./well-known";

const ORIGIN = "https://skills.example";
const SAFE_SKILL = `---
name: fixture-safe
description: Inert well-known adapter fixture.
license: MIT
---

# Fixture
`;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function pages(adapter: WellKnownSkillsAdapter) {
  const output = [];
  for await (const page of adapter.enumerate({ cursor: null })) output.push(page);
  return output;
}

const publicResolver = async () => [{ address: "203.0.113.10", family: 4 }];

describe("WellKnownSkillsAdapter", () => {
  it("decodes the v0.1 shape separately and resolves legacy files under the skill directory", async () => {
    const requested: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      requested.push(url.pathname);
      if (url.pathname === "/.well-known/agent-skills/index.json") return json({}, 404);
      if (url.pathname === "/.well-known/skills/index.json") {
        return json({
          skills: [
            {
              name: "fixture-safe",
              description: "Inert legacy fixture.",
              files: ["SKILL.md"],
            },
          ],
        });
      }
      if (url.pathname === "/.well-known/skills/fixture-safe/SKILL.md") {
        return new Response(SAFE_SKILL, {
          headers: { "content-type": "text/markdown" },
        });
      }
      return new Response(null, { status: 404 });
    });
    const [page] = await pages(
      new WellKnownSkillsAdapter({
        origin: ORIGIN,
        adminApprovedOrigins: [ORIGIN],
        fetch: fetchMock,
        resolveHostname: publicResolver,
      }),
    );

    expect(requested).toContain("/.well-known/skills/fixture-safe/SKILL.md");
    expect(page?.records).toEqual([
      expect.objectContaining({
        sourceRecordId: "fixture-safe",
        immutableRef: `sha256:${createHash("sha256").update(SAFE_SKILL).digest("hex")}`,
        artifact: expect.objectContaining({ complete: true, contents: SAFE_SKILL }),
      }),
    ]);
    expect(page?.completeSnapshot).toBe(true);
  });

  it("rejects private DNS, loopback IPv6, and origins outside the admin allowlist", async () => {
    expect(
      () =>
        new WellKnownSkillsAdapter({
          origin: ORIGIN,
          adminApprovedOrigins: ["https://other.example"],
        }),
    ).toThrow(/administrator allowlist/);
    expect(
      () =>
        new WellKnownSkillsAdapter({
          origin: "https://[::1]",
          adminApprovedOrigins: ["https://[::1]"],
        }),
    ).toThrow(/private-network/);

    const adapter = new WellKnownSkillsAdapter({
      origin: ORIGIN,
      adminApprovedOrigins: [ORIGIN],
      fetch: vi.fn<typeof fetch>(),
      resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    await expect(pages(adapter)).rejects.toThrow(/non-public address/);
  });

  it("streams index limits and cancels an oversized response", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
        controller.enqueue(new Uint8Array(10));
      },
      cancel() {
        cancelled = true;
      },
    });
    const adapter = new WellKnownSkillsAdapter({
      origin: ORIGIN,
      adminApprovedOrigins: [ORIGIN],
      maxIndexBytes: 12,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(stream, { headers: { "content-type": "application/json" } }),
      ),
      resolveHostname: publicResolver,
    });

    await expect(pages(adapter)).rejects.toThrow(/12-byte limit/);
    expect(cancelled).toBe(true);
  });

  it("fails artifact redirects closed and emits a seen unresolved record with degraded coverage", async () => {
    const digest = createHash("sha256").update(SAFE_SKILL).digest("hex");
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("index.json")) {
        return json({
          $schema: wellKnownDiscoverySchemaUri,
          skills: [
            {
              name: "fixture-safe",
              type: "skill-md",
              description: "Redirect fixture.",
              url: "/fixture-safe/SKILL.md",
              digest: `sha256:${digest}`,
            },
          ],
        });
      }
      return new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/private" },
      });
    });
    const [page] = await pages(
      new WellKnownSkillsAdapter({
        origin: ORIGIN,
        adminApprovedOrigins: [ORIGIN],
        fetch: fetchMock,
        resolveHostname: publicResolver,
      }),
    );

    expect(page).toMatchObject({ degraded: true, completeSnapshot: false });
    expect(page?.records).toEqual([
      expect.objectContaining({ sourceRecordId: "fixture-safe", artifact: null }),
    ]);
  });
});
