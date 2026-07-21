import type {
  CatalogSourceConnector,
  ConnectorContext,
  ConnectorPage,
} from "../source-contract";
import { AskSkillClient } from "./askskill-client";
import type { AskSkillClientOptions } from "./askskill-client";
import {
  RegistryToGitHubHydrationConnector,
  type RegistryGitHubObservation,
  type RegistryGitHubPageProvider,
  type RegistryToGitHubConnectorOptions,
} from "./registry-github-hydrator";
import { askSkillSourceDescriptor } from "./wider-public-sources";

const PAGE_CURSOR = /^page:([1-9]\d*)$/u;
const SOURCE_RECORD_PREFIX = "askskill:";
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

type AskSkillObservation = RegistryGitHubObservation;

export interface AskSkillConnectorOptions {
  enabled: boolean;
  githubToken?: string;
  client?: AskSkillClient;
  clientOptions?: AskSkillClientOptions;
  fetch?: typeof fetch;
  limits?: Omit<
    RegistryToGitHubConnectorOptions<AskSkillObservation>,
    "descriptor" | "provider" | "githubToken" | "fetch"
  >;
}

function pageFromCursor(cursor: string | null): number {
  if (cursor === null) return 1;
  const match = PAGE_CURSOR.exec(cursor);
  const parsed = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("AskSkill cursor was invalid; mutable page sweeps cannot infer a position");
  }
  return parsed;
}

function stableSourceRecordId(providerRecordId: string): string {
  const trimmed = providerRecordId.trim();
  if (!trimmed || trimmed.length > 512 || CONTROL_CHARACTER_PATTERN.test(trimmed)) {
    throw new Error("AskSkill returned an invalid provider record identifier");
  }
  return `${SOURCE_RECORD_PREFIX}${trimmed}`;
}

class AskSkillPageProvider implements RegistryGitHubPageProvider<AskSkillObservation> {
  constructor(private readonly client: AskSkillClient) {}

  async listPage(input: {
    cursor: string | null;
    limit: number;
  }): Promise<{
    observations: AskSkillObservation[];
    nextCursor: string | null;
    hasMore: boolean;
    exclusions: string[];
  }> {
    const requestedPage = pageFromCursor(input.cursor);
    const page = await this.client.listSkills(requestedPage, input.limit);
    const exclusions = [
      `AskSkill reported ${page.pagination.reportedTotal} records across ${page.pagination.reportedTotalPages} pages at page ${requestedPage}; mutable provider totals are observations, not source-wide completeness proof.`,
    ];
    if (page.pagination.totalIsEstimate) {
      exclusions.push("AskSkill marked its total as estimated.");
    }
    if (page.pagination.pageWindowLimited) {
      exclusions.push(
        "AskSkill marked its reachable page window as limited; records outside that window were not observed.",
      );
    }
    if (page.pagination.reachableWindowExhausted && page.pagination.hasMore) {
      exclusions.push(
        `AskSkill still reported more records when the reachable page window ended at page ${requestedPage}.`,
      );
    }

    const nextPage = page.pagination.nextPage;
    return {
      observations: page.skills.map((skill) => ({
        sourceRecordId: stableSourceRecordId(skill.providerRecordId),
        identity: skill.identity,
        categoryHints: {
          categories: [],
          tags: skill.tags,
        },
        hydrationEligible: true,
      })),
      nextCursor: nextPage === null ? null : `page:${nextPage}`,
      hasMore: nextPage !== null,
      exclusions,
    };
  }
}

export class AskSkillConnector implements CatalogSourceConnector {
  readonly descriptor;
  private readonly connector: RegistryToGitHubHydrationConnector<AskSkillObservation> | null;

  constructor(options: AskSkillConnectorOptions) {
    const githubToken = options.githubToken?.trim() ?? "";
    const configured = options.enabled && Boolean(githubToken);
    const configurationExclusions = configured
      ? []
      : [
          options.enabled
            ? "AskSkill synchronization was opted in, but GITHUB_TOKEN was missing; no records were claimed."
            : "AskSkill synchronization is disabled until AISLE_ASKSKILL_ENABLED=true is explicitly configured.",
        ];
    this.descriptor = {
      ...askSkillSourceDescriptor,
      enabled: configured,
      initialCoverageState: configured ? "not-synced" : "not-configured",
      knownExclusions: [
        ...(askSkillSourceDescriptor.knownExclusions ?? []),
        ...configurationExclusions,
      ],
    };
    if (!configured) {
      this.connector = null;
      return;
    }

    const client =
      options.client ??
      new AskSkillClient({
        ...(options.clientOptions ?? {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    this.connector = new RegistryToGitHubHydrationConnector({
      descriptor: this.descriptor,
      provider: new AskSkillPageProvider(client),
      githubToken,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.limits ?? {}),
    });
  }

  enumerate(context: ConnectorContext): AsyncIterable<ConnectorPage> {
    if (!this.connector) {
      throw new Error("Disabled AskSkill connectors must not be enumerated");
    }
    return this.connector.enumerate(context);
  }
}
