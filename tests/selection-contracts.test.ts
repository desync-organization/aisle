import { describe, expect, it } from "vitest";

import {
  catalogSkillIdSchema,
  decodePersistedSelection,
  encodePersistedSelection,
  MAX_CATALOG_SKILL_ID_LENGTH,
  persistedSelectionEnvelopeSchema,
  SELECTION_STORAGE_VERSION,
} from "@/lib/selection";
import { catalogId } from "./selection-test-helpers";

describe("selection persistence contracts", () => {
  it.each([
    "skill_01HX3JY8KJ2AJ4",
    "skill:01HX3JY8KJ2AJ4",
    "01HX3JY8-KJ2A-J4",
    "catalog.skill-123",
  ])("accepts bounded opaque catalog ID %s", (value) => {
    expect(catalogSkillIdSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    "https://example.com/skill",
    "javascript:alert",
    "skill/id",
    "--all",
    "skill;whoami",
    "skill && whoami",
    "skıll",
    "skill\ncommand",
    `s${"x".repeat(MAX_CATALOG_SKILL_ID_LENGTH)}`,
  ])("rejects URL, command, Unicode, control, or oversized ID %s", (value) => {
    expect(catalogSkillIdSchema.safeParse(value).success).toBe(false);
  });

  it("uses a strict versioned envelope for IDs and immutable package assertions", () => {
    const envelope = {
      version: SELECTION_STORAGE_VERSION,
      ids: [catalogId("skill-b"), catalogId("skill-a")],
      packageAssertions: [],
    };
    expect(persistedSelectionEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(
      persistedSelectionEnvelopeSchema.safeParse({
        ...envelope,
        source: "owner/repository",
      }).success,
    ).toBe(false);
    expect(
      persistedSelectionEnvelopeSchema.safeParse({
        ...envelope,
        command: "npx something",
      }).success,
    ).toBe(false);
  });

  it("recovers missing, corrupt, and old payloads without accepting fields", () => {
    expect(decodePersistedSelection(null)).toEqual({
      status: "missing",
      ids: [],
      packageAssertions: [],
    });
    expect(decodePersistedSelection("{not-json")).toEqual({
      status: "corrupt",
      ids: [],
      packageAssertions: [],
    });
    expect(decodePersistedSelection('{"version":0,"ids":["skill-a"]}')).toEqual({
      status: "unsupported-version",
      ids: [],
      packageAssertions: [],
    });
    expect(
      decodePersistedSelection(
        '{"version":1,"ids":["skill-a"],"command":"whoami"}',
      ),
    ).toEqual({ status: "corrupt", ids: [], packageAssertions: [] });
  });

  it("serializes a stable sorted and deduplicated payload", () => {
    const encoded = encodePersistedSelection([
      catalogId("skill-z"),
      catalogId("skill-a"),
      catalogId("skill-z"),
    ]);

    expect(encoded).toBe(
      '{"version":2,"ids":["skill-a","skill-z"],"packageAssertions":[]}',
    );
    expect(encoded).not.toMatch(/source|command|url/i);
    expect(decodePersistedSelection(encoded)).toEqual({
      status: "valid",
      ids: ["skill-a", "skill-z"],
      packageAssertions: [],
    });
  });

  it("canonicalizes a bounded package receipt with exact member revisions", () => {
    const encoded = encodePersistedSelection(
      [catalogId("skill_aaaaaaaaaaaaaaaaaaaaaaaa")],
      [{
        packageSlug: "frontend-foundations",
        packageVersion: 3,
        blueprintDigest: `sha256:${"b".repeat(64)}`,
        members: [{
          selectionId: catalogId("skill_aaaaaaaaaaaaaaaaaaaaaaaa"),
          revisionId: "revision_cccccccccccccccccccccccc",
        }],
      }],
    );

    expect(decodePersistedSelection(encoded)).toMatchObject({
      status: "valid",
      packageAssertions: [{
        packageSlug: "frontend-foundations",
        packageVersion: 3,
        members: [{ revisionId: "revision_cccccccccccccccccccccccc" }],
      }],
    });
  });
});
