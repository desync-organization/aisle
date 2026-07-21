import { z } from "zod";

import { normalizeSkillPath, normalizeSourceUrl } from "../normalization";
import type {
  CatalogSourceConnector,
  CatalogSourceDescriptor,
  ConnectorContext,
  ConnectorPage,
  DiscoveredSkillRecord,
} from "../source-contract";
import { GitHubPublicRepositoryAdapter } from "./github-public";
import type { GitHubSkillIdentity } from "./github-identity";

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_PROVIDER_RECORDS = 1_000;
const DEFAULT_MAX_REPOSITORIES = 200;
const DEFAULT_MAX_HYDRATIONS = 1_000;
const DEFAULT_MAX_PATHS_PER_REPOSITORY = 25;
const DEFAULT_MAX_EXCLUSIONS = 128;
const MAX_EXCLUSION_LENGTH = 512;

export const registryGitHubRawAttributionSchema = z
  .object({
    kind: z.literal("github-skill"),
    repository: z.string().min(3).max(256),
    manifestPath: z.string().min(8).max(2_048),
    commit: z.string().min(7).max(256),
    discoveredBy: z
      .object({
        sourceId: z.string().min(1).max(128),
        sourceRecordId: z.string().min(1).max(640),
      })
      .strict(),
  })
  .strict();

export type RegistryGitHubRawAttribution = z.infer<
  typeof registryGitHubRawAttributionSchema
>;

export interface RegistryGitHubCategoryHints {
  categories: readonly string[];
  tags: readonly string[];
}

export interface RegistryGitHubObservation {
  sourceRecordId: string;
  identity: GitHubSkillIdentity;
  categoryHints?: RegistryGitHubCategoryHints;
  hydrationEligible: boolean;
  exclusionReason?: string;
}

export interface RegistryGitHubProviderPage<TObservation extends RegistryGitHubObservation> {
  observations: readonly TObservation[];
  nextCursor: string | null;
  hasMore: boolean;
  exclusions?: readonly string[];
}

export interface RegistryGitHubPageProvider<TObservation extends RegistryGitHubObservation> {
  listPage(input: {
    cursor: string | null;
    limit: number;
  }): Promise<RegistryGitHubProviderPage<TObservation>>;
}

export interface RegistryToGitHubConnectorOptions<
  TObservation extends RegistryGitHubObservation,
> {
  descriptor: CatalogSourceDescriptor;
  provider: RegistryGitHubPageProvider<TObservation>;
  githubToken: string;
  fetch?: typeof fetch;
  pageSize?: number;
  maxPages?: number;
  maxProviderRecords?: number;
  maxRepositories?: number;
  maxHydrations?: number;
  maxPathsPerRepository?: number;
  maxExclusions?: number;
  githubMaxTreeEntries?: number;
  githubMaxArtifactFiles?: number;
}

interface ExactHydrationResult {
  record: DiscoveredSkillRecord | null;
  reason: string | null;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RangeError(`${label} must be an integer from 1 through ${maximum}`);
  }
  return resolved;
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, MAX_EXCLUSION_LENGTH);
}

function repositoryKey(identity: GitHubSkillIdentity): string {
  return `${identity.owner.toLowerCase()}/${identity.repository.toLowerCase()}`;
}

function boundedCategoryHints(
  hints: RegistryGitHubCategoryHints | undefined,
): { categories: string[]; tags: string[] } | undefined {
  if (!hints) return undefined;
  const bounded = (values: readonly string[], maximum: number, length: number): string[] => [
    ...new Set(
      values
        .slice(0, maximum)
        .map((value) => value.trim().slice(0, length))
        .filter(Boolean),
    ),
  ];
  return {
    categories: bounded(hints.categories, 16, 128),
    tags: bounded(hints.tags, 32, 64),
  };
}

