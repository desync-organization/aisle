import type { ZodIssue } from "zod";

import {
  canonicalizePackageSelectionAssertions,
  catalogSkillIdListSchema,
  catalogSkillIdSchema,
  LEGACY_SELECTION_STORAGE_KEY,
  MAX_PACKAGE_ASSERTION_MEMBER_REFERENCES,
  MAX_PACKAGE_SELECTION_ASSERTIONS,
  MAX_SELECTED_SKILLS,
  packageSelectionAssertionSchema,
  SELECTION_STORAGE_KEY,
  SELECTION_STORAGE_VERSION,
  sortAndDedupeCatalogSkillIds,
  type CatalogSkillId,
  type PackageSelectionAssertion,
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
  packageAssertions: readonly PackageSelectionAssertion[];
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
  addPackage(assertion: unknown): SelectionMutationResult;
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
const emptyPackageAssertions = Object.freeze([]) as readonly PackageSelectionAssertion[];

export const EMPTY_SELECTION_SERVER_SNAPSHOT: SelectionSnapshot = Object.freeze({
  ids: emptyIds,
  packageAssertions: emptyPackageAssertions,
  count: 0,
  hydrated: false,
  atLimit: false,
  persistence: "unhydrated",
});

function createSnapshot(
  ids: readonly CatalogSkillId[],
  packageAssertions: readonly PackageSelectionAssertion[],
  hydrated: boolean,
  persistence: SelectionPersistenceStatus,
): SelectionSnapshot {
  const stableIds = Object.freeze([...ids]);
  const stablePackageAssertions = Object.freeze(
    canonicalizePackageSelectionAssertions(packageAssertions).map((assertion) => Object.freeze({
      ...assertion,
      members: Object.freeze(assertion.members.map((member) => Object.freeze({ ...member }))),
    })),
  );
  return Object.freeze({
    ids: stableIds,
    packageAssertions: stablePackageAssertions,
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
      emit(createSnapshot(emptyIds, emptyPackageAssertions, true, "unavailable"));
      return snapshot;
    }

    try {
      let raw = storage.getItem(storageKey);
      const legacyKey = storageKey === SELECTION_STORAGE_KEY
        ? LEGACY_SELECTION_STORAGE_KEY
        : null;
      let readFromLegacyKey = false;
      if (raw === null && legacyKey) {
        raw = storage.getItem(legacyKey);
        readFromLegacyKey = raw !== null;
      }
      const decoded = decodePersistedSelection(raw);

      if (decoded.status === "valid") {
        const canonicalPayload = encodePersistedSelection(
          decoded.ids,
          decoded.packageAssertions,
        );
        let persistence: SelectionPersistenceStatus = "available";
        if (canonicalPayload !== raw || readFromLegacyKey) {
          try {
            storage.setItem(storageKey, canonicalPayload);
            if (readFromLegacyKey && legacyKey) storage.removeItem(legacyKey);
          } catch {
            persistence = "error";
          }
        }
        emit(createSnapshot(
          decoded.ids,
          decoded.packageAssertions,
          true,
          persistence,
        ));
        return snapshot;
      }

      if (decoded.status !== "missing") {
        storage.removeItem(readFromLegacyKey && legacyKey ? legacyKey : storageKey);
      }
      emit(createSnapshot(emptyIds, emptyPackageAssertions, true, "available"));
      return snapshot;
    } catch {
      emit(createSnapshot(emptyIds, emptyPackageAssertions, true, "error"));
      return snapshot;
    }
  }

  function persist(
    ids: readonly CatalogSkillId[],
    packageAssertions: readonly PackageSelectionAssertion[],
  ): SelectionPersistenceStatus {
    const storage = resolveStorage();
    if (storage === null) return "unavailable";

    try {
      storage.setItem(storageKey, encodePersistedSelection(ids, packageAssertions));
      return "available";
    } catch {
      return "error";
    }
  }

  function success(
    ids: readonly CatalogSkillId[],
    packageAssertions: readonly PackageSelectionAssertion[],
    changed: boolean,
  ): SelectionMutationResult {
    if (changed) {
      emit(createSnapshot(
        ids,
        packageAssertions,
        true,
        persist(ids, packageAssertions),
      ));
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

  function isMutationResult(
    value: readonly CatalogSkillId[] | SelectionMutationResult,
  ): value is SelectionMutationResult {
    return !Array.isArray(value);
  }

  function currentIds(): readonly CatalogSkillId[] {
    hydrate();
    return snapshot.ids;
  }

  function retainedAssertions(
    ids: readonly CatalogSkillId[],
  ): readonly PackageSelectionAssertion[] {
    const selected = new Set(ids);
    return snapshot.packageAssertions.filter((assertion) =>
      assertion.members.every((member) => selected.has(member.selectionId)),
    );
  }

  function sameAssertions(
    left: readonly PackageSelectionAssertion[],
    right: readonly PackageSelectionAssertion[],
  ): boolean {
    return JSON.stringify(canonicalizePackageSelectionAssertions(left)) ===
      JSON.stringify(canonicalizePackageSelectionAssertions(right));
  }

  const actions: SelectionActions = {
    toggle(id) {
      const parsed = parseId(id);
      if (typeof parsed !== "string") return parsed;

      const current = currentIds();
      if (current.includes(parsed)) {
        const next = current.filter((candidate) => candidate !== parsed);
        return success(next, retainedAssertions(next), true);
      }
      if (current.length === MAX_SELECTED_SKILLS) {
        return failure("limit-exceeded");
      }

      return success(
        sortAndDedupeCatalogSkillIds([...current, parsed]),
        snapshot.packageAssertions,
        true,
      );
    },

    addMany(ids) {
      const parsed = parseIds(ids);
      if (isMutationResult(parsed)) return parsed;

      const current = currentIds();
      const next = sortAndDedupeCatalogSkillIds([...current, ...parsed]);
      if (next.length > MAX_SELECTED_SKILLS) {
        return failure("limit-exceeded");
      }

      const changed = next.length !== current.length;
      return success(next, snapshot.packageAssertions, changed);
    },

    addPackage(assertion) {
      hydrate();
      const parsed = packageSelectionAssertionSchema.safeParse(assertion);
      if (!parsed.success) {
        return failure("invalid-selection", issuesFromZod(parsed.error.issues));
      }
      const current = currentIds();
      const nextIds = sortAndDedupeCatalogSkillIds([
        ...current,
        ...parsed.data.members.map((member) => member.selectionId),
      ]);
      if (nextIds.length > MAX_SELECTED_SKILLS) return failure("limit-exceeded");

      const nextAssertions = canonicalizePackageSelectionAssertions([
        ...snapshot.packageAssertions.filter(
          (candidate) => candidate.packageSlug !== parsed.data.packageSlug,
        ),
        parsed.data,
      ]);
      if (nextAssertions.length > MAX_PACKAGE_SELECTION_ASSERTIONS) {
        return failure("limit-exceeded");
      }
      if (
        nextAssertions.reduce((total, candidate) => total + candidate.members.length, 0) >
        MAX_PACKAGE_ASSERTION_MEMBER_REFERENCES
      ) {
        return failure("limit-exceeded");
      }
      const changed = nextIds.length !== current.length ||
        !sameAssertions(snapshot.packageAssertions, nextAssertions);
      return success(nextIds, nextAssertions, changed);
    },

    remove(id) {
      const parsed = parseId(id);
      if (typeof parsed !== "string") return parsed;

      const current = currentIds();
      if (!current.includes(parsed)) {
        return success(current, snapshot.packageAssertions, false);
      }
      const next = current.filter((candidate) => candidate !== parsed);
      return success(next, retainedAssertions(next), true);
    },

    replace(ids) {
      const parsed = parseIds(ids);
      if (isMutationResult(parsed)) return parsed;

      const current = currentIds();
      const changed =
        parsed.length !== current.length ||
        parsed.some((id, index) => id !== current[index]);
      const nextAssertions = retainedAssertions(parsed);
      return success(
        parsed,
        nextAssertions,
        changed || !sameAssertions(snapshot.packageAssertions, nextAssertions),
      );
    },

    clear() {
      const current = currentIds();
      return success(
        emptyIds,
        emptyPackageAssertions,
        current.length > 0 || snapshot.packageAssertions.length > 0,
      );
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
