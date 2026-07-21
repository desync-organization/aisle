import { describe, expect, it, vi } from "vitest";

import {
  createSelectionStore,
  EMPTY_SELECTION_SERVER_SNAPSHOT,
  MAX_SELECTED_SKILLS,
  SELECTION_STORAGE_KEY,
  SELECTION_STORAGE_VERSION,
} from "@/lib/selection";
import { MemorySelectionStorage } from "./selection-test-helpers";

describe("selection store", () => {
  it("starts with an SSR-stable snapshot and hydrates without browser storage", () => {
    const store = createSelectionStore({ storage: null });

    expect(store.getSnapshot()).toBe(EMPTY_SELECTION_SERVER_SNAPSHOT);
    expect(store.getServerSnapshot()).toBe(EMPTY_SELECTION_SERVER_SNAPSHOT);
    expect(store.hydrate()).toMatchObject({
      ids: [],
      hydrated: true,
      persistence: "unavailable",
    });
  });

  it("persists and restores one deterministic selection across reloads", () => {
    const storage = new MemorySelectionStorage();
    const first = createSelectionStore({ storage });
    first.hydrate();
    expect(first.actions.addMany(["skill-c", "skill-a", "skill-b"]).ok).toBe(true);

    const second = createSelectionStore({ storage });
    expect(second.getSnapshot().hydrated).toBe(false);
    expect(second.hydrate()).toMatchObject({
      ids: ["skill-a", "skill-b", "skill-c"],
      hydrated: true,
      persistence: "available",
    });
    expect(storage.getItem(SELECTION_STORAGE_KEY)).toBe(
      '{"version":2,"ids":["skill-a","skill-b","skill-c"],"packageAssertions":[]}',
    );
  });

  it("uses one deduplicating action surface for package add-all and individual toggles", () => {
    const store = createSelectionStore({ storage: new MemorySelectionStorage() });
    store.hydrate();

    expect(store.actions.addMany(["skill-c", "skill-a", "skill-a"])).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(store.getSnapshot().ids).toEqual(["skill-a", "skill-c"]);
    expect(store.actions.addMany(["skill-c", "skill-a"])).toMatchObject({
      ok: true,
      changed: false,
    });

    store.actions.toggle("skill-b");
    expect(store.getSnapshot().ids).toEqual(["skill-a", "skill-b", "skill-c"]);
    store.actions.toggle("skill-a");
    expect(store.getSnapshot().ids).toEqual(["skill-b", "skill-c"]);
    store.actions.remove("skill-c");
    expect(store.getSnapshot().ids).toEqual(["skill-b"]);
    store.actions.clear();
    expect(store.getSnapshot().ids).toEqual([]);
  });

  it("rejects invalid IDs and all limit overflow without changing state", () => {
    const store = createSelectionStore({ storage: new MemorySelectionStorage() });
    const maximum = Array.from(
      { length: MAX_SELECTED_SKILLS },
      (_, index) => `skill-${String(index).padStart(2, "0")}`,
    );

    expect(store.actions.addMany(maximum)).toMatchObject({ ok: true, changed: true });
    expect(store.getSnapshot()).toMatchObject({ count: MAX_SELECTED_SKILLS, atLimit: true });
    expect(store.actions.toggle("skill-overflow")).toMatchObject({
      ok: false,
      reason: "limit-exceeded",
    });
    expect(store.actions.addMany([...maximum, "skill-overflow"])).toMatchObject({
      ok: false,
      reason: "limit-exceeded",
    });
    expect(store.actions.replace([...maximum, "skill-overflow"])).toMatchObject({
      ok: false,
      reason: "limit-exceeded",
    });
    expect(store.actions.toggle("https://example.invalid")).toMatchObject({
      ok: false,
      reason: "invalid-id",
    });
    expect(store.getSnapshot().ids).toEqual(maximum);
  });

  it.each([
    ["corrupt", "{broken"],
    ["old", '{"version":0,"ids":["skill-old"]}'],
    ["extra command", '{"version":2,"ids":["skill-a"],"packageAssertions":[],"command":"whoami"}'],
  ])("recovers %s storage by clearing it", (_label, payload) => {
    const storage = new MemorySelectionStorage();
    storage.setItem(SELECTION_STORAGE_KEY, payload);
    const store = createSelectionStore({ storage });

    expect(store.hydrate()).toMatchObject({ ids: [], hydrated: true });
    expect(storage.getItem(SELECTION_STORAGE_KEY)).toBeNull();
    expect(storage.removedKeys).toEqual([SELECTION_STORAGE_KEY]);
  });

  it("canonicalizes a valid legacy-order v1 payload on hydration", () => {
    const storage = new MemorySelectionStorage();
    storage.setItem(
      SELECTION_STORAGE_KEY,
      JSON.stringify({
        version: SELECTION_STORAGE_VERSION,
        ids: ["skill-z", "skill-a", "skill-z"],
        packageAssertions: [],
      }),
    );

    const store = createSelectionStore({ storage });
    expect(store.hydrate().ids).toEqual(["skill-a", "skill-z"]);
    expect(storage.getItem(SELECTION_STORAGE_KEY)).toBe(
      '{"version":2,"ids":["skill-a","skill-z"],"packageAssertions":[]}',
    );
  });

  it("persists package receipts and drops one when a bound member is removed", () => {
    const storage = new MemorySelectionStorage();
    const store = createSelectionStore({ storage });
    store.hydrate();

    expect(store.actions.addPackage({
      packageSlug: "frontend-foundations",
      packageVersion: 1,
      blueprintDigest: `sha256:${"a".repeat(64)}`,
      members: [{
        selectionId: "skill_aaaaaaaaaaaaaaaaaaaaaaaa",
        revisionId: "revision_bbbbbbbbbbbbbbbbbbbbbbbb",
      }],
    })).toMatchObject({ ok: true, changed: true });
    expect(store.getSnapshot().packageAssertions).toHaveLength(1);

    store.actions.remove("skill_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(store.getSnapshot().packageAssertions).toEqual([]);
  });

  it("recovers storage read and corrupt-payload cleanup failures", () => {
    const readFailure = createSelectionStore({
      storage: {
        getItem() {
          throw new Error("read denied");
        },
        setItem() {},
        removeItem() {},
      },
    });
    expect(readFailure.hydrate()).toMatchObject({
      ids: [],
      hydrated: true,
      persistence: "error",
    });

    const cleanupFailure = createSelectionStore({
      storage: {
        getItem() {
          return "{corrupt";
        },
        setItem() {},
        removeItem() {
          throw new Error("cleanup denied");
        },
      },
    });
    expect(cleanupFailure.hydrate()).toMatchObject({
      ids: [],
      hydrated: true,
      persistence: "error",
    });
  });

  it("keeps deterministic in-memory state when storage quota writes fail", () => {
    const store = createSelectionStore({
      storage: {
        getItem() {
          return null;
        },
        setItem() {
          throw new Error("quota exceeded");
        },
        removeItem() {},
      },
    });
    store.hydrate();

    expect(store.actions.addMany(["skill-b", "skill-a"])).toMatchObject({
      ok: true,
      changed: true,
      snapshot: {
        ids: ["skill-a", "skill-b"],
        persistence: "error",
      },
    });
  });

  it("notifies subscribers only for observable state changes", () => {
    const store = createSelectionStore({ storage: new MemorySelectionStorage() });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.hydrate();
    store.actions.addMany(["skill-a", "skill-a"]);
    store.actions.addMany(["skill-a"]);
    store.actions.remove("missing-skill");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.actions.clear();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("never exposes source or command actions", () => {
    const store = createSelectionStore({ storage: null });
    expect(Object.keys(store.actions).sort()).toEqual([
      "addMany",
      "clear",
      "remove",
      "replace",
      "toggle",
    ]);
    expect(JSON.stringify(store.meta)).not.toMatch(/source|command|url/i);
  });
});
