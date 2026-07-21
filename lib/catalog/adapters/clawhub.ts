import { createHash } from "node:crypto";

import { z } from "zod";

import {
  computeArtifactContentHash,
  normalizeArtifactFilePath,
} from "../artifact-fingerprint";
import { cancelBestEffort, readBoundedResponse, requestTimeout } from "../http-safety";
import { createPersistedSkillRaw } from "../provider-raw";
import type {
  CatalogSourceConnector,
  ConnectorContext,
  ConnectorPage,
  DiscoveredSkillRecord,
} from "../source-contract";

const slugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/);
const ownerSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
const displayNameSchema = z.string().min(1).max(256);
const versionIdentifierSchema = z.string().min(1).max(256);
const licenseSchema = z.string().max(256).nullable().optional();
const timestampSchema = z
  .number()
  .finite()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const latestVersionSchema = z.object({
  version: versionIdentifierSchema,
  createdAt: timestampSchema,
  license: licenseSchema,
});

const listItemSchema = z.object({
  slug: slugSchema,
  displayName: displayNameSchema,
  summary: z.string().max(4_096).nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  latestVersion: latestVersionSchema.nullable(),
});

const listResponseSchema = z.object({
  items: z.array(listItemSchema).max(200),
  nextCursor: z.string().min(1).max(2_048).nullable(),
});

const moderationSchema = z
  .object({
    isSuspicious: z.boolean().default(false),
    isMalwareBlocked: z.boolean().default(false),
    isHiddenByMod: z.boolean().optional(),
    isRemoved: z.boolean().optional(),
    verdict: z.string().max(128).nullable().optional(),
    reasonCodes: z.array(z.string().min(1).max(128)).max(64).default([]),
    summary: z.string().max(4_096).nullable().optional(),
    engineVersion: z.string().max(128).nullable().optional(),
    updatedAt: timestampSchema.nullable().optional(),
  });

const detailResponseSchema = z.object({
  skill: z.object({
    slug: slugSchema,
    displayName: displayNameSchema,
    summary: z.string().max(4_096).nullable(),
    url: z.url().max(2_048).optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  }),
  latestVersion: latestVersionSchema.nullable(),
  owner: z.object({ handle: ownerSchema }).nullable(),
  moderation: moderationSchema.nullable().optional(),
});

const fileSchema = z.object({
  path: z.string().min(1).max(4_096),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^(?:sha256:)?[a-fA-F0-9]{64}$/),
  contentType: z.string().max(256).nullable(),
});

const securitySchema = z
  .object({
    status: z.string().min(1).max(128),
    hasWarnings: z.boolean().optional(),
    checkedAt: timestampSchema.nullable().optional(),
    sha256hash: z.string().max(256).nullable().optional(),
  });

const versionResponseSchema = z.object({
  skill: z.object({ slug: slugSchema, displayName: displayNameSchema }).nullable(),
  version: z
    .object({
      version: versionIdentifierSchema,
      createdAt: timestampSchema,
      license: licenseSchema,
      files: z.array(fileSchema).max(100_000),
      security: securitySchema.optional(),
    })
    .nullable(),
});

const scanResponseSchema = z
  .object({
    moderation: moderationSchema.nullable().optional(),
    security: securitySchema.nullable().optional(),
  });

const verificationSchema = z
  .object({
    schema: z.string().max(128).optional(),
    ok: z.boolean(),
    decision: z.string().min(1).max(128),
    version: versionIdentifierSchema,
    publisherHandle: ownerSchema,
    artifact: z.object({
      sourceFingerprint: z.string().regex(/^[a-fA-F0-9]{64}$/),
      files: z.array(fileSchema).max(100_000).default([]),
    }),
  });

const ambiguitySchema = z.object({
  code: z.literal("AMBIGUOUS_SKILL_SLUG"),
  slug: slugSchema,
  matches: z
    .array(
      z.object({
        ownerHandle: ownerSchema,
        slug: slugSchema,
        ref: z.string().min(1).max(512),
        url: z.url().max(2_048),
      }),
    )
    .min(2)
    .max(100),
});

