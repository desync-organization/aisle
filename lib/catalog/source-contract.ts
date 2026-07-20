import { z } from "zod";

import { sourceModes } from "../db/schema";

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

export const discoveredSkillRecordSchema = z.object({
  sourceRecordId: z.string().min(1),
  provider: z.string().min(1),
  sourceType: z.string().min(1),
  sourceUrl: z.url(),
  skillPath: z.string().min(1),
  upstreamName: z.string().min(1).nullable(),
  upstreamDescription: z.string().min(1).nullable(),
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
  raw: z.record(z.string(), z.unknown()),
});

export type DiscoveredSkillRecord = z.infer<typeof discoveredSkillRecordSchema>;

export interface CatalogSourceDescriptor {
  id: string;
  name: string;
  baseUrl: string;
  mode: (typeof sourceModes)[number];
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
