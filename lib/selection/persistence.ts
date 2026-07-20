import {
  persistedSelectionEnvelopeSchema,
  SELECTION_STORAGE_VERSION,
  sortAndDedupeCatalogSkillIds,
  type CatalogSkillId,
} from "./contracts";

export type PersistedSelectionDecodeResult =
  | Readonly<{
      status: "valid";
      ids: readonly CatalogSkillId[];
    }>
  | Readonly<{
      status: "missing" | "corrupt" | "unsupported-version";
      ids: readonly [];
    }>;

function hasUnsupportedVersion(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("version" in value)) {
    return false;
  }

  return (value as { version?: unknown }).version !== SELECTION_STORAGE_VERSION;
}

export function decodePersistedSelection(
  raw: string | null,
): PersistedSelectionDecodeResult {
  if (raw === null) return { status: "missing", ids: [] };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "corrupt", ids: [] };
  }

  if (hasUnsupportedVersion(value)) {
    return { status: "unsupported-version", ids: [] };
  }

  const parsed = persistedSelectionEnvelopeSchema.safeParse(value);
  if (!parsed.success) return { status: "corrupt", ids: [] };

  return {
    status: "valid",
    ids: sortAndDedupeCatalogSkillIds(parsed.data.ids),
  };
}

export function encodePersistedSelection(
  ids: readonly CatalogSkillId[],
): string {
  const envelope = persistedSelectionEnvelopeSchema.parse({
    version: SELECTION_STORAGE_VERSION,
    ids: sortAndDedupeCatalogSkillIds(ids),
  });

  return JSON.stringify(envelope);
}
