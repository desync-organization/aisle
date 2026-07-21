import { createHash } from "node:crypto";

import type {
  CatalogSourceConnector,
  ConnectorContext,
  ConnectorPage,
} from "../source-contract";
import {
  GITHUB_CODE_SEARCH_RESULT_CAP,
  GITHUB_CODE_SEARCH_MAX_PAGE_SIZE,
  composeGitHubCodeSearchQuery,
} from "./github-code-search-contract";
import {
  GitHubCodeSearchClient,
  type GitHubCodeSearchClientOptions,
  type GitHubCodeSearchResult,
} from "./github-code-search-client";
import {
  RegistryToGitHubHydrationConnector,
  type RegistryGitHubObservation,
  type RegistryGitHubPageProvider,
  type RegistryToGitHubConnectorOptions,
} from "./registry-github-hydrator";
import { githubCodeSearchSourceDescriptor } from "./wider-public-sources";

const FIXED_METADATA_QUERIES = ["name", "description"] as const;
const MAX_QUERY_COUNT = 8;
const MAX_CURSOR_LENGTH = 64;
const QUERY_CURSOR = /^round:([1-9]\d*):query:(0|[1-9]\d*):done:([0-9a-f]+)$/u;

type GitHubCodeSearchObservation = RegistryGitHubObservation;

interface QueryPosition {
  round: number;
  queryIndex: number;
  doneMask: number;
}

export interface GitHubCodeSearchConnectorOptions {
  enabled: boolean;
  githubToken?: string;
  queries?: readonly string[];
  client?: GitHubCodeSearchClient;
  clientOptions?: GitHubCodeSearchClientOptions;
  fetch?: typeof fetch;
  limits?: Omit<
    RegistryToGitHubConnectorOptions<GitHubCodeSearchObservation>,
    "descriptor" | "provider" | "githubToken" | "fetch"
  >;
}

function boundedQueries(configured: readonly string[] | undefined): string[] {
  if ((configured?.length ?? 0) > MAX_QUERY_COUNT - FIXED_METADATA_QUERIES.length) {
    throw new RangeError(
      `GitHub Code Search accepts at most ${MAX_QUERY_COUNT - FIXED_METADATA_QUERIES.length} additional discovery queries`,
    );
  }
  const unique = new Map<string, string>();
  for (const value of [...FIXED_METADATA_QUERIES, ...(configured ?? [])]) {
    const normalized = value.trim().replace(/\s+/gu, " ");
    if (!normalized) continue;
    composeGitHubCodeSearchQuery(normalized, 1, 1);
    unique.set(normalized.toLowerCase(), normalized);
  }
  const queries = [...unique.values()];
  if (queries.length > MAX_QUERY_COUNT) {
    throw new RangeError(
      `GitHub Code Search accepts at most ${MAX_QUERY_COUNT} distinct discovery queries`,
    );
  }
  return queries;
}

function allQueriesMask(queryCount: number): number {
  return (1 << queryCount) - 1;
}

function positionFromCursor(cursor: string | null, queryCount: number): QueryPosition {
  if (cursor === null) return { round: 1, queryIndex: 0, doneMask: 0 };
  if (cursor.length > MAX_CURSOR_LENGTH) {
    throw new Error("GitHub Code Search cursor exceeded its bounded length");
  }
  const match = QUERY_CURSOR.exec(cursor);
  const round = match ? Number(match[1]) : Number.NaN;
  const queryIndex = match ? Number(match[2]) : Number.NaN;
  const doneMask = match ? Number.parseInt(match[3] ?? "", 16) : Number.NaN;
  if (
    !Number.isSafeInteger(round) ||
    round < 1 ||
    round > GITHUB_CODE_SEARCH_RESULT_CAP ||
    !Number.isSafeInteger(queryIndex) ||
    queryIndex < 0 ||
    queryIndex >= queryCount ||
    !Number.isSafeInteger(doneMask) ||
    doneMask < 0 ||
    doneMask > allQueriesMask(queryCount) ||
    (doneMask & (1 << queryIndex)) !== 0
  ) {
    throw new Error("GitHub Code Search cursor was invalid; query sweeps cannot infer a position");
  }
  return { round, queryIndex, doneMask };
}

function nextPosition(
  current: QueryPosition,
  doneMask: number,
  queryCount: number,
): QueryPosition | null {
  if (doneMask === allQueriesMask(queryCount)) return null;
  for (let queryIndex = current.queryIndex + 1; queryIndex < queryCount; queryIndex += 1) {
    if ((doneMask & (1 << queryIndex)) === 0) {
      return { round: current.round, queryIndex, doneMask };
    }
  }
  for (let queryIndex = 0; queryIndex < queryCount; queryIndex += 1) {
    if ((doneMask & (1 << queryIndex)) === 0) {
      return { round: current.round + 1, queryIndex, doneMask };
    }
  }
  return null;
}

