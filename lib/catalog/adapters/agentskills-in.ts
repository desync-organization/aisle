import type {
  CatalogSourceConnector,
  ConnectorContext,
  ConnectorPage,
} from "../source-contract";
import { AgentSkillsInClient } from "./agentskills-in-client";
import type { AgentSkillsInClientOptions } from "./agentskills-in-client";
import {
  RegistryToGitHubHydrationConnector,
  type RegistryGitHubObservation,
  type RegistryGitHubPageProvider,
  type RegistryToGitHubConnectorOptions,
} from "./registry-github-hydrator";
import { agentSkillsInSourceDescriptor } from "./wider-public-sources";

const OFFSET_CURSOR = /^offset:(0|[1-9]\d*)$/u;
const SOURCE_RECORD_PREFIX = "agentskills-in:";

type AgentSkillsInObservation = RegistryGitHubObservation;

export interface AgentSkillsInConnectorOptions {
  enabled: boolean;
  githubToken?: string;
  client?: AgentSkillsInClient;
  clientOptions?: AgentSkillsInClientOptions;
  fetch?: typeof fetch;
  limits?: Omit<
    RegistryToGitHubConnectorOptions<AgentSkillsInObservation>,
    "descriptor" | "provider" | "githubToken" | "fetch"
  >;
}

function offsetFromCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  const match = OFFSET_CURSOR.exec(cursor);
  const parsed = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("AgentSkills.in cursor was invalid; mutable sweeps cannot infer an offset");
  }
  return parsed;
}

function boundedCategory(value: string | null): string[] {
  if (!value) return [];
  const normalized = value.trim().slice(0, 128);
  return normalized ? [normalized] : [];
}

function stableSourceRecordId(providerRecordId: string): string {
  const trimmed = providerRecordId.trim();
  if (!trimmed || trimmed.length > 512 || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new Error("AgentSkills.in returned an invalid provider record identifier");
  }
  return `${SOURCE_RECORD_PREFIX}${trimmed}`;
}

class AgentSkillsInPageProvider
  implements RegistryGitHubPageProvider<AgentSkillsInObservation>
{
  constructor(private readonly client: AgentSkillsInClient) {}

  async listPage(input: {
    cursor: string | null;
    limit: number;
  }): Promise<{
    observations: AgentSkillsInObservation[];
    nextCursor: string | null;
    hasMore: boolean;
    exclusions: string[];
  }> {
    const offset = offsetFromCursor(input.cursor);
    const page = await this.client.listSkills(offset, input.limit);
    const exclusions = [
      `AgentSkills.in reported ${page.pagination.reportedTotal} records at offset ${offset}; this mutable total is an observation, not a completeness proof.`,
    ];
    if (page.pagination.stalledBeforeReportedEnd) {
      exclusions.push(
        `AgentSkills.in returned an empty page before its reported total at offset ${offset}.`,
      );
    }
    return {
      observations: page.skills.map((skill) => ({
        sourceRecordId: stableSourceRecordId(skill.providerRecordId),
        identity: skill.identity,
        categoryHints: {
          categories: boundedCategory(skill.category),
          tags: [],
        },
        hydrationEligible: skill.contentReportedAvailable !== false,
        ...(skill.contentReportedAvailable === false
          ? { exclusionReason: "provider reported that content is unavailable" }
          : {}),
      })),
      nextCursor:
        page.pagination.nextOffset === null
          ? null
          : `offset:${page.pagination.nextOffset}`,
      hasMore: page.pagination.hasMore,
      exclusions,
    };
  }
}

export class AgentSkillsInConnector implements CatalogSourceConnector {
  readonly descriptor;
  private readonly connector: RegistryToGitHubHydrationConnector<AgentSkillsInObservation> | null;

  constructor(options: AgentSkillsInConnectorOptions) {
    const githubToken = options.githubToken?.trim() ?? "";
    const configured = options.enabled && Boolean(githubToken);
    const configurationExclusions = configured
      ? []
      : [
          options.enabled
            ? "AgentSkills.in synchronization was opted in, but GITHUB_TOKEN was missing; no records were claimed."
            : "AgentSkills.in synchronization is disabled until AISLE_AGENTSKILLS_IN_ENABLED=true is explicitly configured.",
        ];
    this.descriptor = {
      ...agentSkillsInSourceDescriptor,
      enabled: configured,
      initialCoverageState: configured ? "not-synced" : "not-configured",
      knownExclusions: [
        ...(agentSkillsInSourceDescriptor.knownExclusions ?? []),
        ...configurationExclusions,
      ],
    };
    if (!configured) {
      this.connector = null;
      return;
    }

    const client =
      options.client ??
      new AgentSkillsInClient({
        ...(options.clientOptions ?? {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    this.connector = new RegistryToGitHubHydrationConnector({
      descriptor: this.descriptor,
      provider: new AgentSkillsInPageProvider(client),
      githubToken,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.limits ?? {}),
    });
  }

  enumerate(context: ConnectorContext): AsyncIterable<ConnectorPage> {
    if (!this.connector) {
      throw new Error("Disabled AgentSkills.in connectors must not be enumerated");
    }
    return this.connector.enumerate(context);
  }
}
