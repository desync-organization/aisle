import { ClawHubAdapter } from "../lib/catalog/adapters/clawhub";
import { GitHubPublicRepositoryAdapter } from "../lib/catalog/adapters/github-public";
import { providerApprovedRegistryStubs } from "../lib/catalog/adapters/registry-stubs";
import { SkillMdAdapter } from "../lib/catalog/adapters/skillmd";
import { WellKnownSkillsAdapter } from "../lib/catalog/adapters/well-known";
import { SkillsShClient } from "../lib/catalog/connectors/skills-sh-client";
import { SkillsShSync } from "../lib/catalog/connectors/skills-sh-sync";
import { CatalogIngestionService } from "../lib/catalog/ingestion";
import { isVerifiedOfficialPublisher } from "../lib/catalog/official-publishers";
import { normalizeSourceUrl } from "../lib/catalog/normalization";
import { CatalogSyncOrchestrator } from "../lib/catalog/orchestrator";
import { createAgentSkillValidator } from "../lib/catalog/security";
import type { CatalogSourceConnector } from "../lib/catalog/source-contract";
import { createCatalogDatabase } from "../lib/db/client";
import { migrateCatalogDatabase } from "../lib/db/migrate";
import { CatalogRepository } from "../lib/db/repository";
import { seedCatalog } from "../lib/db/seed";
import { launchPackageRepositoryUrls } from "../lib/packages/launch-blueprints";

function configuredValues(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function configuredGithubRepositories(): string[] {
  const repositories = [
    ...launchPackageRepositoryUrls,
    ...configuredValues("AISLE_GITHUB_REPOSITORIES"),
  ];
  return [...new Map(
    repositories.map((repositoryUrl) => {
      const normalized = normalizeSourceUrl(repositoryUrl);
      return [normalized, normalized] as const;
    }),
  ).values()];
}

async function main(): Promise<void> {
  const connection = createCatalogDatabase();
  try {
    await migrateCatalogDatabase(connection.client);
    const repository = new CatalogRepository(connection.db);
    await seedCatalog(repository);
    const validator = createAgentSkillValidator();
    const ingestion = new CatalogIngestionService(
      repository,
      validator,
      isVerifiedOfficialPublisher,
    );
    const connectors: CatalogSourceConnector[] = [
      new ClawHubAdapter(),
      new SkillMdAdapter({ githubToken: process.env.GITHUB_TOKEN }),
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
    const settle = async (operation: () => Promise<unknown>): Promise<PromiseSettledResult<unknown>> => {
      try {
        return { status: "fulfilled", value: await operation() };
      } catch (reason) {
        return { status: "rejected", reason };
      }
    };
    const skillsSh = await settle(() =>
      new SkillsShSync(repository, new SkillsShClient(), { ingestion }).run(),
    );
    const sources = await settle(() =>
      new CatalogSyncOrchestrator(repository, {
        validateRecord: validator,
        officialPublisherPolicy: isVerifiedOfficialPublisher,
      }).sync(connectors),
    );
    const normalize = (result: PromiseSettledResult<unknown>) =>
      result.status === "fulfilled"
        ? { status: "fulfilled", value: result.value }
        : {
            status: "rejected",
            reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
          };
    console.log(
      JSON.stringify({ skillsSh: normalize(skillsSh), sources: normalize(sources) }, null, 2),
    );
  } finally {
    connection.client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