function encodeCursor(position: QueryPosition | null): string | null {
  if (!position) return null;
  return `round:${position.round}:query:${position.queryIndex}:done:${position.doneMask.toString(16)}`;
}

function stableSourceRecordId(result: GitHubCodeSearchResult): string {
  const identityDigest = createHash("sha256")
    .update(`${result.repositoryIdObservation}:${result.identity.canonicalKey}`)
    .digest("hex");
  return `github-code-search:${result.repositoryIdObservation}:${identityDigest}`;
}

class GitHubCodeSearchPageProvider
  implements RegistryGitHubPageProvider<GitHubCodeSearchObservation>
{
  constructor(
    private readonly client: GitHubCodeSearchClient,
    private readonly queries: readonly string[],
  ) {}

  async listPage(input: {
    cursor: string | null;
    limit: number;
  }): Promise<{
    observations: GitHubCodeSearchObservation[];
    nextCursor: string | null;
    hasMore: boolean;
    exclusions: string[];
  }> {
    const position = positionFromCursor(input.cursor, this.queries.length);
    const query = this.queries[position.queryIndex];
    if (!query) throw new Error("GitHub Code Search query position was unavailable");

    const page = await this.client.search(query, position.round, input.limit);
    if (
      page.pagination.nextPage !== null &&
      page.pagination.nextPage !== position.round + 1
    ) {
      throw new Error("GitHub Code Search returned a non-sequential page cursor");
    }

    const exclusions = [
      `GitHub query ${position.queryIndex + 1}/${this.queries.length} (${query}) reported ${page.coverage.reportedTotal} ranked results; this query-scoped count is not source-wide coverage.`,
    ];
    if (page.coverage.resultSetCapped) {
      exclusions.push(
        `GitHub query ${position.queryIndex + 1}/${this.queries.length} exceeded the ${GITHUB_CODE_SEARCH_RESULT_CAP}-result search cap.`,
      );
    }
    if (page.coverage.providerIncompleteResults) {
      exclusions.push(
        `GitHub marked query ${position.queryIndex + 1}/${this.queries.length} incomplete.`,
      );
    }
    if (page.pagination.stalledBeforeReachableEnd) {
      exclusions.push(
        `GitHub query ${position.queryIndex + 1}/${this.queries.length} stalled before its reachable result window ended.`,
      );
    }

    let doneMask = position.doneMask;
    if (page.pagination.nextPage === null) {
      doneMask |= 1 << position.queryIndex;
    }
    const next = nextPosition(position, doneMask, this.queries.length);
    return {
      observations: page.results.map((result) => ({
        sourceRecordId: stableSourceRecordId(result),
        identity: result.identity,
        hydrationEligible: true,
      })),
      nextCursor: encodeCursor(next),
      hasMore: next !== null,
      exclusions,
    };
  }
}

export class GitHubCodeSearchConnector implements CatalogSourceConnector {
  readonly descriptor;
  private readonly connector: RegistryToGitHubHydrationConnector<GitHubCodeSearchObservation> | null;

  constructor(options: GitHubCodeSearchConnectorOptions) {
    const githubToken = options.githubToken?.trim() ?? "";
    const configured = options.enabled && Boolean(githubToken);
    const configurationExclusions = configured
      ? []
      : [
          options.enabled
            ? "GitHub Code Search synchronization was opted in, but GITHUB_TOKEN was missing; no records were claimed."
            : "GitHub Code Search synchronization is disabled until AISLE_GITHUB_CODE_SEARCH_ENABLED=true is explicitly configured.",
        ];
    this.descriptor = {
      ...githubCodeSearchSourceDescriptor,
      enabled: configured,
      initialCoverageState: configured ? "not-synced" : "not-configured",
      knownExclusions: [
        ...(githubCodeSearchSourceDescriptor.knownExclusions ?? []),
        ...configurationExclusions,
      ],
    };
    if (!configured) {
      this.connector = null;
      return;
    }

    const queries = boundedQueries(options.queries);
    const client =
      options.client ??
      new GitHubCodeSearchClient({
        ...(options.clientOptions ?? {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        tokenProvider: async () => githubToken,
      });
    this.connector = new RegistryToGitHubHydrationConnector({
      descriptor: this.descriptor,
      provider: new GitHubCodeSearchPageProvider(client, queries),
      githubToken,
      pageSize: GITHUB_CODE_SEARCH_MAX_PAGE_SIZE,
      maxPages: Math.min(queries.length * 10, 100),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.limits ?? {}),
    });
  }

  enumerate(context: ConnectorContext): AsyncIterable<ConnectorPage> {
    if (!this.connector) {
      throw new Error("Disabled GitHub Code Search connectors must not be enumerated");
    }
    return this.connector.enumerate(context);
  }
}
