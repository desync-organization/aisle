import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";

import { ensureLocalDatabaseDirectory, resolveDatabaseConfig, type DatabaseConfig } from "./config";
import { schema } from "./schema";

export type CatalogDatabase = LibSQLDatabase<typeof schema>;

export interface CatalogDatabaseConnection {
  client: Client;
  db: CatalogDatabase;
}

export function createCatalogDatabase(
  config: DatabaseConfig = resolveDatabaseConfig(),
): CatalogDatabaseConnection {
  ensureLocalDatabaseDirectory(config.url);
  const client = createClient({
    url: config.url,
    authToken: config.authToken,
  });

  return {
    client,
    db: drizzle(client, { schema }),
  };
}

const sharedDatabase = globalThis as typeof globalThis & {
  __aisleCatalogDatabase?: CatalogDatabaseConnection;
};

/** Reuse the read client across warm server invocations and development HMR. */
export function getSharedCatalogDatabase(): CatalogDatabaseConnection {
  sharedDatabase.__aisleCatalogDatabase ??= createCatalogDatabase();
  return sharedDatabase.__aisleCatalogDatabase;
}