function exactHydration(
  record: DiscoveredSkillRecord,
  identity: GitHubSkillIdentity,
): ExactHydrationResult {
  let sourceUrl: string;
  let repositoryUrl: string;
  let hydratedRepositoryUrl: string;
  let skillPath: string;
  let installSourceUrl: string | null = null;
  let installSkillPath: string | null = null;
  try {
    sourceUrl = normalizeSourceUrl(record.sourceUrl);
    repositoryUrl = normalizeSourceUrl(identity.repositoryUrl);
    hydratedRepositoryUrl = record.repository
      ? normalizeSourceUrl(record.repository.url)
      : "";
    skillPath = normalizeSkillPath(record.skillPath);
    if (record.installSpec?.kind === "source") {
      installSourceUrl = normalizeSourceUrl(record.installSpec.sourceUrl);
      installSkillPath = normalizeSkillPath(record.installSpec.skillPath);
    }
  } catch (error) {
    return { record: null, reason: `hydrated identity was invalid (${safeError(error)})` };
  }

  if (
    sourceUrl !== repositoryUrl ||
    skillPath !== identity.directoryPath ||
    record.repository?.provider.toLowerCase() !== "github" ||
    hydratedRepositoryUrl !== repositoryUrl ||
    record.repository.visibility !== "public"
  ) {
    return { record: null, reason: "hydrated repository or manifest identity did not match" };
  }
  if (
    !record.immutableRef ||
    !/^[a-f0-9]{40,64}$/iu.test(record.immutableRef) ||
    !record.contentHash ||
    !/^[a-f0-9]{64}$/iu.test(record.contentHash) ||
    record.upstreamHash !== record.immutableRef ||
    record.artifact?.complete !== true ||
    !record.artifact.files?.length
  ) {
    return { record: null, reason: "exact bounded GitHub artifact hydration was incomplete" };
  }
  if (
    record.installSpec?.kind !== "source" ||
    installSourceUrl !== repositoryUrl ||
    record.installSpec.immutableRef !== record.immutableRef ||
    installSkillPath !== identity.directoryPath
  ) {
    return { record: null, reason: "hydrated install evidence was not bound to the exact source" };
  }
  return { record, reason: null };
}

class BoundedExclusions {
  private count = 0;
  private overflowReported = false;

  constructor(private readonly maximum: number) {}

  add(target: string[], value: string): void {
    const bounded = value
      .replace(/[\u0000-\u001f\u007f]+/gu, " ")
      .trim()
      .slice(0, MAX_EXCLUSION_LENGTH);
    if (!bounded) return;
    if (this.count < this.maximum) {
      target.push(bounded);
      this.count += 1;
      return;
    }
    if (!this.overflowReported) {
      target.push(`Additional exclusions were omitted after the ${this.maximum}-entry limit.`);
      this.overflowReported = true;
    }
  }
}

/**
 * Converts bounded registry identity observations into exact GitHub records.
 * Registry metadata can nominate a repository/path, but only the GitHub adapter
 * supplies the public repository, immutable revision, artifact, and install evidence.
 */
export class RegistryToGitHubHydrationConnector<
  TObservation extends RegistryGitHubObservation,
