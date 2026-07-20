import type { ZodIssue } from "zod";

import {
  catalogSkillIdListSchema,
  catalogSkillIdSchema,
  MAX_SELECTED_SKILLS,
  SELECTION_STORAGE_KEY,
  SELECTION_STORAGE_VERSION,
  sortAndDedupeCatalogSkillIds,
  type CatalogSkillId,
} from "./contracts";
import {
  decodePersistedSelection,
  encodePersistedSelection,
} from "./persistence";

export type SelectionPersistenceStatus =
  | "unhydrated"
  | "available"
  | "unavailable"
  | "error";

export type SelectionSnapshot = Readonly<{
  ids: readonly CatalogSkillId[];
  count: number;
  hydrated: boolean;
  atLimit: boolean;
  persistence: SelectionPersistenceStatus;
}>;

export type SelectionMutationFailureReason =
  | "invalid-id"
  | "invalid-selection"
  | "limit-exceeded";

export type SelectionMutationResult =
  | Readonly<{
      ok: true;
      changed: boolean;
      snapshot: SelectionSnapshot;
    }>
  | Readonly<{
      ok: false;
      reason: SelectionMutationFailureReason;
      issues: readonly Readonly<{ path: string; message: string }>[];
      snapshot: SelectionSnapshot;
    }>;

export interface SelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SelectionActions {
  toggle(id: unknown): SelectionMutationResult;
  addMany(ids: unknown): SelectionMutationResult;
  remove(id: unknown): SelectionMutationResult;
  replace(ids: unknown): SelectionMutationResult;
  clear(): SelectionMutationResult;
}

export interface SelectionStore {
  readonly actions: SelectionActions;
  readonly meta: Readonly<{
    maxSelections: typeof MAX_SELECTED_SKILLS;
    storageVersion: typeof SELECTION_STORAGE_VERSION;
  }>;
  getSnapshot(): SelectionSnapshot;
  getServerSnapshot(): SelectionSnapshot;
  subscribe(listener: () => void): () => void;
  hydrate(): SelectionSnapshot;
}

export type CreateSelectionStoreOptions = Readonly<{
  storage?: SelectionStorage | null;
  storageKey?: string;
}>;

const emptyIds = Object.freeze([]) as readonly CatalogSkillId[];

export const EMPTY_SELECTION_SERVER_SNAPSHOT: SelectionSnapshot = Object.freeze({
  ids: emptyIds,
  count: 0,
  hydrated: false,
  atLimit: false,
  persistence: "unhydrated",
});

function createSnapshot(
  ids: readonly CatalogSkillId[],
  hydrated: boolean,
  persistence: SelectionPersistenceStatus,
): SelectionSnapshot {
  const stableIds = Object.freeze([...ids]);
  return Object.freeze({
    ids: stableIds,
    count: stableIds.length,
    hydrated,
    atLimit: stableIds.length === MAX_SELECTED_SKILLS,
    persistence,
  });
}

