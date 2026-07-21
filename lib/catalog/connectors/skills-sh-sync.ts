import { createHash } from "node:crypto";

import type { CatalogRepository } from "../../db/repository";
import { CatalogSyncLeaseLostError } from "../../db/repository";
import {
  computeArtifactContentHash,
  normalizeArtifactFilePath,
} from "../artifact-fingerprint";
import { startSyncLeaseHeartbeat } from "../lease-heartbeat";
import type { CatalogIngestionService } from "../ingestion";
import {
  SkillsShAuthenticationError,
  SkillsShClient,
  SkillsShHttpError,
  type SkillsShAuditResponse,
  type SkillsShSkill,
} from "./skills-sh-client";

export interface SkillsShSyncOptions {
  sourceId?: string;
  perPage?: number;
  detailConcurrency?: number;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  ingestion?: CatalogIngestionService;
}

export interface SkillsShSyncResult {
  status: "current" | "partial" | "credentials-required";
  runId: string;
  pages: number;
  processed: number;
  sourceTotal: number | null;
  failures: string[];
  resumed: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function persistedListingSummary(listing: SkillsShSkill): Record<string, unknown> {
  return {
    id: listing.id,
    slug: listing.slug,
    name: listing.name,
    source: listing.source,
    sourceType: listing.sourceType,
    installs: listing.installs,
    installUrl: listing.installUrl,
    url: listing.url,
    hash: listing.hash ?? null,
    duplicate: listing.duplicate ?? listing.isDuplicate ?? false,
  };
}

function persistedAuditSummary(
  entry: SkillsShAuditResponse["audits"][number],
): Record<string, unknown> {
  return {
    provider: entry.provider,
    slug: entry.slug,
    status: entry.status,
    summary: entry.summary,
    auditedAt: entry.auditedAt ?? null,
    riskLevel: entry.riskLevel ?? null,
  };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) {
        results[index] = await transform(value);
      }
    }
  }

  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, Math.max(values.length, 1)) }, () => worker()),
  );
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected) throw rejected.reason;
  return results;
}

export class SkillsShSync {
  private readonly sourceId: string;
  private readonly perPage: number;
  private readonly detailConcurrency: number;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly ingestion?: CatalogIngestionService;

  constructor(
    private readonly repository: CatalogRepository,
    private readonly client: SkillsShClient,
    options: SkillsShSyncOptions = {},
  ) {
    this.sourceId = options.sourceId ?? "skills-sh";
    this.perPage = Math.min(Math.max(options.perPage ?? 500, 1), 500);
    this.detailConcurrency = Math.min(Math.max(options.detailConcurrency ?? 8, 1), 32);
    this.leaseDurationMs = Math.max(options.leaseDurationMs ?? 300_000, 100);
    this.heartbeatIntervalMs = Math.min(
      Math.max(options.heartbeatIntervalMs ?? 30_000, 10),
      Math.max(Math.floor(this.leaseDurationMs / 2), 10),
    );
    this.ingestion = options.ingestion;
  }

