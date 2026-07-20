import { createCatalogDatabase } from "../lib/db/client";
import { CatalogRepository } from "../lib/db/repository";
import { seedCatalog } from "../lib/db/seed";

async function main(): Promise<void> {
  const connection = createCatalogDatabase();
  try {
    await seedCatalog(new CatalogRepository(connection.db));
    console.log("Catalog taxonomy and public source descriptors are seeded.");
  } finally {
    connection.client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
