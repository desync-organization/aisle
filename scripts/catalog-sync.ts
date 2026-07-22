import { AgentSkillsInConnector } from "../lib/catalog/adapters/agentskills-in";
import { AskSkillConnector } from "../lib/catalog/adapters/askskill";
import { ClawHubAdapter } from "../lib/catalog/adapters/clawhub";
import { GetSkillaryConnector } from "../lib/catalog/adapters/getskillary";
import { GitHubCodeSearchConnector } from "../lib/catalog/adapters/github-code-search";
import { GitHubPublicRepositoryAdapter } from "../lib/catalog/adapters/github-public";
import { providerApprovedRegistryStubs } from "../lib/catalog/adapters/registry-stubs";
import { SkillMdAdapter } from "../lib/catalog/adapters/skillmd";
import { SkillsReConnector } from "../lib/catalog/adapters/skills-re";
import { WellKnownSkillsAdapter } from "../lib/catalog/adapters/well-known";
import { SkillsShClient } from "../lib/catalog/connectors/skills-sh-client";
import { SkillsShSync } from "../lib/catalog/connectors/skills-sh-sync";
import { CatalogIngestionService } from "../lib/catalog/ingestion";
import { isVerifiedOfficialPublisher } from "../lib/catalog/official-publishers";
import { normalizeSourceUrl } from "../lib/catalog/normalization";
import { CatalogSyncOrchestrator } from "../lib/catalog/orchestrator";
import { defaultPublicGitHubRepositoryUrls } from "../lib/catalog/public-repository-seeds";
import { createAgentSkillValidator } from "../lib/catalog/security";
import type { CatalogSourceConnector } from "../lib/catalog/source-contract";
import { createCatalogDatabase } from "../lib/db/client";
import { migrateCatalogDatabase } from "../lib/db/migrate";
import { CatalogRepository } from "../lib/db/repository";
import { seedCatalog } from "../lib/db/seed";
import { launchPackageRepositoryUrls } from "../lib/packages/launch-blueprints";

type CatalogSyncCliOptions = {
  listSources: boolean;
  listFormat: "json" | "lines";
  sourceId: string | null;
};

type RunnableSource = {
  id: string;
  run: () => Promise<unknown>;
};

type NormalizedSourceResult =
  | { status: "fulfilled"; value: unknown }
  | { status: "rejected"; reason: string };

function isOperationalFailure(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("status" in value)) return false;
  const result = value as { status?: unknown; processed?: unknown };
  if (result.status === "credentials-required") return true;
  // Several federated sources are deliberately non-retiring and therefore
  // report partial coverage after a useful sweep. Treat a zero-progress
  // partial as the operational failure; timeouts still fail in the workflow.
  return result.status === "partial" && result.processed === 0;
}

function readOptionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseCliOptions(args: readonly string[]): CatalogSyncCliOptions {
  let listSources = false;
  let listFormat: CatalogSyncCliOptions["listFormat"] = "json";
  let sourceId: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--list-sources") {
      listSources = true;
      continue;
    }
    if (argument === "--source") {
      if (sourceId !== null) throw new Error("--source may only be specified once");
      sourceId = readOptionValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument.startsWith("--source=")) {
      if (sourceId !== null) throw new Error("--source may only be specified once");
      sourceId = argument.slice("--source=".length).trim();
      if (!sourceId) throw new Error("--source requires a value");
      continue;
    }
    if (argument === "--format") {
      const value = readOptionValue(args, index, argument);
      if (value !== "json" && value !== "lines") {
        throw new Error("--format must be json or lines");
      }
      listFormat = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown catalog sync option: ${argument}`);
  }

  if (!listSources && listFormat !== "json") {
    throw new Error("--format is only valid with --list-sources");
  }
  if (listSources && sourceId !== null) {
    throw new Error("--list-sources cannot be combined with --source");
  }

  return { listSources, listFormat, sourceId };
}

function configuredValues(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function configuredGithubRepositories(): string[] {
  const repositories = [
    ...launchPackageRepositoryUrls,
    ...defaultPublicGitHubRepositoryUrls,
    ...configuredValues("AISLE_GITHUB_REPOSITORIES"),
  ];
  return [...new Map(
    repositories.map((repositoryUrl) => {
      const normalized = normalizeSourceUrl(repositoryUrl);
      return [normalized, normalized] as const;
    }),
  ).values()];
}

function explicitlyEnabled(name: string): boolean {
  const value = (process.env[name] ?? "false").trim().toLowerCase();
  if (value !== "true" && value !== "false") {
    throw new Error(`${name} must be explicitly set to true or false`);
  }
  return value === "true";
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const connection = createCatalogDatabase();
  try {
    const repository = new CatalogRepository(connection.db);
    const validator = createAgentSkillValidator();
    const ingestion = new CatalogIngestionService(
      repository,
      validator,
      isVerifiedOfficialPublisher,
    );
    const connectors: CatalogSourceConnector[] = [
      new ClawHubAdapter(),
      new SkillMdAdapter({ githubToken: process.env.GITHUB_TOKEN }),
      new AgentSkillsInConnector({
        enabled: explicitlyEnabled("AISLE_AGENTSKILLS_IN_ENABLED"),
        githubToken: process.env.GITHUB_TOKEN,
      }),
      new AskSkillConnector({
        enabled: explicitlyEnabled("AISLE_ASKSKILL_ENABLED"),
        githubToken: process.env.GITHUB_TOKEN,
      }),
      new GetSkillaryConnector({
        enabled: explicitlyEnabled("AISLE_GETSKILLARY_ENABLED"),
      }),
      new SkillsReConnector({
        enabled: explicitlyEnabled("AISLE_SKILLS_RE_ENABLED"),
      }),
      new GitHubCodeSearchConnector({
        enabled: explicitlyEnabled("AISLE_GITHUB_CODE_SEARCH_ENABLED"),
        githubToken: process.env.GITHUB_TOKEN,
        queries: configuredValues("AISLE_GITHUB_CODE_SEARCH_QUERIES"),
      }),
      ...providerApprovedRegistryStubs,
      ...configuredValues("AISLE_WELL_KNOWN_ORIGINS").map((origin, _index, origins) =>
        new WellKnownSkillsAdapter({ origin, adminApprovedOrigins: origins }),
      ),
      ...configuredGithubRepositories().map(
        (repositoryUrl) =>
          new GitHubPublicRepositoryAdapter({
            repositoryUrl,
            token: process.env.GITHUB_TOKEN,
          }),
      ),
    ];

    const orchestrator = new CatalogSyncOrchestrator(repository, {
      validateRecord: validator,
      officialPublisherPolicy: isVerifiedOfficialPublisher,
    });
    const runnableSources: RunnableSource[] = [
      {
        id: "skills-sh",
        run: () => new SkillsShSync(repository, new SkillsShClient(), { ingestion }).run(),
      },
      ...connectors.map((connector) => ({
        id: connector.descriptor.id,
        run: () => orchestrator.syncConnector(connector),
      })),
    ];
    const sourceIds = runnableSources.map(({ id }) => id);
    const duplicateSourceIds = sourceIds.filter(
      (sourceId, index) => sourceIds.indexOf(sourceId) !== index,
    );
    if (duplicateSourceIds.length > 0) {
      throw new Error(`Duplicate catalog source IDs: ${[...new Set(duplicateSourceIds)].join(", ")}`);
    }

    if (options.listSources) {
      console.log(
        options.listFormat === "lines" ? sourceIds.join("\n") : JSON.stringify(sourceIds),
      );
      return;
    }

    const selectedSources = options.sourceId === null
      ? runnableSources
      : runnableSources.filter(({ id }) => id === options.sourceId);
    if (selectedSources.length === 0) {
      throw new Error(
        `Unknown catalog source ${JSON.stringify(options.sourceId)}. Available sources: ${sourceIds.join(", ")}`,
      );
    }

    await migrateCatalogDatabase(connection.client);
    await seedCatalog(repository);

    const settle = async (
      operation: () => Promise<unknown>,
    ): Promise<PromiseSettledResult<unknown>> => {
      try {
        return { status: "fulfilled", value: await operation() };
      } catch (reason) {
        return { status: "rejected", reason };
      }
    };
    const normalize = (result: PromiseSettledResult<unknown>): NormalizedSourceResult =>
      result.status === "fulfilled"
        ? { status: "fulfilled", value: result.value }
        : {
            status: "rejected",
            reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
          };
    const results = [];
    for (const source of selectedSources) {
      results.push({ sourceId: source.id, ...normalize(await settle(source.run)) });
    }
    console.log(
      JSON.stringify({ results }, null, 2),
    );
    if (
      options.sourceId !== null &&
      results.some((result) =>
        result.status === "rejected" ||
        (result.status === "fulfilled" && isOperationalFailure(result.value))
      )
    ) {
      process.exitCode = 1;
    }
  } finally {
    connection.client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
