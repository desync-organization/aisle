import {
  canonicalizePackageSelectionAssertions,
  legacyPersistedSelectionEnvelopeSchema,
  persistedSelectionEnvelopeSchema,
  SELECTION_STORAGE_VERSION,
  sortAndDedupeCatalogSkillIds,
  type CatalogSkillId,
  type PackageSelectionAssertion,
} from "./contracts";

export type PersistedSelectionDecodeResult =
  | Readonly<{
      status: "valid";
      ids: readonly CatalogSkillId[];
      packageAssertions: readonly PackageSelectionAssertion[];
    }>
  | Readonly<{
      status: "missing" | "corrupt" | "unsupported-version";
      ids: readonly [];
      packageAssertions: readonly [];
    }>;

function hasUnsupportedVersion(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("version" in value)) {
    return false;
  }

  const version = (value as { version?: unknown }).version;
  return version !== SELECTION_STORAGE_VERSION && version !== 1;
}

export function decodePersistedSelection(
  raw: string | null,
): PersistedSelectionDecodeResult {
  if (raw === null) return { status: "missing", ids: [], packageAssertions: [] };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "corrupt", ids: [], packageAssertions: [] };
  }

  if (hasUnsupportedVersion(value)) {
    return { status: "unsupported-version", ids: [], packageAssertions: [] };
  }

  const legacy = legacyPersistedSelectionEnvelopeSchema.safeParse(value);
  if (legacy.success) {
    return {
      status: "valid",
      ids: sortAndDedupeCatalogSkillIds(legacy.data.ids),
      packageAssertions: [],
    };
  }

  const parsed = persistedSelectionEnvelopeSchema.safeParse(value);
  if (!parsed.success) return { status: "corrupt", ids: [], packageAssertions: [] };

  return {
    status: "valid",
    ids: sortAndDedupeCatalogSkillIds(parsed.data.ids),
    packageAssertions: canonicalizePackageSelectionAssertions(
      parsed.data.packageAssertions,
    ),
  };
}

export function encodePersistedSelection(
  ids: readonly CatalogSkillId[],
  packageAssertions: readonly PackageSelectionAssertion[] = [],
): string {
  const envelope = persistedSelectionEnvelopeSchema.parse({
    version: SELECTION_STORAGE_VERSION,
    ids: sortAndDedupeCatalogSkillIds(ids),
    packageAssertions: canonicalizePackageSelectionAssertions(packageAssertions),
  });

  return JSON.stringify(envelope);
}