type ListItem = z.infer<typeof listItemSchema>;
type Detail = z.infer<typeof detailResponseSchema>;
type FileDescriptor = z.infer<typeof fileSchema>;
type Moderation = z.infer<typeof moderationSchema>;
type Scan = z.infer<typeof scanResponseSchema>;
type Security = z.infer<typeof securitySchema>;
type Verification = z.infer<typeof verificationSchema>;
type Version = NonNullable<z.infer<typeof versionResponseSchema>["version"]>;

export interface ClawHubAdapterOptions {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
  limit?: number;
  maxTextFileBytes?: number;
  maxTextTotalBytes?: number;
}

function normalizedSha(value: string): string {
  return value.toLowerCase().replace(/^sha256:/, "");
}

function isTextFile(file: FileDescriptor): boolean {
  const contentType = file.contentType?.toLowerCase() ?? "";
  const basename = file.path.split("/").at(-1) ?? file.path;
  return (
    contentType.startsWith("text/") ||
    /(?:json|javascript|typescript|xml|yaml|toml|shell|python)/.test(contentType) ||
    !basename.includes(".") ||
    /\.(?:md|txt|json|ya?ml|toml|js|jsx|ts|tsx|mjs|cjs|py|rb|rs|go|java|sh|ps1|css|html?)$/i.test(
      file.path,
    )
  );
}

function assertUniqueInventory(files: readonly FileDescriptor[], label: string): void {
  const paths = new Set<string>();
  for (const file of files) {
    const path = normalizeArtifactFilePath(file.path);
    if (paths.has(path)) {
      throw new Error(`${label} contains duplicate normalized path ${path}`);
    }
    paths.add(path);
  }
}

function latestVersionSummary(
  latestVersion: ListItem["latestVersion"] | Detail["latestVersion"],
): Record<string, unknown> | null {
  if (!latestVersion) return null;
  return {
    version: latestVersion.version,
    createdAt: latestVersion.createdAt,
    license: latestVersion.license ?? null,
  };
}

function persistedClawHubListing(item: ListItem): Record<string, unknown> {
  return {
    slug: item.slug,
    displayName: item.displayName,
    summary: item.summary,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    latestVersion: latestVersionSummary(item.latestVersion),
  };
}

function persistedClawHubDetail(detail: Detail): Record<string, unknown> {
  return {
    slug: detail.skill.slug,
    displayName: detail.skill.displayName,
    summary: detail.skill.summary,
    url: detail.skill.url ?? null,
    createdAt: detail.skill.createdAt,
    updatedAt: detail.skill.updatedAt,
    owner: detail.owner?.handle ?? null,
    latestVersion: latestVersionSummary(detail.latestVersion),
  };
}

function persistedModerationSummary(
  moderation: Moderation | null | undefined,
): Record<string, unknown> | null {
  if (!moderation) return null;
  return {
    isSuspicious: moderation.isSuspicious,
    isMalwareBlocked: moderation.isMalwareBlocked,
    isHiddenByMod: moderation.isHiddenByMod ?? false,
    isRemoved: moderation.isRemoved ?? false,
    verdict: moderation.verdict ?? null,
    reasonCodes: moderation.reasonCodes,
    summary: moderation.summary ?? null,
    engineVersion: moderation.engineVersion ?? null,
    updatedAt: moderation.updatedAt ?? null,
  };
}

function persistedSecuritySummary(
  security: Security | null | undefined,
): Record<string, unknown> | null {
  if (!security) return null;
  return {
    status: security.status,
    hasWarnings: security.hasWarnings ?? false,
    checkedAt: security.checkedAt ?? null,
    sha256hash: security.sha256hash ?? null,
  };
}

function persistedScanSummary(scan: Scan | null): Record<string, unknown> | null {
  if (!scan) return null;
  return {
    moderation: persistedModerationSummary(scan.moderation),
    security: persistedSecuritySummary(scan.security),
  };
}

function inventorySummary(files: readonly FileDescriptor[]): Record<string, unknown> {
  return {
    fileCount: files.length,
    totalBytes: files.reduce(
      (total, file) =>
        total > Number.MAX_SAFE_INTEGER - file.size
          ? Number.MAX_SAFE_INTEGER
          : total + file.size,
      0,
    ),
  };
}

