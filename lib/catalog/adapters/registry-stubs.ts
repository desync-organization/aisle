import type {
  CatalogSourceConnector,
  ConnectorContext,
  ConnectorPage,
} from "../source-contract";

class ProviderApprovedStub implements CatalogSourceConnector {
  constructor(readonly descriptor: CatalogSourceConnector["descriptor"]) {}

  async *enumerate(context: ConnectorContext): AsyncIterable<ConnectorPage> {
    void context;
    yield {
      records: [],
      nextCursor: null,
      hasMore: false,
      reportedTotal: null,
      completeSnapshot: false,
      exclusions: this.descriptor.knownExclusions ?? [],
    };
  }
}

export const providerApprovedRegistryStubs: CatalogSourceConnector[] = [
  new ProviderApprovedStub({
    id: "skillmd",
    name: "SkillMD",
    baseUrl: "https://skillmd.com",
    mode: "federated",
    upstreamIdentifier: "SkillMD public registry",
    termsUrl: "https://skillmd.com",
    enabled: false,
    initialCoverageState: "not-configured",
    knownExclusions: [
      "No provider-approved enumerable HTTP catalog contract is configured; Aisle does not scrape the website or MCP transport.",
    ],
  }),
  new ProviderApprovedStub({
    id: "skillsmp",
    name: "SkillsMP",
    baseUrl: "https://skillsmp.com/api/v1/skills/search",
    mode: "federated",
    upstreamIdentifier: "SkillsMP documented search API",
    termsUrl: "https://skillsmp.com/docs/api",
    enabled: false,
    initialCoverageState: "not-configured",
    knownExclusions: [
      "The documented API requires a search query and rejects wildcard enumeration, so only future labeled federated searches are eligible.",
    ],
  }),
];
