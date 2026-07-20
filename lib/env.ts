import "server-only";

import { z } from "zod";

const optionalSecret = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(24).optional(),
);

const serverEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1).default("file:./data/aisle.db"),
  DATABASE_AUTH_TOKEN: z.string().min(1).optional(),
  CATALOG_SYNC_TOKEN: optionalSecret,
  SKILLS_SH_TOKEN: z.string().min(1).optional(),
});

const publicEnvironmentSchema = z.object({
  NEXT_PUBLIC_SITE_URL: z.url().default("http://localhost:3000"),
});

export const serverEnvironment = serverEnvironmentSchema.parse({
  NODE_ENV: process.env.NODE_ENV,
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_AUTH_TOKEN: process.env.DATABASE_AUTH_TOKEN,
  CATALOG_SYNC_TOKEN: process.env.CATALOG_SYNC_TOKEN,
  SKILLS_SH_TOKEN: process.env.SKILLS_SH_TOKEN,
});

export const publicEnvironment = publicEnvironmentSchema.parse({
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
});