function persistedVersionSummary(version: Version): Record<string, unknown> {
  return {
    version: version.version,
    createdAt: version.createdAt,
    license: version.license ?? null,
    inventory: inventorySummary(version.files),
    security: persistedSecuritySummary(version.security),
  };
}

function persistedVerificationSummary(
  verification: Verification | null,
): Record<string, unknown> | null {
  if (!verification) return null;
  return {
    schema: verification.schema ?? null,
    ok: verification.ok,
    decision: verification.decision,
    version: verification.version,
    publisherHandle: verification.publisherHandle,
    artifact: {
      sourceFingerprint: verification.artifact.sourceFingerprint,
      ...inventorySummary(verification.artifact.files),
    },
  };
}

export class ClawHubAdapter implements CatalogSourceConnector {
  readonly descriptor = {
    id: "clawhub",
    name: "ClawHub",
    baseUrl: "https://clawhub.ai/api/v1/skills",
    mode: "full" as const,
    upstreamIdentifier: "ClawHub public skills HTTP API",
    termsUrl: "https://docs.openclaw.ai/clawhub/http-api",
    knownExclusions: [
      "ClawHub withholds private, hidden, and moderation-blocked skills from the public API.",
      "ClawHub cursor pagination does not prove a stable snapshot; absence never retires prior records.",
    ],
  };
  private readonly fetchImplementation: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly maxAttempts: number;
  private readonly limit: number;
  private readonly maxTextFileBytes: number;
  private readonly maxTextTotalBytes: number;

