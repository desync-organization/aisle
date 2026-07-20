import {
  catalogSkillIdListSchema,
  MAX_SELECTED_SKILLS,
  SELECTION_QUERY_PARAMETER,
  sortAndDedupeCatalogSkillIds,
  type CatalogSkillId,
} from "./contracts";
import type {
  SelectionMutationResult,
  SelectionStore,
} from "./store";

export const MAX_SELECTION_SHARE_QUERY_LENGTH = 32_768;

export type SelectionShareFailureReason =
  | "malformed-query"
  | "unsupported-field"
  | "invalid-selection"
  | "limit-exceeded";

export type SelectionShareFailure = Readonly<{
  ok: false;
  reason: SelectionShareFailureReason;
  issues: readonly Readonly<{ path: string; message: string }>[];
}>;

export type SelectionShareEncodeResult =
  | Readonly<{
      ok: true;
      ids: readonly CatalogSkillId[];
      search: string;
    }>
  | SelectionShareFailure;

export type SelectionShareDecodeResult =
  | Readonly<{
      ok: true;
      present: boolean;
      ids: readonly CatalogSkillId[];
    }>
  | SelectionShareFailure;

export type SelectionShareApplyResult =
  | Readonly<{
      ok: true;
      present: boolean;
      changed: boolean;
      ids: readonly CatalogSkillId[];
    }>
  | SelectionShareFailure;

function failure(
  reason: SelectionShareFailureReason,
  path: string,
  message: string,
): SelectionShareFailure {
  return { ok: false, reason, issues: [{ path, message }] };
}

function parseSelectionIds(
  value: unknown,
): readonly CatalogSkillId[] | SelectionShareFailure {
  if (Array.isArray(value) && value.length > MAX_SELECTED_SKILLS) {
    return failure(
      "limit-exceeded",
      SELECTION_QUERY_PARAMETER,
      `cannot contain more than ${MAX_SELECTED_SKILLS} IDs`,
    );
  }

  const parsed = catalogSkillIdListSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid-selection",
      issues: parsed.error.issues.map((issue) => ({
        path: [SELECTION_QUERY_PARAMETER, ...issue.path.map(String)].join("."),
        message: issue.message,
      })),
    };
  }

  return sortAndDedupeCatalogSkillIds(parsed.data);
}

function isFailure(
  value: readonly CatalogSkillId[] | SelectionShareFailure,
): value is SelectionShareFailure {
  return !Array.isArray(value);
}

function searchParamsFromInput(
  input: string | URLSearchParams,
): URLSearchParams | SelectionShareFailure {
  if (input instanceof URLSearchParams) {
    const cloned = new URLSearchParams(input);
    if (cloned.toString().length > MAX_SELECTION_SHARE_QUERY_LENGTH) {
      return failure("malformed-query", "", "query string is too long");
    }
    return cloned;
  }

  if (
    input.length > MAX_SELECTION_SHARE_QUERY_LENGTH ||
    input.includes("#") ||
    input.includes("://")
  ) {
    return failure(
      "malformed-query",
      "",
      "must be a bounded query string, not a URL or fragment",
    );
  }

  const search = input.startsWith("?") ? input.slice(1) : input;
  return new URLSearchParams(search);
}

export function encodeSelectionShareQuery(
  input: unknown,
): SelectionShareEncodeResult {
  const ids = parseSelectionIds(input);
  if (isFailure(ids)) return ids;

  const search = new URLSearchParams();
  search.set(SELECTION_QUERY_PARAMETER, ids.join(","));
  const encoded = `?${search.toString()}`;
  if (encoded.length > MAX_SELECTION_SHARE_QUERY_LENGTH) {
    return failure(
      "limit-exceeded",
      SELECTION_QUERY_PARAMETER,
      "encoded selection query is too long",
    );
  }

  return { ok: true, ids, search: encoded };
}

export function decodeSelectionShareQuery(
  input: string | URLSearchParams,
): SelectionShareDecodeResult {
  const parsedInput = searchParamsFromInput(input);
  if (!(parsedInput instanceof URLSearchParams)) return parsedInput;

  const unsupportedFields = [...new Set(parsedInput.keys())].filter(
    (key) => key !== SELECTION_QUERY_PARAMETER,
  );
  if (unsupportedFields.length > 0) {
    return failure(
      "unsupported-field",
      unsupportedFields.sort()[0] ?? "",
      "selection share queries accept only opaque catalog skill IDs",
    );
  }

  const encodedSelections = parsedInput.getAll(SELECTION_QUERY_PARAMETER);
  if (encodedSelections.length === 0) {
    return { ok: true, present: false, ids: [] };
  }
  if (encodedSelections.length > 1) {
    return failure(
      "malformed-query",
      SELECTION_QUERY_PARAMETER,
      "must appear at most once",
    );
  }

  const encoded = encodedSelections[0] ?? "";
  const rawIds = encoded === "" ? [] : encoded.split(",");
  const ids = parseSelectionIds(rawIds);
  if (isFailure(ids)) return ids;

  return { ok: true, present: true, ids };
}

function mutationFailureToShareFailure(
  result: Extract<SelectionMutationResult, { ok: false }>,
): SelectionShareFailure {
  return {
    ok: false,
    reason:
      result.reason === "limit-exceeded"
        ? "limit-exceeded"
        : "invalid-selection",
    issues: result.issues,
  };
}

export function applySelectionShareQuery(
  store: SelectionStore,
  input: string | URLSearchParams,
): SelectionShareApplyResult {
  const decoded = decodeSelectionShareQuery(input);
  if (!decoded.ok) return decoded;
  if (!decoded.present) {
    return {
      ok: true,
      present: false,
      changed: false,
      ids: store.hydrate().ids,
    };
  }

  const result = store.actions.replace(decoded.ids);
  if (!result.ok) return mutationFailureToShareFailure(result);

  return {
    ok: true,
    present: true,
    changed: result.changed,
    ids: result.snapshot.ids,
  };
}
