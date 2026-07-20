import { createCatalogDatabase } from "../lib/db/client";
import { migrateCatalogDatabase } from "../lib/db/migrate";

async function main(): Promise<void> {
  const connection = createCatalogDatabase();
  try {
    await migrateCatalogDatabase(connection.client);
    console.log("Catalog database migrations are current.");
  } finally {
    connection.client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
