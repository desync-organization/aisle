import { fileURLToPath } from "node:url";

import type { Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

const defaultMigrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function migrateCatalogDatabase(
  client: Client,
  migrationsFolder = defaultMigrationsFolder,
): Promise<void> {
  await migrate(drizzle(client), { migrationsFolder });
}