function issuesFromZod(issues: readonly ZodIssue[]): readonly Readonly<{
  path: string;
  message: string;
}>[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

export function createSelectionStore(
  options: CreateSelectionStoreOptions = {},
): SelectionStore {
  const listeners = new Set<() => void>();
  const storageKey = options.storageKey ?? SELECTION_STORAGE_KEY;
  let snapshot = EMPTY_SELECTION_SERVER_SNAPSHOT;

  function emit(nextSnapshot: SelectionSnapshot): void {
    if (nextSnapshot === snapshot) return;
    snapshot = nextSnapshot;
    [...listeners].forEach((listener) => listener());
  }

  function resolveStorage(): SelectionStorage | null {
    if (options.storage !== undefined) return options.storage;
    if (typeof window === "undefined") return null;

    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }

  function hydrate(): SelectionSnapshot {
    if (snapshot.hydrated) return snapshot;

    const storage = resolveStorage();
    if (storage === null) {
      emit(createSnapshot(emptyIds, true, "unavailable"));
      return snapshot;
    }

    try {
      const raw = storage.getItem(storageKey);
      const decoded = decodePersistedSelection(raw);

      if (decoded.status === "valid") {
        const canonicalPayload = encodePersistedSelection(decoded.ids);
        let persistence: SelectionPersistenceStatus = "available";
        if (canonicalPayload !== raw) {
          try {
            storage.setItem(storageKey, canonicalPayload);
          } catch {
            persistence = "error";
          }
        }
        emit(createSnapshot(decoded.ids, true, persistence));
        return snapshot;
      }

      if (decoded.status !== "missing") storage.removeItem(storageKey);
      emit(createSnapshot(emptyIds, true, "available"));
      return snapshot;
    } catch {
      emit(createSnapshot(emptyIds, true, "error"));
      return snapshot;
    }
  }

  function persist(ids: readonly CatalogSkillId[]): SelectionPersistenceStatus {
    const storage = resolveStorage();
    if (storage === null) return "unavailable";

    try {
      storage.setItem(storageKey, encodePersistedSelection(ids));
      return "available";
    } catch {
      return "error";
    }
  }

  function success(
    ids: readonly CatalogSkillId[],
    changed: boolean,
  ): SelectionMutationResult {
    if (changed) {
      emit(createSnapshot(ids, true, persist(ids)));
    }
    return { ok: true, changed, snapshot };
  }

  function failure(
    reason: SelectionMutationFailureReason,
    issues: readonly Readonly<{ path: string; message: string }>[] = [],
  ): SelectionMutationResult {
    return { ok: false, reason, issues, snapshot };
  }

  function parseId(id: unknown): CatalogSkillId | SelectionMutationResult {
    const parsed = catalogSkillIdSchema.safeParse(id);
    if (!parsed.success) {
      return failure("invalid-id", issuesFromZod(parsed.error.issues));
    }
    return parsed.data;
  }

  function parseIds(ids: unknown): readonly CatalogSkillId[] | SelectionMutationResult {
    if (Array.isArray(ids) && ids.length > MAX_SELECTED_SKILLS) {
      return failure("limit-exceeded", [
        {
          path: "",
          message: `cannot contain more than ${MAX_SELECTED_SKILLS} IDs`,
        },
      ]);
    }

    const parsed = catalogSkillIdListSchema.safeParse(ids);
    if (!parsed.success) {
      return failure("invalid-selection", issuesFromZod(parsed.error.issues));
    }

    return sortAndDedupeCatalogSkillIds(parsed.data);
  }

  function currentIds(): readonly CatalogSkillId[] {
    hydrate();
    return snapshot.ids;
  }

  const actions: SelectionActions = {
    toggle(id) {
      const parsed = parseId(id);
      if (typeof parsed !== "string") return parsed;

      const current = currentIds();
      if (current.includes(parsed)) {
        return success(
          current.filter((candidate) => candidate !== parsed),
          true,
        );
      }
      if (current.length === MAX_SELECTED_SKILLS) {
        return failure("limit-exceeded");
      }

      return success(sortAndDedupeCatalogSkillIds([...current, parsed]), true);
    },

    addMany(ids) {
      const parsed = parseIds(ids);
      if (!Array.isArray(parsed)) return parsed;

      const current = currentIds();
      const next = sortAndDedupeCatalogSkillIds([...current, ...parsed]);
      if (next.length > MAX_SELECTED_SKILLS) {
        return failure("limit-exceeded");
      }

      const changed = next.length !== current.length;
      return success(next, changed);
    },

    remove(id) {
      const parsed = parseId(id);
      if (typeof parsed !== "string") return parsed;

      const current = currentIds();
      if (!current.includes(parsed)) return success(current, false);
      return success(
        current.filter((candidate) => candidate !== parsed),
        true,
      );
    },

    replace(ids) {
      const parsed = parseIds(ids);
      if (!Array.isArray(parsed)) return parsed;

      const current = currentIds();
      const changed =
        parsed.length !== current.length ||
        parsed.some((id, index) => id !== current[index]);
      return success(parsed, changed);
    },

    clear() {
      const current = currentIds();
      return success(emptyIds, current.length > 0);
    },
  };

  return {
    actions,
    meta: {
      maxSelections: MAX_SELECTED_SKILLS,
      storageVersion: SELECTION_STORAGE_VERSION,
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY_SELECTION_SERVER_SNAPSHOT,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hydrate,
  };
}
