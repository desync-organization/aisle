import { describe, expect, it } from "vitest";

import {
  applySelectionShareQuery,
  createSelectionStore,
  decodeSelectionShareQuery,
  encodeSelectionShareQuery,
  MAX_SELECTED_SKILLS,
} from "@/lib/selection";
import { MemorySelectionStorage } from "./selection-test-helpers";

describe("selection share queries", () => {
  it("encodes a deterministic, deduplicated, stable query", () => {
    expect(encodeSelectionShareQuery(["skill-z", "skill-a", "skill-z"])).toEqual({
      ok: true,
      ids: ["skill-a", "skill-z"],
      search: "?skills=skill-a%2Cskill-z",
    });
  });

  it("decodes in stable order and distinguishes absent from explicit empty", () => {
    expect(decodeSelectionShareQuery("?skills=skill-z%2Cskill-a%2Cskill-z")).toEqual({
      ok: true,
      present: true,
      ids: ["skill-a", "skill-z"],
    });
    expect(decodeSelectionShareQuery("")).toEqual({
      ok: true,
      present: false,
      ids: [],
    });
    expect(decodeSelectionShareQuery("?skills=")).toEqual({
      ok: true,
      present: true,
      ids: [],
    });
  });

  it.each([
    ["full URL", "https://example.com/?skills=skill-a", "malformed-query"],
    ["fragment", "?skills=skill-a#command", "malformed-query"],
    ["duplicate field", "?skills=skill-a&skills=skill-b", "malformed-query"],
    ["source field", "?skills=skill-a&source=owner/repo", "unsupported-field"],
    ["command field", "?skills=skill-a&command=whoami", "unsupported-field"],
    ["invalid ID", "?skills=skill-a%2C--all", "invalid-selection"],
  ])("rejects malformed or executable-bearing %s", (_label, search, reason) => {
    expect(decodeSelectionShareQuery(search)).toMatchObject({ ok: false, reason });
  });

  it("rejects raw and encoded selections above the shared cap", () => {
    const tooMany = Array.from(
      { length: MAX_SELECTED_SKILLS + 1 },
      (_, index) => `skill-${index}`,
    );
    expect(encodeSelectionShareQuery(tooMany)).toMatchObject({
      ok: false,
      reason: "limit-exceeded",
    });
    expect(decodeSelectionShareQuery(`?skills=${tooMany.join("%2C")}`)).toMatchObject({
      ok: false,
      reason: "limit-exceeded",
    });
  });

  it("applies present queries with replacement semantics", () => {
    const store = createSelectionStore({ storage: new MemorySelectionStorage() });
    store.actions.addMany(["skill-old-a", "skill-old-b"]);

    expect(applySelectionShareQuery(store, "?skills=skill-new")).toEqual({
      ok: true,
      present: true,
      changed: true,
      ids: ["skill-new"],
    });
    expect(store.getSnapshot().ids).toEqual(["skill-new"]);

    expect(applySelectionShareQuery(store, "")).toMatchObject({
      ok: true,
      present: false,
      changed: false,
      ids: ["skill-new"],
    });
    expect(applySelectionShareQuery(store, "?skills=")).toMatchObject({
      ok: true,
      present: true,
      changed: true,
      ids: [],
    });
  });
});
