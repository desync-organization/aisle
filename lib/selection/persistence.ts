import {
  canonicalizePackageSelectionAssertions,
  deriveSelectedCatalogSkillIds,
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
      individualIds: readonly CatalogSkillId[];
      packageAssertions: readonly PackageSelectionAssertion[];
    }>
  | Readonly<{
      status: "missing" | "corrupt" | "unsupported-version";
      ids: readonly [];
      individualIds: readonly [];
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
  if (raw === null) {
    return { status: "missing", ids: [], individualIds: [], packageAssertions: [] };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "corrupt", ids: [], individualIds: [], packageAssertions: [] };
  }

  if (hasUnsupportedVersion(value)) {
    return {
      status: "unsupported-version",
      ids: [],
      individualIds: [],
      packageAssertions: [],
    };
  }

  const legacy = legacyPersistedSelectionEnvelopeSchema.safeParse(value);
  if (legacy.success) {
    const individualIds = sortAndDedupeCatalogSkillIds(legacy.data.ids);
    return {
      status: "valid",
      ids: individualIds,
      individualIds,
      packageAssertions: [],
    };
  }

  const parsed = persistedSelectionEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    return { status: "corrupt", ids: [], individualIds: [], packageAssertions: [] };
  }

  const individualIds = sortAndDedupeCatalogSkillIds(parsed.data.individualIds);
  const packageAssertions = canonicalizePackageSelectionAssertions(
    parsed.data.packageAssertions,
  );

  return {
    status: "valid",
    ids: deriveSelectedCatalogSkillIds(individualIds, packageAssertions),
    individualIds,
    packageAssertions,
  };
}

export function encodePersistedSelection(
  individualIds: readonly CatalogSkillId[],
  packageAssertions: readonly PackageSelectionAssertion[] = [],
): string {
  const canonicalIndividuals = sortAndDedupeCatalogSkillIds(individualIds);
  const canonicalAssertions = canonicalizePackageSelectionAssertions(packageAssertions);
  const envelope = persistedSelectionEnvelopeSchema.parse({
    version: SELECTION_STORAGE_VERSION,
    ids: deriveSelectedCatalogSkillIds(canonicalIndividuals, canonicalAssertions),
    individualIds: canonicalIndividuals,
    packageAssertions: canonicalAssertions,
  });

  return JSON.stringify(envelope);
}
