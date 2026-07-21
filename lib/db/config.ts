import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { z } from "zod";

const databaseConfigSchema = z
  .object({
    url: z.string().min(1),
    authToken: z.string().min(1).optional(),
  })
  .superRefine((value, context) => {
    if (/^(libsql|https):\/\//.test(value.url) && !value.authToken) {
      context.addIssue({
        code: "custom",
        message: "DATABASE_AUTH_TOKEN is required for hosted libSQL URLs",
        path: ["authToken"],
      });
    }
  });

export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;

export function resolveDatabaseConfig(
  environment: Record<string, string | undefined> = process.env,
): DatabaseConfig {
  return databaseConfigSchema.parse({
    url: environment.DATABASE_URL || "file:./data/aisle.db",
    authToken: environment.DATABASE_AUTH_TOKEN || undefined,
  });
}

export function ensureLocalDatabaseDirectory(url: string): void {
  if (!url.startsWith("file:") || url === "file::memory:") {
    return;
  }

  const filename = url.slice("file:".length).split("?")[0];
  if (!filename || filename === ":memory:") {
    return;
  }

  mkdirSync(dirname(resolve(filename)), { recursive: true });
}