  constructor(options: ClawHubAdapterOptions = {}) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.sleep =
      options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
    this.maxAttempts = Math.max(options.maxAttempts ?? 4, 1);
    this.limit = Math.min(Math.max(options.limit ?? 200, 1), 200);
    this.maxTextFileBytes = options.maxTextFileBytes ?? 204_800;
    this.maxTextTotalBytes = options.maxTextTotalBytes ?? 1_048_576;
  }

  async *enumerate(context: ConnectorContext): AsyncIterable<ConnectorPage> {
    let cursor = context.cursor;
    const seenCursors = new Set<string>(cursor ? [cursor] : []);
    do {
      const parameters = new URLSearchParams({ limit: String(this.limit), sort: "updated" });
      if (cursor) parameters.set("cursor", cursor);
      const page = listResponseSchema.parse(
        await this.json(`/api/v1/skills?${parameters.toString()}`),
      );
      const records: DiscoveredSkillRecord[] = [];
      const exclusions: string[] = [];
      let degraded = false;

      for (const item of page.items) {
        try {
          const details = await this.resolveDetails(item);
          for (const detail of details) {
            const record = await this.hydrate(item, detail, exclusions);
            if (record) records.push(record);
          }
        } catch (error) {
          degraded = true;
          exclusions.push(
            `${item.slug}: contract-safe hydration failed (${error instanceof Error ? error.message : String(error)}).`,
          );
        }
      }

      const repeatedCursor =
        page.nextCursor !== null &&
        (page.nextCursor === cursor || seenCursors.has(page.nextCursor));
      if (repeatedCursor) {
        degraded = true;
        exclusions.push(`ClawHub returned a repeated cursor (${page.nextCursor}); pagination stopped.`);
      }
      const nextCursor = repeatedCursor ? null : page.nextCursor;
      if (nextCursor) seenCursors.add(nextCursor);
      yield {
        records,
        nextCursor,
        hasMore: nextCursor !== null,
        reportedTotal: null,
        completeSnapshot: false,
        degraded,
        exclusions,
      };
      cursor = nextCursor;
    } while (cursor);
  }

  private async resolveDetails(item: ListItem): Promise<Detail[]> {
    const slug = encodeURIComponent(item.slug);
    const response = await this.request(`/api/v1/skills/${slug}`, "application/json", [409]);
    if (response.status !== 409) {
      const detail = detailResponseSchema.parse(await this.decodeJson(response));
      if (!detail.owner?.handle || detail.skill.slug !== item.slug) {
        throw new Error("unique detail omitted stable owner identity");
      }
      return [detail];
    }

    const ambiguity = ambiguitySchema.parse(await this.decodeJson(response));
    if (ambiguity.slug !== item.slug) {
      throw new Error("ambiguity response slug did not match listing");
    }
    const identities = new Set<string>();
    const details: Detail[] = [];
    for (const match of ambiguity.matches) {
      const identity = `@${match.ownerHandle}/${match.slug}`;
      if (match.slug !== item.slug || match.ref !== identity || identities.has(identity)) {
        throw new Error("ambiguity response contained an invalid or duplicate identity");
      }
      identities.add(identity);
      const detail = detailResponseSchema.parse(
        await this.json(
          `/api/v1/skills/${slug}?owner=${encodeURIComponent(match.ownerHandle)}`,
        ),
      );
      if (detail.owner?.handle !== match.ownerHandle || detail.skill.slug !== match.slug) {
        throw new Error("owner-qualified detail did not preserve the requested identity");
      }
      details.push(detail);
    }
    return details;
  }

  private async hydrate(
    item: ListItem,
    detail: Detail,
    exclusions: string[],
  ): Promise<DiscoveredSkillRecord | null> {
    const owner = detail.owner!.handle;
    const slug = detail.skill.slug;
    const identity = `@${owner}/${slug}`;
    const version = detail.latestVersion?.version ?? item.latestVersion?.version ?? null;
    if (!version) {
      exclusions.push(`${identity}: no exact public version was available.`);
      return this.unresolvedRecord(item, detail);
    }
    const ownerQuery = `owner=${encodeURIComponent(owner)}`;
    const moderation = await this.optionalJson(
      `/api/v1/skills/${encodeURIComponent(slug)}/moderation?${ownerQuery}`,
    );
    const scan = scanResponseSchema.nullable().parse(
      await this.optionalJson(
        `/api/v1/skills/${encodeURIComponent(slug)}/scan?version=${encodeURIComponent(version)}&${ownerQuery}`,
      ),
    );
    const effectiveModeration =
      (moderationSchema.nullable().safeParse(
        moderation && typeof moderation === "object" && "moderation" in moderation
          ? (moderation as { moderation: unknown }).moderation
          : moderation,
      ).data ?? scan?.moderation ?? detail.moderation ?? null);
    if (
      effectiveModeration?.isMalwareBlocked ||
      effectiveModeration?.isHiddenByMod ||
      effectiveModeration?.isRemoved
    ) {
      exclusions.push(`${identity}: no longer publicly eligible under ClawHub moderation.`);
      return this.unresolvedRecord(
        item,
        detail,
        "explicit moderation tombstone",
        effectiveModeration,
        scan,
      );
    }

    const encodedVersion = encodeURIComponent(version);
    const versionResult = versionResponseSchema.parse(
      await this.json(
        `/api/v1/skills/${encodeURIComponent(slug)}/versions/${encodedVersion}?${ownerQuery}`,
      ),
    );
    if (
      !versionResult.skill ||
      versionResult.skill.slug !== slug ||
      !versionResult.version ||
      versionResult.version.version !== version
    ) {
      throw new Error(`${identity}: exact version response did not match ${version}`);
    }
    const verificationValue = await this.optionalJson(
      `/api/v1/skills/${encodeURIComponent(slug)}/verify?version=${encodedVersion}&${ownerQuery}`,
    );
    const verification = verificationValue
      ? verificationSchema.parse(verificationValue)
      : null;
    if (
      verification &&
      (verification.version !== version || verification.publisherHandle !== owner)
    ) {
      throw new Error(`${identity}: verification identity did not match exact version`);
    }

    const files = versionResult.version.files;
    assertUniqueInventory(files, `${identity} version inventory`);
    let artifactComplete = Boolean(verification);
    if (verification) {
      const sourceFiles = files.filter((file) => file.path !== "skill-card.md");
      const verifiedFiles = verification.artifact.files;
      assertUniqueInventory(verifiedFiles, `${identity} signed inventory`);
      const inventoriesMatch =
        sourceFiles.length === verifiedFiles.length &&
        sourceFiles.every((versionFile) => {
          const verifiedFile = verifiedFiles.find((file) => file.path === versionFile.path);
          return (
            verifiedFile &&
            versionFile.size === verifiedFile.size &&
            normalizedSha(versionFile.sha256) === normalizedSha(verifiedFile.sha256) &&
            (versionFile.contentType ?? "").toLowerCase() ===
              (verifiedFile.contentType ?? "").toLowerCase()
          );
        });
      if (!inventoriesMatch) {
        artifactComplete = false;
        exclusions.push(`${identity}: signed inventory did not exactly match version source files.`);
      }
    }

    const textFiles: Array<{ path: string; contents: string; sha256: string }> = [];
    let totalBytes = 0;
    for (const file of files.filter(isTextFile)) {
      if (
        file.size > this.maxTextFileBytes ||
        totalBytes + file.size > this.maxTextTotalBytes
      ) {
        artifactComplete = false;
        exclusions.push(`${identity}: ${file.path} exceeded bounded static-scan limits.`);
        continue;
      }
      const response = await this.request(
        `/api/v1/skills/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(file.path)}&version=${encodedVersion}&${ownerQuery}`,
        "text/plain, application/octet-stream;q=0.5",
      );
      const bytes = await readBoundedResponse(response, this.maxTextFileBytes);
      totalBytes += bytes.byteLength;
      if (totalBytes > this.maxTextTotalBytes) {
        artifactComplete = false;
        exclusions.push(`${identity}: actual text bytes exceeded the aggregate scan limit.`);
        continue;
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== normalizedSha(file.sha256)) {
        artifactComplete = false;
        exclusions.push(`${identity}: ${file.path} failed exact-version hash verification.`);
        continue;
      }
      try {
        textFiles.push({
          path: file.path,
          contents: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          sha256: digest,
        });
      } catch {
        artifactComplete = false;
        exclusions.push(`${identity}: ${file.path} was advertised as text but was not UTF-8.`);
      }
    }
    const manifest = textFiles.find((file) => file.path === "SKILL.md");
    if (!manifest) artifactComplete = false;

    const inventoryHash = createHash("sha256")
      .update(
        files
          .map((file) => `${file.path}\0${file.size}\0${normalizedSha(file.sha256)}`)
          .sort()
          .join("\n"),
      )
      .digest("hex");
    const sourceFingerprint = verification?.artifact.sourceFingerprint ?? null;
    if (!sourceFingerprint) {
      artifactComplete = false;
      exclusions.push(`${identity}: exact source fingerprint was unavailable; kept nonselectable.`);
    }
    const artifactFiles = files.map((file) => ({
      path: file.path,
      type: isTextFile(file) ? "file" : "binary",
      size: file.size,
      sha: normalizedSha(file.sha256),
    }));
    const contentHash =
      manifest && artifactComplete && sourceFingerprint
        ? computeArtifactContentHash(artifactFiles)
        : null;
    const license =
      versionResult.version.license ?? detail.latestVersion?.license ?? "unknown";
    const canonicalUrl =
      detail.skill.url ??
      `https://clawhub.ai/${encodeURIComponent(owner)}/skills/${encodeURIComponent(slug)}`;

    return {
      sourceRecordId: identity,
      provider: "clawhub",
      sourceType: "clawhub",
      sourceUrl: "https://clawhub.ai",
      skillPath: `${owner}/${slug}`,
      upstreamName: detail.skill.displayName,
      upstreamDescription: detail.skill.summary,
      compatibility: null,
      license,
      installUrl: canonicalUrl,
      installSpec: {
        kind: "registry",
        registry: "clawhub",
        identifier: identity,
        version,
      },
      immutableRef: version,
      contentHash,
      upstreamHash: sourceFingerprint,
      public: true,
      internal: false,
      aliases: [identity],
      repository: null,
      artifact: manifest
        ? {
            type: "skill-md",
            contents: manifest.contents,
            complete: artifactComplete,
            textFiles,
            files: artifactFiles,
          }
        : null,
      raw: createPersistedSkillRaw({
        kind: "clawhub-skill",
        listing: persistedClawHubListing(item),
        detail: persistedClawHubDetail(detail),
        inventoryHash,
        sourceFingerprint,
        version: persistedVersionSummary(versionResult.version),
        moderation: persistedModerationSummary(effectiveModeration),
        scan: persistedScanSummary(scan),
        verification: persistedVerificationSummary(verification),
      }),
    };
  }

  private unresolvedRecord(
    item: ListItem,
    detail: Detail,
    reason = "exact version unavailable",
    moderation: Moderation | null = null,
    scan: Scan | null = null,
  ): DiscoveredSkillRecord {
    const owner = detail.owner!.handle;
    const identity = `@${owner}/${detail.skill.slug}`;
    return {
      sourceRecordId: identity,
      provider: "clawhub",
      sourceType: "clawhub",
      sourceUrl: "https://clawhub.ai",
      skillPath: `${owner}/${detail.skill.slug}`,
      upstreamName: detail.skill.displayName,
      upstreamDescription: detail.skill.summary,
      compatibility: null,
      license: detail.latestVersion?.license ?? null,
      installUrl: detail.skill.url ?? null,
      installSpec: null,
      immutableRef: item.latestVersion?.version ?? null,
      contentHash: null,
      upstreamHash: null,
      public: true,
      internal: false,
      aliases: [identity],
      repository: null,
      artifact: null,
      raw: createPersistedSkillRaw({
        kind: "clawhub-skill",
        listing: persistedClawHubListing(item),
        detail: persistedClawHubDetail(detail),
        moderation: persistedModerationSummary(moderation),
        scan: persistedScanSummary(scan),
        unresolved: reason,
      }),
    };
  }

  private async optionalJson(path: string): Promise<unknown | null> {
    const response = await this.request(path, "application/json", [404]);
    if (response.status === 404) {
      cancelBestEffort(response.body, "optional ClawHub response discarded");
      return null;
    }
    return this.decodeJson(response);
  }

  private async json(path: string): Promise<unknown> {
    return this.decodeJson(await this.request(path, "application/json"));
  }

  private async decodeJson(response: Response): Promise<unknown> {
    const bytes = await readBoundedResponse(response, 2_097_152);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }

  private async request(
    path: string,
    accept: string,
    allowedStatuses: readonly number[] = [],
  ): Promise<Response> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const response = await this.fetchImplementation(`https://clawhub.ai${path}`, {
        headers: { accept },
        redirect: "manual",
        signal: requestTimeout(),
      });
      if (response.ok || allowedStatuses.includes(response.status)) return response;
      if (response.status >= 300 && response.status < 400) {
        cancelBestEffort(response.body, "ClawHub redirect discarded");
        throw new ClawHubHttpError("ClawHub redirects are not followed", response.status);
      }
      const retryable = response.status === 429 || [502, 503, 504].includes(response.status);
      if (!retryable || attempt + 1 >= this.maxAttempts) {
        const bytes = await readBoundedResponse(response, 16_384).catch(() => new Uint8Array());
        throw new ClawHubHttpError(new TextDecoder().decode(bytes), response.status);
      }

      const retryAfterHeader = response.headers.get("retry-after");
      const resetHeader = response.headers.get("ratelimit-reset");
      const legacyResetHeader = response.headers.get("x-ratelimit-reset");
      const retryAfter = retryAfterHeader === null ? null : Number(retryAfterHeader) * 1_000;
      const reset = resetHeader === null ? null : Number(resetHeader) * 1_000;
      const legacyReset =
        legacyResetHeader === null ? null : Number(legacyResetHeader) * 1_000 - Date.now();
      const baseDelay =
        retryAfter !== null && Number.isFinite(retryAfter)
          ? retryAfter
          : reset !== null && Number.isFinite(reset)
            ? reset
            : legacyReset !== null && Number.isFinite(legacyReset)
              ? legacyReset
              : 500 * 2 ** attempt;
      const delay = Math.min(
        Math.ceil(Math.max(baseDelay, 0) + Math.max(baseDelay, 0) * 0.2 * this.random()),
        60_000,
      );
      cancelBestEffort(response.body, "retryable ClawHub response discarded");
      await this.sleep(delay);
    }
    throw new ClawHubHttpError("ClawHub request failed", 503);
  }
}

export class ClawHubHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message || `ClawHub returned HTTP ${status}`);
    this.name = "ClawHubHttpError";
  }
}
