import "server-only";

import { z } from "zod";

const optionalSecret = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(24).optional(),
);

const optionalValue = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const optionalQueryList = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).max(2_048).optional(),
);

const explicitBoolean = z
  .preprocess(
    (value) => (value === undefined || value === "" ? "false" : value),
    z.enum(["true", "false"]),
  )
  .transform((value) => value === "true");

const serverEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1).default("file:./data/aisle.db"),
  DATABASE_AUTH_TOKEN: z.string().min(1).optional(),
  CATALOG_SYNC_TOKEN: optionalSecret,
  SKILLS_SH_OIDC_TOKEN: z.string().min(1).optional(),
  GITHUB_TOKEN: optionalValue,
  AISLE_AGENTSKILLS_IN_ENABLED: explicitBoolean,
  AISLE_ASKSKILL_ENABLED: explicitBoolean,
  AISLE_GETSKILLARY_ENABLED: explicitBoolean,
  AISLE_GITHUB_CODE_SEARCH_ENABLED: explicitBoolean,
  AISLE_GITHUB_CODE_SEARCH_QUERIES: optionalQueryList,
});

const publicEnvironmentSchema = z.object({
  NEXT_PUBLIC_SITE_URL: z.url().default("http://localhost:3000"),
});

export const serverEnvironment = serverEnvironmentSchema.parse({
  NODE_ENV: process.env.NODE_ENV,
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_AUTH_TOKEN: process.env.DATABASE_AUTH_TOKEN,
  CATALOG_SYNC_TOKEN: process.env.CATALOG_SYNC_TOKEN,
  SKILLS_SH_OIDC_TOKEN: process.env.SKILLS_SH_OIDC_TOKEN,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  AISLE_AGENTSKILLS_IN_ENABLED: process.env.AISLE_AGENTSKILLS_IN_ENABLED,
  AISLE_ASKSKILL_ENABLED: process.env.AISLE_ASKSKILL_ENABLED,
  AISLE_GETSKILLARY_ENABLED: process.env.AISLE_GETSKILLARY_ENABLED,
  AISLE_GITHUB_CODE_SEARCH_ENABLED: process.env.AISLE_GITHUB_CODE_SEARCH_ENABLED,
  AISLE_GITHUB_CODE_SEARCH_QUERIES: process.env.AISLE_GITHUB_CODE_SEARCH_QUERIES,
});

export const publicEnvironment = publicEnvironmentSchema.parse({
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
});
