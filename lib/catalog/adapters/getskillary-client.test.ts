// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  GETSKILLARY_MAX_SNAPSHOT_BYTES,
  GetSkillaryClient,
} from "./getskillary-client";
import { RegistryBodyTooLargeError, RegistryContractError } from "./http-transport";

const SHA_256 = "a".repeat(64);

function response(body: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

function skill(overrides: Record<string, unknown> = {}) {
  return {
    skill_id: "fixture-skill-id",
    slug: "fixture-skill",
    title: "Fixture Skill",
    summary: "An inert selected-package fixture.",
    category: "Developer Workflow",
    tags: ["testing", "fixture"],
    canonical_url: "https://getskillary.com/skills/fixture-skill/",
    download_url: "https://downloads.example.test/fixture-skill.zip",
    package: { size_bytes: 1_024, sha256: SHA_256, provider_curated: true },
    raw_source_directory: "must not be returned",
    ai_recommendation: { verbose: "must not be returned either" },
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    generated_at: "2026-07-13T12:15:55.102Z",
    record_count: 1,
    public_boundary: "Selected public package metadata only.",
    skills: [skill()],
    internal_review_fields: { hidden: true },
    ...overrides,
  };
}

describe("GetSkillaryClient", () => {
  it("returns a sanitized snapshot complete only within the declared selected boundary", async () => {
    const client = new GetSkillaryClient({
      baseUrl: "https://registry.example.test/",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response(snapshot())),
      maxAttempts: 1,
    });

    const result = await client.snapshot();

    expect(result).toMatchObject({
      generatedAt: "2026-07-13T12:15:55.102Z",
      recordCount: 1,
      publicBoundary: "Selected public package metadata only.",
      scope: {
        kind: "declared_selected_public_boundary",
        completeWithinDeclaredBoundary: true,
        sourceWideComplete: false,
      },
      skills: [
        {
          providerRecordId: "fixture-skill-id",
          slug: "fixture-skill",
          providerPackageObservation: {
            sizeBytes: 1_024,
            archiveSha256: SHA_256,
          },
          upstreamRepository: null,
          upstreamLicense: null,
        },
      ],
    });
    expect(result).not.toHaveProperty("internal_review_fields");
    expect(result.skills[0]).not.toHaveProperty("raw_source_directory");
    expect(result.skills[0]).not.toHaveProperty("ai_recommendation");
    expect(result.skills[0]?.providerPackageObservation).not.toHaveProperty("provider_curated");
  });

  it("rejects count mismatches and duplicate snapshot identities", async () => {
    const mismatch = new GetSkillaryClient({
      baseUrl: "https://registry.example.test/",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        response(snapshot({ record_count: 2 })),
      ),
      maxAttempts: 1,
    });
    await expect(mismatch.snapshot()).rejects.toBeInstanceOf(RegistryContractError);

    const duplicate = new GetSkillaryClient({
      baseUrl: "https://registry.example.test/",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        response(
          snapshot({
            record_count: 2,
            skills: [skill(), skill({ download_url: "https://downloads.example.test/copy.zip" })],
          }),
        ),
      ),
      maxAttempts: 1,
    });
    await expect(duplicate.snapshot()).rejects.toThrow(/duplicate/);
  });

  it("validates archive hashes and provider URLs", async () => {
    const invalidHash = new GetSkillaryClient({
      baseUrl: "https://registry.example.test/",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        response(snapshot({ skills: [skill({ package: { size_bytes: 1, sha256: "not-a-hash" } })] })),
      ),
      maxAttempts: 1,
    });
    await expect(invalidHash.snapshot()).rejects.toBeInstanceOf(RegistryContractError);

    const invalidUrl = new GetSkillaryClient({
      baseUrl: "https://registry.example.test/",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        response(snapshot({ skills: [skill({ canonical_url: "http://getskillary.com/skills/fixture-skill/" })] })),
      ),
      maxAttempts: 1,
    });
    await expect(invalidUrl.snapshot()).rejects.toBeInstanceOf(RegistryContractError);
  });

  it("cancels a declared snapshot larger than the hard four MiB ceiling", async () => {
    const cancel = vi.fn(async () => undefined);
    const client = new GetSkillaryClient({
      baseUrl: "https://registry.example.test/",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(new ReadableStream<Uint8Array>({ cancel }), {
          headers: { "content-length": String(GETSKILLARY_MAX_SNAPSHOT_BYTES + 1) },
        }),
      ),
      maxAttempts: 1,
    });

    await expect(client.snapshot()).rejects.toBeInstanceOf(RegistryBodyTooLargeError);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