  async run(): Promise<SkillsShSyncResult> {
    const run = await this.repository.acquireSyncRun(this.sourceId, this.leaseDurationMs);
    const heartbeat = startSyncLeaseHeartbeat(this.repository, {
      runId: run.id,
      leaseToken: run.leaseToken,
      leaseDurationMs: this.leaseDurationMs,
      intervalMs: this.heartbeatIntervalMs,
    });
    const resumed = run.resumed;
    let pageNumber = run.nextPage;
    let pageCount = run.pageCount;
    let processed = run.processedCount;
    let sourceTotal = run.sourceTotal;
    const failures: string[] = [];
    const seenIds = new Set<string>();

    try {
      while (true) {
        const response = await this.client.listSkills(pageNumber, this.perPage);
        if (response.notModified) {
          throw new Error("skills.sh listing unexpectedly returned 304 without a conditional request");
        }
        const pagination = response.data.pagination;
        if (pagination.page !== pageNumber) {
          throw new Error(
            `skills.sh returned page ${pagination.page} while page ${pageNumber} was requested`,
          );
        }
        if (pagination.perPage !== this.perPage) {
          throw new Error(
            `skills.sh echoed perPage=${pagination.perPage}; expected ${this.perPage}`,
          );
        }
        if (sourceTotal !== null && pagination.total !== sourceTotal) {
          throw new Error(
            `skills.sh total drifted from ${sourceTotal} to ${pagination.total}`,
          );
        }
        if (response.data.data.length > this.perPage) {
          throw new Error("skills.sh returned more records than the requested page size");
        }
        if (pagination.hasMore && response.data.data.length === 0) {
          throw new Error("skills.sh returned an empty page while claiming more pages");
        }
        for (const listing of response.data.data) {
          if (seenIds.has(listing.id)) {
            throw new Error(`skills.sh returned duplicate listing id ${listing.id}`);
          }
          seenIds.add(listing.id);
        }
        const nextProcessed = processed + response.data.data.length;
        if (nextProcessed > pagination.total) {
          throw new Error("skills.sh returned more records than its reported total");
        }
        if (pagination.hasMore && nextProcessed >= pagination.total) {
          throw new Error("skills.sh claimed more pages after reaching its reported total");
        }
        if (!pagination.hasMore && nextProcessed !== pagination.total) {
          throw new Error(
            `skills.sh terminal page ended at ${nextProcessed} of ${pagination.total} records`,
          );
        }

        sourceTotal = pagination.total;
        const pageFailures = await mapWithConcurrency(
          response.data.data,
          this.detailConcurrency,
          async (listing) => {
            try {
              await this.ingestListing(run.id, listing);
              return null;
            } catch (error) {
              if (error instanceof SkillsShAuthenticationError) {
                throw error;
              }
              return `${listing.id}: ${errorMessage(error)}`;
            }
          },
        );
        failures.push(...pageFailures.filter((failure): failure is string => failure !== null));
        if (pageFailures.some((failure) => failure !== null)) {
          throw new Error(
            `skills.sh page ${response.data.pagination.page} was not fully durable; the page will be replayed`,
          );
        }

        pageCount += 1;
        processed += response.data.data.length;
        pageNumber = pagination.page + 1;
        await this.repository.checkpointSyncRun({
          runId: run.id,
          leaseToken: run.leaseToken,
          nextPage: pageNumber,
          pageCount,
          processedCount: processed,
          sourceTotal,
          cursor: pagination.hasMore ? `page:${pageNumber}` : null,
          reportedTotalKnown: true,
          leaseDurationMs: this.leaseDurationMs,
        });

        if (!pagination.hasMore) {
          break;
        }
      }

      const seenCount = await this.repository.countListingsSeenInRun(this.sourceId, run.id);
      if (sourceTotal === null || seenCount !== sourceTotal || processed !== sourceTotal) {
        throw new Error(
          `skills.sh terminal snapshot proved ${seenCount} distinct durable records and ${processed} observations for reported total ${sourceTotal ?? "unknown"}`,
        );
      }
      const recordCount = await this.repository.countSourceListings(this.sourceId);
      await heartbeat.stop();
      await this.repository.renewSyncLease(run.id, run.leaseToken, this.leaseDurationMs);
      await this.repository.finishSyncRun({
        runId: run.id,
        leaseToken: run.leaseToken,
        sourceId: this.sourceId,
        sourceTotal: sourceTotal ?? recordCount,
        recordCount,
        partialFailures: failures,
        completeCrawl: true,
      });
      return {
        status: failures.length ? "partial" : "current",
        runId: run.id,
        pages: pageCount,
        processed,
        sourceTotal,
        failures,
        resumed,
      };
    } catch (error) {
      await heartbeat.stop().catch(() => undefined);
      const authenticationFailure = error instanceof SkillsShAuthenticationError;
      const retryAfterMs = error instanceof SkillsShHttpError ? error.retryAfterMs : null;
      if (!(error instanceof CatalogSyncLeaseLostError)) {
        await this.repository.failSyncRun({
          runId: run.id,
          leaseToken: run.leaseToken,
          sourceId: this.sourceId,
          message: errorMessage(error),
          retryCount: error instanceof SkillsShHttpError ? 1 : 0,
          nextRetryAt: retryAfterMs === null ? null : new Date(Date.now() + retryAfterMs),
          authMissing: authenticationFailure,
        });
      }
      return {
        status: authenticationFailure ? "credentials-required" : "partial",
        runId: run.id,
        pages: pageCount,
        processed,
        sourceTotal,
        failures: [...failures, errorMessage(error)],
        resumed,
      };
    }
  }