> implements CatalogSourceConnector {
  readonly descriptor: CatalogSourceDescriptor;
  private readonly provider: RegistryGitHubPageProvider<TObservation>;
  private readonly githubToken: string;
  private readonly fetchImplementation?: typeof fetch;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly maxProviderRecords: number;
  private readonly maxRepositories: number;
  private readonly maxHydrations: number;
  private readonly maxPathsPerRepository: number;
  private readonly maxExclusions: number;
  private readonly githubMaxTreeEntries: number;
  private readonly githubMaxArtifactFiles: number;

  constructor(options: RegistryToGitHubConnectorOptions<TObservation>) {
    if (!options.githubToken.trim()) {
      throw new Error("Registry GitHub hydration requires a non-empty GitHub token");
    }
    this.descriptor = options.descriptor;
    this.provider = options.provider;
    this.githubToken = options.githubToken.trim();
    this.fetchImplementation = options.fetch;
    this.pageSize = boundedPositiveInteger(options.pageSize, DEFAULT_PAGE_SIZE, 100, "Page size");
    this.maxPages = boundedPositiveInteger(options.maxPages, DEFAULT_MAX_PAGES, 100, "Page limit");
    this.maxProviderRecords = boundedPositiveInteger(
      options.maxProviderRecords,
      DEFAULT_MAX_PROVIDER_RECORDS,
      10_000,
      "Provider record limit",
    );
    this.maxRepositories = boundedPositiveInteger(
      options.maxRepositories,
      DEFAULT_MAX_REPOSITORIES,
      1_000,
      "Repository limit",
    );
    this.maxHydrations = boundedPositiveInteger(
      options.maxHydrations,
      DEFAULT_MAX_HYDRATIONS,
      10_000,
      "Hydration limit",
    );
    this.maxPathsPerRepository = boundedPositiveInteger(
      options.maxPathsPerRepository,
      DEFAULT_MAX_PATHS_PER_REPOSITORY,
      256,
      "Per-repository path limit",
    );
    this.maxExclusions = boundedPositiveInteger(
      options.maxExclusions,
      DEFAULT_MAX_EXCLUSIONS,
      1_000,
      "Exclusion limit",
    );
    this.githubMaxTreeEntries = boundedPositiveInteger(
      options.githubMaxTreeEntries,
      50_000,
      50_000,
      "GitHub tree entry limit",
    );
    this.githubMaxArtifactFiles = boundedPositiveInteger(
      options.githubMaxArtifactFiles,
      512,
      512,
      "GitHub artifact file limit",
    );
  }

  async *enumerate(context: ConnectorContext): AsyncIterable<ConnectorPage> {
    const exclusions = new BoundedExclusions(this.maxExclusions);
    const seenSourceRecords = new Map<string, string>();
    const seenIdentities = new Set<string>();
    const seenRepositories = new Set<string>();
    const repositoryPathCounts = new Map<string, number>();
    let cursor = context.cursor;
    let pageCount = 0;
    let providerRecordCount = 0;
    let hydrationCount = 0;

    while (pageCount < this.maxPages) {
      const pageExclusions: string[] = [];
      let providerPage: RegistryGitHubProviderPage<TObservation>;
      try {
        providerPage = await this.provider.listPage({ cursor, limit: this.pageSize });
      } catch (error) {
        exclusions.add(
          pageExclusions,
          `Provider page at ${cursor ?? "the initial cursor"} was excluded (${safeError(error)}).`,
        );
        yield this.partialPage([], null, false, pageExclusions);
        return;
      }
      pageCount += 1;
      for (const exclusion of providerPage.exclusions ?? []) {
        exclusions.add(pageExclusions, exclusion);
      }

      const pageObservations = [...providerPage.observations];
      if (pageObservations.length > this.pageSize) {
        exclusions.add(
          pageExclusions,
          `Provider returned ${pageObservations.length} records above the ${this.pageSize}-record page limit; overflow records were excluded.`,
        );
        pageObservations.length = this.pageSize;
      }

      const remainingProviderRecords = this.maxProviderRecords - providerRecordCount;
      const providerCapReached = pageObservations.length > remainingProviderRecords;
      const boundedObservations = pageObservations.slice(0, Math.max(remainingProviderRecords, 0));
      providerRecordCount += boundedObservations.length;
      if (providerCapReached) {
        exclusions.add(
          pageExclusions,
          `Provider sweep stopped at the ${this.maxProviderRecords}-record limit.`,
        );
      }

      const uniqueObservations: TObservation[] = [];
      for (const observation of boundedObservations) {
        const priorIdentity = seenSourceRecords.get(observation.sourceRecordId);
        if (priorIdentity && priorIdentity !== observation.identity.canonicalKey) {
          exclusions.add(
            pageExclusions,
            `Provider record ${observation.sourceRecordId} conflicted with an earlier GitHub identity and was excluded.`,
          );
          continue;
        }
        if (priorIdentity || seenIdentities.has(observation.identity.canonicalKey)) {
          exclusions.add(
            pageExclusions,
            `Repeated provider identity ${observation.identity.canonicalKey} was deduplicated.`,
          );
          continue;
        }
        seenSourceRecords.set(observation.sourceRecordId, observation.identity.canonicalKey);
        seenIdentities.add(observation.identity.canonicalKey);
        if (!observation.hydrationEligible) {
          exclusions.add(
            pageExclusions,
            `${observation.sourceRecordId} was excluded (${observation.exclusionReason ?? "provider did not report hydratable content"}).`,
          );
          continue;
        }
        uniqueObservations.push(observation);
      }

      uniqueObservations.sort((left, right) =>
        left.sourceRecordId.localeCompare(right.sourceRecordId),
      );
      const remainingHydrations = this.maxHydrations - hydrationCount;
      const hydrationCapReached = uniqueObservations.length > remainingHydrations;
      const scheduled = uniqueObservations.slice(0, Math.max(remainingHydrations, 0));
      hydrationCount += scheduled.length;
      if (hydrationCapReached) {
        exclusions.add(
          pageExclusions,
          `Provider sweep stopped at the ${this.maxHydrations}-record GitHub hydration limit.`,
        );
      }

      const byRepository = new Map<string, TObservation[]>();
      let repositoryCapReached = false;
      for (const observation of scheduled) {
        const key = repositoryKey(observation.identity);
        if (!seenRepositories.has(key)) {
          if (seenRepositories.size >= this.maxRepositories) {
            repositoryCapReached = true;
            exclusions.add(
              pageExclusions,
              `${observation.identity.repositoryFullName} was excluded after the ${this.maxRepositories}-repository limit.`,
            );
            continue;
          }
          seenRepositories.add(key);
        }
        const priorPathCount = repositoryPathCounts.get(key) ?? 0;
        if (priorPathCount >= this.maxPathsPerRepository) {
          exclusions.add(
            pageExclusions,
            `${observation.identity.repositoryFullName} exceeded the ${this.maxPathsPerRepository}-path sweep limit; ${observation.identity.skillFilePath} was excluded.`,
          );
          continue;
        }
        repositoryPathCounts.set(key, priorPathCount + 1);
        const group = byRepository.get(key) ?? [];
        group.push(observation);
        byRepository.set(key, group);
      }

      const records: DiscoveredSkillRecord[] = [];
      for (const observations of byRepository.values()) {
        observations.sort((left, right) =>
          left.identity.skillFilePath.localeCompare(right.identity.skillFilePath),
        );
        records.push(
          ...(await this.hydrateRepository(observations, exclusions, pageExclusions)),
        );
      }
      records.sort((left, right) => left.sourceRecordId.localeCompare(right.sourceRecordId));

      const cursorInvalid =
        providerPage.hasMore &&
        (!providerPage.nextCursor || providerPage.nextCursor === cursor);
      if (cursorInvalid) {
        exclusions.add(
          pageExclusions,
          "Provider claimed another page without an advancing cursor; the sweep stopped.",
        );
      }
      const stop =
        providerCapReached ||
        hydrationCapReached ||
        repositoryCapReached ||
        cursorInvalid ||
        !providerPage.hasMore;
      const nextCursor = stop ? null : providerPage.nextCursor;
      yield this.partialPage(records, nextCursor, !stop, pageExclusions);
      if (stop) return;
      cursor = nextCursor;
    }

    yield this.partialPage(
      [],
      null,
      false,
      [`Provider sweep stopped at the ${this.maxPages}-page limit.`],
    );
  }

  private async hydrateRepository(
    observations: TObservation[],
    exclusions: BoundedExclusions,
    pageExclusions: string[],
  ): Promise<DiscoveredSkillRecord[]> {
    const first = observations[0];
    if (!first) return [];
    const expected = new Map(
      observations.map((observation) => [observation.identity.directoryPath, observation]),
    );
    const hydratedPaths = new Set<string>();
    const records: DiscoveredSkillRecord[] = [];

    try {
      const adapter = new GitHubPublicRepositoryAdapter({
        repositoryUrl: first.identity.repositoryUrl,
        token: this.githubToken,
        ...(this.fetchImplementation ? { fetch: this.fetchImplementation } : {}),
        manifestFilePaths: observations.map(
          (observation) => observation.identity.skillFilePath,
        ),
        maxHydratedManifests: observations.length,
        maxTreeEntries: this.githubMaxTreeEntries,
        maxArtifactFiles: this.githubMaxArtifactFiles,
      });
      let adapterPages = 0;
      for await (const page of adapter.enumerate({ cursor: null })) {
        adapterPages += 1;
        if (adapterPages > 1 || page.hasMore || page.nextCursor) {
          throw new Error("Exact GitHub repository hydration returned an unexpected page boundary");
        }
        for (const exclusion of page.exclusions ?? []) {
          exclusions.add(
            pageExclusions,
            `${first.identity.repositoryFullName}: ${exclusion}`,
          );
        }
        for (const candidate of page.records) {
          const record = candidate as DiscoveredSkillRecord;
          let normalizedPath: string;
          try {
            normalizedPath = normalizeSkillPath(record.skillPath);
          } catch (error) {
            exclusions.add(
              pageExclusions,
              `${first.identity.repositoryFullName}: hydrated an invalid skill path (${safeError(error)}).`,
            );
            continue;
          }
          const observation = expected.get(normalizedPath);
          if (!observation || hydratedPaths.has(normalizedPath)) {
            exclusions.add(
              pageExclusions,
              `${first.identity.repositoryFullName}/${normalizedPath}: unexpected or repeated hydration output was excluded.`,
            );
            continue;
          }
          hydratedPaths.add(normalizedPath);
          const exact = exactHydration(record, observation.identity);
          if (!exact.record) {
            exclusions.add(
              pageExclusions,
              `${observation.sourceRecordId} was excluded (${exact.reason ?? "exact hydration failed"}).`,
            );
            continue;
          }
          const raw: RegistryGitHubRawAttribution = registryGitHubRawAttributionSchema.parse({
            kind: "github-skill",
            repository: observation.identity.repositoryFullName,
            manifestPath: observation.identity.skillFilePath,
            commit: exact.record.immutableRef,
            discoveredBy: {
              sourceId: this.descriptor.id,
              sourceRecordId: observation.sourceRecordId,
            },
          });
          const categoryHints = boundedCategoryHints(observation.categoryHints);
          records.push({
            ...exact.record,
            sourceRecordId: observation.sourceRecordId,
            ...(categoryHints ? { categoryHints } : {}),
            raw,
          });
        }
      }
    } catch (error) {
      exclusions.add(
        pageExclusions,
        `${first.identity.repositoryFullName} hydration failed closed (${safeError(error)}).`,
      );
      return [];
    }

    for (const observation of observations) {
      if (!hydratedPaths.has(observation.identity.directoryPath)) {
        exclusions.add(
          pageExclusions,
          `${observation.sourceRecordId} was not present at its observed exact GitHub SKILL.md path.`,
        );
      }
    }
    return records;
  }

  private partialPage(
    records: DiscoveredSkillRecord[],
    nextCursor: string | null,
    hasMore: boolean,
    exclusions: string[],
  ): ConnectorPage {
    return {
      records,
      nextCursor,
      hasMore,
      reportedTotal: null,
      completeSnapshot: false,
      degraded: true,
      exclusions,
    };
  }
}
