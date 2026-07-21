import { z } from "zod";

export const MAX_PERSISTED_PROVIDER_RAW_BYTES = 32 * 1_024;

const text = (maximum: number) => z.string().max(maximum);
const nullableText = (maximum: number) => text(maximum).nullable();
const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const safeNumber = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const sha256 = z.string().regex(/^[a-fA-F0-9]{64}$/);
const publicHttpsUrl = (maximum: number) => z.url().max(maximum).refine((value) => {
  const parsed = new URL(value);
  return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
}, "URL must use HTTPS without credentials");

const skillsShListingSchema = z.object({
  id: text(1_024),
  slug: text(256),
  name: text(256),
  source: text(512),
  sourceType: text(64),
  installs: safeInteger,
  installUrl: z.url().max(2_048).nullable(),
  url: z.url().max(2_048),
  hash: nullableText(256),
  duplicate: z.boolean(),
}).strict();

const latestVersionSchema = z.object({
  version: text(256),
  createdAt: timestamp,
  license: nullableText(256),
}).strict();

const clawHubListingSchema = z.object({
  slug: text(128),
  displayName: text(256),
  summary: nullableText(4_096),
  createdAt: timestamp,
  updatedAt: timestamp,
  latestVersion: latestVersionSchema.nullable(),
}).strict();

const clawHubDetailSchema = z.object({
  slug: text(128),
  displayName: text(256),
  summary: nullableText(4_096),
  url: z.url().max(2_048).nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  owner: nullableText(128),
  latestVersion: latestVersionSchema.nullable(),
}).strict();

const moderationSchema = z.object({
  isSuspicious: z.boolean().optional(),
  isMalwareBlocked: z.boolean().optional(),
  isHiddenByMod: z.boolean().optional(),
  isRemoved: z.boolean().optional(),
  verdict: nullableText(128).optional(),
  reasonCodes: z.array(text(128)).max(64).optional(),
  summary: nullableText(4_096).optional(),
  engineVersion: nullableText(128).optional(),
  updatedAt: timestamp.nullable().optional(),
}).strict();

const securitySchema = z.object({
  status: text(128),
  hasWarnings: z.boolean().optional(),
  checkedAt: timestamp.nullable().optional(),
  sha256hash: nullableText(256).optional(),
}).strict();

const inventorySchema = z.object({
  fileCount: safeInteger,
  totalBytes: safeInteger,
}).strict();

const skillMdListingSchema = z.object({
  slug: text(512),
  type: text(64),
  title: text(256),
  description: text(4_096),
  verified: z.boolean(),
  verifiedScope: z.literal("provider-badge-only"),
  agents: nullableText(1_024),
  category: nullableText(128),
  averageRating: safeNumber.nullable(),
  ratingCount: safeInteger.nullable(),
}).strict();

const skillMdDetailSchema = z.object({
  slug: text(512),
  type: text(64),
  title: text(256),
  description: text(4_096),
  verified: z.boolean(),
  verifiedScope: z.literal("provider-badge-only"),
  license: nullableText(256),
  sourceRepository: nullableText(2_048),
  commitSha: nullableText(256),
  lastSyncedAt: nullableText(128),
  category: nullableText(128),
  averageRating: safeNumber.nullable(),
  ratingCount: safeInteger.nullable(),
  installCount: safeInteger.nullable(),
  inventory: z.object({
    fileCount: safeInteger,
    truncated: z.boolean(),
    totalBytes: safeInteger,
    scriptCount: safeInteger,
  }).strict(),
}).strict();

const persistedSkillRawBaseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("skills-sh-listing"),
    listing: skillsShListingSchema,
  }).strict(),
  z.object({
    kind: z.literal("skills-sh-skill"),
    listing: skillsShListingSchema,
    detail: z.object({
      id: text(1_024),
      slug: text(256),
      source: text(512),
      hash: nullableText(256),
      fileCount: safeInteger.nullable(),
      artifactContentHash: sha256.nullable(),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal("clawhub-skill"),
    listing: clawHubListingSchema.optional(),
    detail: clawHubDetailSchema.optional(),
    inventoryHash: sha256.nullable().optional(),
    sourceFingerprint: sha256.nullable().optional(),
    version: z.object({
      version: text(256),
      createdAt: timestamp,
      license: nullableText(256),
      inventory: inventorySchema,
      security: securitySchema.nullable(),
    }).strict().optional(),
    moderation: moderationSchema.nullable().optional(),
    scan: z.object({
      moderation: moderationSchema.nullable(),
      security: securitySchema.nullable(),
    }).strict().nullable().optional(),
    verification: z.object({
      schema: nullableText(128).optional(),
      ok: z.boolean(),
      decision: text(128),
      version: text(256).optional(),
      publisherHandle: text(128).optional(),
      artifact: z.object({
        sourceFingerprint: sha256,
        fileCount: safeInteger,
        totalBytes: safeInteger,
      }).strict().optional(),
    }).strict().nullable().optional(),
    unresolved: text(1_024).optional(),
  }).strict(),
  z.object({
    kind: z.literal("skillmd-skill"),
    listing: skillMdListingSchema,
    detail: skillMdDetailSchema.nullable(),
    sourceTreeSha: text(128).optional(),
    providerVerifiedScope: z.literal("provider-badge-only").optional(),
    unresolved: text(1_024).optional(),
  }).strict(),
  z.object({
    kind: z.literal("getskillary-observation"),
    schemaVersion: z.literal(1),
    observationKind: z.literal("coverage-only"),
    providerRecordId: text(512),
    slug: text(256),
    title: text(512),
    summary: text(4_096),
    category: text(256),
    tags: z.array(text(128)).max(32),
    canonicalUrl: publicHttpsUrl(4_096),
    snapshot: z.object({
      generatedAt: z.iso.datetime(),
      declaredPublicBoundary: text(512),
      boundaryTruncated: z.boolean(),
    }).strict(),
    metadataBounds: z.object({
      summaryTruncated: z.boolean(),
      tagsTruncated: z.boolean(),
    }).strict(),
    providerArchiveObservation: z.object({
      kind: z.literal("provider-declared-zip-metadata"),
      sizeBytes: safeInteger,
      archiveSha256: sha256,
      installEvidence: z.literal(false),
      downloadUrlPersisted: z.literal(false),
    }).strict(),
    resolution: z.object({
      repository: z.literal("unresolved"),
      license: z.literal("unresolved"),
      immutableArtifact: z.literal("unresolved"),
      selectable: z.literal(false),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal("github-skill"),
    repository: text(256),
    manifestPath: text(4_096),
    commit: text(256),
    tree: text(256).optional(),
    reason: text(1_024).optional(),
    discoveredBy: z.object({
      sourceId: text(128),
      sourceRecordId: text(640),
    }).strict().optional(),
  }).strict(),
  z.object({
    kind: z.literal("well-known-skill"),
    schemaVersion: z.enum(["current", "legacy"]),
    name: text(64),
    type: z.enum(["skill-md", "archive"]),
    description: text(1_024),
    url: text(2_048),
    digest: text(128).nullable(),
    files: z.array(text(4_096)).max(10_000).nullable(),
    artifactUrl: z.url().max(2_048),
    unresolved: text(1_024).optional(),
  }).strict(),
]);

const persistedAuditRawBaseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("skills-sh-audit"),
    provider: text(128),
    slug: text(128),
    status: z.enum(["pass", "warn", "fail"]),
    summary: text(4_096),
    auditedAt: z.iso.datetime().nullable(),
    riskLevel: nullableText(128),
  }).strict(),
  z.object({
    kind: z.literal("clawhub-audit"),
    decision: nullableText(128),
    ok: z.boolean().nullable(),
    securityStatus: nullableText(128),
  }).strict(),
]);

function withSerializedSizeBound<T extends z.ZodType>(schema: T) {
  return schema.superRefine((value, context) => {
    const byteLength = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (byteLength > MAX_PERSISTED_PROVIDER_RAW_BYTES) {
      context.addIssue({
        code: "custom",
        message: `Persisted provider metadata exceeds ${MAX_PERSISTED_PROVIDER_RAW_BYTES} bytes`,
      });
    }
  });
}

export const persistedSkillRawSchema = withSerializedSizeBound(persistedSkillRawBaseSchema);
export const persistedAuditRawSchema = withSerializedSizeBound(persistedAuditRawBaseSchema);

export type PersistedSkillRaw = z.infer<typeof persistedSkillRawSchema>;
export type PersistedAuditRaw = z.infer<typeof persistedAuditRawSchema>;

export function createPersistedSkillRaw(value: unknown): PersistedSkillRaw {
  return persistedSkillRawSchema.parse(value);
}

export function createPersistedAuditRaw(value: unknown): PersistedAuditRaw {
  return persistedAuditRawSchema.parse(value);
}
