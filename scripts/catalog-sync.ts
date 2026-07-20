import { SkillsShClient } from "../lib/catalog/connectors/skills-sh-client";
import { SkillsShSync } from "../lib/catalog/connectors/skills-sh-sync";
import { createCatalogDatabase } from "../lib/db/client";
import { migrateCatalogDatabase } from "../lib/db/migrate";
import { CatalogRepository } from "../lib/db/repository";
import { seedCatalog } from "../lib/db/seed";

async function main(): Promise<void> {
  const connection = createCatalogDatabase();
  try {
    await migrateCatalogDatabase(connection.client);
    const repository = new CatalogRepository(connection.db);
    await seedCatalog(repository);
    const result = await new SkillsShSync(repository, new SkillsShClient()).run();
    console.log(JSON.stringify(result, null, 2));
  } finally {
    connection.client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
