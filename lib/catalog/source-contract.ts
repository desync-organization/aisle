import { z } from "zod";

import {
  sourceFreshnessPolicies,
  sourceModes,
} from "../db/schema";
import { persistedSkillRawSchema } from "./provider-raw";

export const installSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("source"),
    sourceUrl: z.url(),
    immutableRef: z.string().min(1),
    skillPath: z.string().min(1),
  }),
  z.object({
    kind: z.literal("registry"),
    registry: z.string().min(1),
    identifier: z.string().min(1),
    version: z.string().min(1),
  }),
]);

const sourceCategoryHintSchema = z.string().trim().min(1).max(128);
const sourceTagHintSchema = z.string().trim().min(1).max(64);
export const DISCOVERED_SKILL_NAME_MAX_LENGTH = 256;
export const DISCOVERED_SKILL_DESCRIPTION_MAX_LENGTH = 4_096;
export const DISCOVERED_SKILL_PATH_MAX_LENGTH = 4_096;

export const discoveredSkillRecordSchema = z.object({
  sourceRecordId: z.string().min(1),
  provider: z.string().min(1),
  sourceType: z.string().min(1),
  sourceUrl: z.url(),
  skillPath: z.string().min(1).max(DISCOVERED_SKILL_PATH_MAX_LENGTH),
  upstreamName: z.string().min(1).max(DISCOVERED_SKILL_NAME_MAX_LENGTH).nullable(),
  upstreamDescription: z
    .string()
    .min(1)
    .max(DISCOVERED_SKILL_DESCRIPTION_MAX_LENGTH)
    .nullable(),
  categoryHints: z
    .object({
      categories: z.array(sourceCategoryHintSchema).max(16),
      tags: z.array(sourceTagHintSchema).max(32),
    })
    .optional(),
  compatibility: z.string().min(1).nullable().optional(),
  license: z.string().min(1).nullable().optional(),
  installUrl: z.url().nullable(),
  installSpec: installSpecSchema.nullable().default(null),
  immutableRef: z.string().min(1).nullable(),
  contentHash: z.string().min(1).nullable(),
  upstreamHash: z.string().min(1).nullable().optional(),
  public: z.boolean(),
  internal: z.boolean(),
  aliases: z.array(z.string().min(1)).default([]),
  repository: z
    .object({
      provider: z.string().min(1),
      url: z.url(),
      owner: z.string().min(1).nullable(),
      name: z.string().min(1).nullable(),
      visibility: z.literal("public"),
      defaultBranch: z.string().min(1).nullable(),
    })
    .nullable()
    .default(null),
  repositoryLicenseEvidence: z
    .object({
      path: z.string().min(1).max(256),
      contents: z.string().max(262_144),
      sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
      sourceUrl: z.url(),
      immutableRef: z.string().min(1).max(256),
    })
    .nullable()
    .optional(),
  artifact: z
    .object({
      type: z.enum(["skill-md", "archive"]),
      contents: z.string().optional(),
      complete: z.boolean().default(false),
      textFiles: z
        .array(
          z.object({
            path: z.string().min(1),
            contents: z.string(),
            sha256: z.string().min(1),
          }),
        )
        .optional(),
      files: z
        .array(
          z.object({
            path: z.string().min(1),
            type: z.string().min(1),
            mode: z.string().min(1).optional(),
            size: z.number().int().nonnegative().optional(),
            sha: z.string().min(1).optional(),
          }),
        )
        .optional(),
    })
    .nullable()
    .default(null),
  raw: persistedSkillRawSchema,
}).superRefine((record, context) => {
  const expectedKind = record.provider === "skills-sh"
    ? "skills-sh-skill"
    : record.provider === "clawhub"
      ? "clawhub-skill"
      : record.provider === "skillmd"
        ? "skillmd-skill"
        : record.provider === "github"
          ? "github-skill"
          : record.provider === "well-known"
            ? "well-known-skill"
            : null;
  if (!expectedKind || record.raw.kind !== expectedKind) {
    context.addIssue({
      code: "custom",
      path: ["raw", "kind"],
      message: `Provider ${record.provider} cannot persist raw kind ${record.raw.kind}`,
    });
  }
});

export type DiscoveredSkillRecord = z.infer<typeof discoveredSkillRecordSchema>;

export interface CatalogSourceDescriptor {
  id: string;
  name: string;
  baseUrl: string;
  mode: (typeof sourceModes)[number];
  freshnessPolicy?: (typeof sourceFreshnessPolicies)[number];
  upstreamIdentifier: string;
  termsUrl?: string | null;
  enabled?: boolean;
  initialCoverageState?: string;
  knownExclusions?: string[];
}

export interface ConnectorPage {
  records: unknown[];
  nextCursor: string | null;
  hasMore: boolean;
  reportedTotal: number | null;
  completeSnapshot: boolean;
  degraded?: boolean;
  exclusions?: string[];
}

export interface ConnectorContext {
  cursor: string | null;
}

export interface CatalogSourceConnector {
  readonly descriptor: CatalogSourceDescriptor;
  enumerate(context: ConnectorContext): AsyncIterable<ConnectorPage>;
}

export interface ConnectorSyncResult {
  sourceId: string;
  status: "current" | "partial" | "not-configured";
  processed: number;
  failures: string[];
  exclusions: string[];
}
