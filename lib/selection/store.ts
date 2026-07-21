import type { ZodIssue } from "zod";

import {
  canonicalizePackageSelectionAssertions,
  catalogSkillIdListSchema,
  catalogSkillIdSchema,
  deriveSelectedCatalogSkillIds,
  LEGACY_SELECTION_STORAGE_KEY,
  MAX_PACKAGE_ASSERTION_MEMBER_REFERENCES,
  MAX_PACKAGE_SELECTION_ASSERTIONS,
  MAX_SELECTED_SKILLS,
  packageSelectionAssertionSchema,
  packageSelectionSlugSchema,
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
  individualIds: readonly CatalogSkillId[];
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
  removePackage(slug: unknown): SelectionMutationResult;
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
  individualIds: emptyIds,
  packageAssertions: emptyPackageAssertions,
  count: 0,
  hydrated: false,
  atLimit: false,
  persistence: "unhydrated",
});

function createSnapshot(
  individualIds: readonly CatalogSkillId[],
  packageAssertions: readonly PackageSelectionAssertion[],
  hydrated: boolean,
  persistence: SelectionPersistenceStatus,
): SelectionSnapshot {
  const stableIndividualIds = Object.freeze([
    ...sortAndDedupeCatalogSkillIds(individualIds),
  ]);
  const stablePackageAssertions = Object.freeze(
    canonicalizePackageSelectionAssertions(packageAssertions).map((assertion) => Object.freeze({
      ...assertion,
      members: Object.freeze(assertion.members.map((member) => Object.freeze({ ...member }))),
    })),
  );
  const stableIds = Object.freeze([
    ...deriveSelectedCatalogSkillIds(stableIndividualIds, stablePackageAssertions),
  ]);
  return Object.freeze({
    ids: stableIds,
    individualIds: stableIndividualIds,
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
          decoded.individualIds,
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
          decoded.individualIds,
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
    individualIds: readonly CatalogSkillId[],
    packageAssertions: readonly PackageSelectionAssertion[],
  ): SelectionPersistenceStatus {
    const storage = resolveStorage();
    if (storage === null) return "unavailable";

    try {
      storage.setItem(
        storageKey,
        encodePersistedSelection(individualIds, packageAssertions),
      );
      return "available";
    } catch {
      return "error";
    }
  }

  function success(
    individualIds: readonly CatalogSkillId[],
    packageAssertions: readonly PackageSelectionAssertion[],
    changed: boolean,
  ): SelectionMutationResult {
    if (changed) {
      emit(createSnapshot(
        individualIds,
        packageAssertions,
        true,
        persist(individualIds, packageAssertions),
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

  function parsePackageSlug(slug: unknown): string | SelectionMutationResult {
    const parsed = packageSelectionSlugSchema.safeParse(slug);
    if (!parsed.success) {
      return failure("invalid-selection", issuesFromZod(parsed.error.issues));
    }
    return parsed.data;
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

  function sameIds(
    left: readonly CatalogSkillId[],
    right: readonly CatalogSkillId[],
  ): boolean {
    return left.length === right.length &&
      left.every((id, index) => id === right[index]);
  }

  function sameAssertions(
    left: readonly PackageSelectionAssertion[],
    right: readonly PackageSelectionAssertion[],
  ): boolean {
    return JSON.stringify(canonicalizePackageSelectionAssertions(left)) ===
      JSON.stringify(canonicalizePackageSelectionAssertions(right));
  }

  function removeSelectedId(id: CatalogSkillId): SelectionMutationResult {
    const brokenAssertions = snapshot.packageAssertions.filter((assertion) =>
      assertion.members.some((member) => member.selectionId === id),
    );
    const retainedAssertions = snapshot.packageAssertions.filter((assertion) =>
      !assertion.members.some((member) => member.selectionId === id),
    );
    const promotedIndividuals = brokenAssertions.flatMap((assertion) =>
      assertion.members
        .filter((member) => member.selectionId !== id)
        .map((member) => member.selectionId),
    );
    const nextIndividuals = sortAndDedupeCatalogSkillIds([
      ...snapshot.individualIds.filter((candidate) => candidate !== id),
      ...promotedIndividuals,
    ]);
    return success(nextIndividuals, retainedAssertions, true);
  }

  const actions: SelectionActions = {
    toggle(id) {
      const parsed = parseId(id);
      if (typeof parsed !== "string") return parsed;

      const current = currentIds();
      if (current.includes(parsed)) {
        return removeSelectedId(parsed);
      }
      if (current.length === MAX_SELECTED_SKILLS) {
        return failure("limit-exceeded");
      }

      return success(
        sortAndDedupeCatalogSkillIds([...snapshot.individualIds, parsed]),
        snapshot.packageAssertions,
        true,
      );
    },

    addMany(ids) {
      const parsed = parseIds(ids);
      if (isMutationResult(parsed)) return parsed;

      hydrate();
      const nextIndividuals = sortAndDedupeCatalogSkillIds([
        ...snapshot.individualIds,
        ...parsed,
      ]);
      const nextIds = deriveSelectedCatalogSkillIds(
        nextIndividuals,
        snapshot.packageAssertions,
      );
      if (nextIds.length > MAX_SELECTED_SKILLS) {
        return failure("limit-exceeded");
      }

      const changed = !sameIds(snapshot.individualIds, nextIndividuals);
      return success(nextIndividuals, snapshot.packageAssertions, changed);
    },

    addPackage(assertion) {
      hydrate();
      const parsed = packageSelectionAssertionSchema.safeParse(assertion);
      if (!parsed.success) {
        return failure("invalid-selection", issuesFromZod(parsed.error.issues));
      }
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
      const nextIds = deriveSelectedCatalogSkillIds(
        snapshot.individualIds,
        nextAssertions,
      );
      if (nextIds.length > MAX_SELECTED_SKILLS) return failure("limit-exceeded");

      const changed = !sameAssertions(snapshot.packageAssertions, nextAssertions);
      return success(snapshot.individualIds, nextAssertions, changed);
    },

    removePackage(slug) {
      const parsed = parsePackageSlug(slug);
      if (typeof parsed !== "string") return parsed;
      hydrate();

      const nextAssertions = snapshot.packageAssertions.filter(
        (assertion) => assertion.packageSlug !== parsed,
      );
      if (nextAssertions.length === snapshot.packageAssertions.length) {
        return success(snapshot.individualIds, snapshot.packageAssertions, false);
      }
      return success(snapshot.individualIds, nextAssertions, true);
    },

    remove(id) {
      const parsed = parseId(id);
      if (typeof parsed !== "string") return parsed;

      const current = currentIds();
      if (!current.includes(parsed)) {
        return success(snapshot.individualIds, snapshot.packageAssertions, false);
      }
      return removeSelectedId(parsed);
    },

    replace(ids) {
      const parsed = parseIds(ids);
      if (isMutationResult(parsed)) return parsed;

      hydrate();
      const changed = !sameIds(parsed, snapshot.individualIds) ||
        snapshot.packageAssertions.length > 0;
      return success(
        parsed,
        emptyPackageAssertions,
        changed,
      );
    },

    clear() {
      const current = currentIds();
      return success(
        emptyIds,
        emptyPackageAssertions,
        current.length > 0 || snapshot.individualIds.length > 0 ||
          snapshot.packageAssertions.length > 0,
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
