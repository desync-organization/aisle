import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { createCatalogDatabase } from "@/lib/db/client";

import { collectionSlugSchema, type PublicCollection } from "./contracts";
import { findPublicCollection } from "./repository";

export async function loadPublicCollection(slug: string): Promise<PublicCollection | null> {
  const parsed = collectionSlugSchema.safeParse(slug);
  const hasDatabase = Boolean(process.env.DATABASE_URL) || existsSync(resolve(process.cwd(), "data", "aisle.db"));
  if (!parsed.success || !hasDatabase) return null;

  const connection = createCatalogDatabase();
  try {
    return await findPublicCollection(connection.db, parsed.data);
  } finally {
    connection.client.close();
  }
}