  private async ingestListing(runId: string, listing: SkillsShSkill): Promise<void> {
    const listingHash = listing.hash ?? undefined;
    const stored = await this.repository.upsertSourceListing({
      sourceId: this.sourceId,
      runId,
      upstreamId: listing.id,
      sourceType: listing.sourceType,
      installUrl: listing.installUrl,
      sourceHash: listingHash,
      installs: listing.installs,
      duplicateIndicator: listing.duplicate ?? listing.isDuplicate ?? false,
      raw: persistedListingSummary(listing),
    });

    let observedContentHash = listingHash ?? stored.previousHash;
    const listingHashChanged = stored.previousHash !== (listingHash ?? null);
    if (listingHashChanged && stored.skillId) {
      await this.repository.markListingUnresolved(stored.id, listingHash ?? null);
    }
    if (!listingHash || stored.previousHash !== listingHash || (this.ingestion && !stored.skillId)) {
      const hashChanged = listingHashChanged;
      const mayUseValidators = !hashChanged && !(this.ingestion && !stored.skillId);
      const detail = await this.client.detail(listing.id, {
        etag: mayUseValidators ? stored.detailEtag : null,
        lastModified: mayUseValidators ? stored.detailLastModified : null,
      });
      if (detail.notModified) {
        if (hashChanged) {
          throw new Error("skills.sh returned 304 after the listing hash changed");
        }
        await this.repository.updateSourceListingHydration({
          listingId: stored.id,
          hash: stored.previousHash,
          etag: detail.etag ?? stored.detailEtag,
          lastModified: detail.lastModified ?? stored.detailLastModified,
        });
      } else {
        if (detail.data.id !== listing.id) {
          throw new Error(`skills.sh detail id ${detail.data.id} did not match ${listing.id}`);
        }
        observedContentHash = detail.data.hash;
        await this.repository.updateSourceListingHydration({
          listingId: stored.id,
          hash: detail.data.hash,
          etag: detail.etag,
          lastModified: detail.lastModified,
        });
        if (this.ingestion) {
          const sourceUrl =
            listing.installUrl ??
            (listing.sourceType.toLowerCase() === "github"
              ? `https://github.com/${listing.source}`
              : "https://skills.sh");
          const skillPath = listing.id.startsWith(`${listing.source}/`)
            ? listing.id.slice(listing.source.length + 1)
            : listing.slug;
          const upstreamTextFiles = (detail.data.files ?? []).map((file) => ({
            path: normalizeArtifactFilePath(file.path),
            contents: file.contents,
            sha256: createHash("sha256").update(file.contents).digest("hex"),
          }));
          const exactManifest = upstreamTextFiles.find((file) => file.path === "SKILL.md");
          const nestedManifests = upstreamTextFiles.filter((file) =>
            file.path.endsWith("/SKILL.md"),
          );
          const upstreamManifest = exactManifest ??
            (nestedManifests.length === 1 ? nestedManifests[0] : undefined);
          const artifactPrefix = upstreamManifest && upstreamManifest.path !== "SKILL.md"
            ? upstreamManifest.path.slice(0, -"SKILL.md".length)
            : "";
          const textFiles = upstreamManifest
            ? upstreamTextFiles
                .filter((file) => file.path.startsWith(artifactPrefix))
                .map((file) => ({
                  ...file,
                  path: file.path.slice(artifactPrefix.length),
                }))
            : [];
          const manifest = textFiles.find((file) => file.path === "SKILL.md");
          const artifactFiles = textFiles.map((file) => ({
            path: file.path,
            type: "file",
            size: new TextEncoder().encode(file.contents).byteLength,
            sha: file.sha256,
          }));
          const artifactContentHash = manifest
            ? computeArtifactContentHash(artifactFiles)
            : null;
          const github = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/i.exec(sourceUrl);
          await this.ingestion.persist(this.sourceId, runId, {
            sourceRecordId: listing.id,
            provider: "skills-sh",
            sourceType: listing.sourceType,
            sourceUrl,
            skillPath,
            upstreamName: listing.name,
            upstreamDescription: null,
            compatibility: null,
            license: null,
            installUrl: listing.url,
            installSpec: detail.data.hash
              ? {
                  kind: "registry",
                  registry: "skills.sh",
                  identifier: listing.id,
                  version: detail.data.hash,
                }
              : null,
            immutableRef: detail.data.hash,
            contentHash: artifactContentHash,
            upstreamHash: detail.data.hash,
            public: true,
            internal: false,
            aliases: [listing.slug, listing.id],
            repository: github
              ? {
                  provider: "github",
                  url: `https://github.com/${github[1]}/${github[2]}`,
                  owner: github[1]!,
                  name: github[2]!,
                  visibility: "public",
                  defaultBranch: null,
                }
              : null,
            artifact: manifest
              ? {
                  type: "skill-md",
                  contents: manifest.contents,
                  complete: detail.data.files !== null,
                  textFiles,
                  files: artifactFiles,
                }
              : null,
            raw: {
              listing: persistedListingSummary(listing),
              detail: {
                id: detail.data.id,
                slug: detail.data.slug,
                source: detail.data.source,
                hash: detail.data.hash,
                fileCount: detail.data.files?.length ?? null,
                artifactContentHash,
              },
            },
          }, { installs: listing.installs });
        }
      }
    }

    const audit = await this.client.audit(listing.id);
    if (audit.notModified) {
      return;
    }
    if (audit.data.id !== listing.id) {
      throw new Error(`skills.sh audit id ${audit.data.id} did not match ${listing.id}`);
    }
    await this.repository.recordObservedAudits({
      listingId: stored.id,
      // skills.sh audits do not identify a revision. This hash is only the
      // content observed alongside the audit request, never an exact scan scope.
      upstreamContentHash: observedContentHash,
      audits: audit.data.audits.map((entry) => ({
        provider: entry.provider,
        providerSlug: entry.slug,
        status: entry.status,
        summary: entry.summary,
        riskLevel: entry.riskLevel,
        auditedAt: entry.auditedAt,
        raw: persistedAuditSummary(entry),
      })),
    });

    // `detail.data.files` is intentionally discarded. Aisle stores only provenance
    // metadata here and never executes or permanently mirrors upstream files.
  }
}
