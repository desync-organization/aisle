import "server-only";

import { z } from "zod";

const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.url().optional(),
);

const optionalSecret = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(24).optional(),
);

const serverEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: optionalUrl,
  CATALOG_SYNC_TOKEN: optionalSecret,
});

const publicEnvironmentSchema = z.object({
  NEXT_PUBLIC_SITE_URL: z.url().default("http://localhost:3000"),
});

export const serverEnvironment = serverEnvironmentSchema.parse({
  NODE_ENV: process.env.NODE_ENV,
  DATABASE_URL: process.env.DATABASE_URL,
  CATALOG_SYNC_TOKEN: process.env.CATALOG_SYNC_TOKEN,
});

export const publicEnvironment = publicEnvironmentSchema.parse({
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
});
