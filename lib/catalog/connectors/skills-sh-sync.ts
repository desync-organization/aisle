import type { CatalogRepository } from "../../db/repository";
import {
  SkillsShAuthenticationError,
  SkillsShClient,
  SkillsShHttpError,
  type SkillsShSkill,
} from "./skills-sh-client";

export interface SkillsShSyncOptions {
  sourceId?: string;
  perPage?: number;
  detailConcurrency?: number;
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

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(values.length, 1)) }, () => worker()),
  );
  return results;
}

export class SkillsShSync {
  private readonly sourceId: string;
  private readonly perPage: number;
  private readonly detailConcurrency: number;

  constructor(
    private readonly repository: CatalogRepository,
    private readonly client: SkillsShClient,
    options: SkillsShSyncOptions = {},
  ) {
    this.sourceId = options.sourceId ?? "skills-sh";
    this.perPage = Math.min(Math.max(options.perPage ?? 500, 1), 500);
    this.detailConcurrency = Math.min(Math.max(options.detailConcurrency ?? 8, 1), 32);
  }

  async run(): Promise<SkillsShSyncResult> {
    const incomplete = await this.repository.latestIncompleteRun(this.sourceId);
    const resumed = Boolean(incomplete);
    const run = await this.repository.createSyncRun(
      this.sourceId,
      incomplete ? { runId: incomplete.id, nextPage: incomplete.nextPage } : undefined,
    );
    let pageNumber = incomplete?.nextPage ?? run.nextPage;
    let pageCount = incomplete?.pageCount ?? 0;
    let processed = incomplete?.processedCount ?? 0;
    let sourceTotal = incomplete?.sourceTotal ?? null;
    const failures: string[] = [];

    try {
      while (true) {
        const response = await this.client.listSkills(pageNumber, this.perPage);
        if (response.notModified) {
          throw new Error("skills.sh listing unexpectedly returned 304 without a conditional request");
        }

        sourceTotal = response.data.pagination.total;
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

        pageCount += 1;
        processed += response.data.data.length;
        pageNumber = response.data.pagination.page + 1;
        await this.repository.checkpointSyncRun({
          runId: run.id,
          nextPage: pageNumber,
          pageCount,
          processedCount: processed,
          sourceTotal,
          cursor: response.data.pagination.hasMore ? `page:${pageNumber}` : null,
        });

        if (!response.data.pagination.hasMore) {
          break;
        }
      }

      const recordCount = await this.repository.countSourceListings(this.sourceId);
      await this.repository.finishSyncRun({
        runId: run.id,
        sourceId: this.sourceId,
        sourceTotal: sourceTotal ?? recordCount,
        recordCount,
        partialFailures: failures,
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
      const authenticationFailure = error instanceof SkillsShAuthenticationError;
      const retryAfterMs = error instanceof SkillsShHttpError ? error.retryAfterMs : null;
      await this.repository.failSyncRun({
        runId: run.id,
        sourceId: this.sourceId,
        message: errorMessage(error),
        retryCount: error instanceof SkillsShHttpError ? 1 : 0,
        nextRetryAt: retryAfterMs === null ? null : new Date(Date.now() + retryAfterMs),
        authMissing: authenticationFailure,
      });
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
      raw: listing,
    });

    if (listingHash && stored.previousHash === listingHash) {
      return;
    }

    const detail = await this.client.detail(listing.id, {
      etag: stored.detailEtag,
      lastModified: stored.detailLastModified,
    });
    if (detail.notModified) {
      await this.repository.updateSourceListingHydration({
        listingId: stored.id,
        hash: stored.previousHash,
        etag: detail.etag ?? stored.detailEtag,
        lastModified: detail.lastModified ?? stored.detailLastModified,
      });
      return;
    }
    if (detail.data.id !== listing.id) {
      throw new Error(`skills.sh detail id ${detail.data.id} did not match ${listing.id}`);
    }

    await this.repository.updateSourceListingHydration({
      listingId: stored.id,
      hash: detail.data.hash,
      etag: detail.etag,
      lastModified: detail.lastModified,
    });

    if (!detail.data.hash || stored.previousHash === detail.data.hash) {
      return;
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
      upstreamContentHash: detail.data.hash,
      audits: audit.data.audits.map((entry) => ({
        provider: entry.provider,
        providerSlug: entry.slug,
        status: entry.status,
        summary: entry.summary,
        riskLevel: entry.riskLevel,
        auditedAt: entry.auditedAt,
        raw: entry,
      })),
    });

    // `detail.data.files` is intentionally discarded. Aisle stores only provenance
    // metadata here and never executes or permanently mirrors upstream files.
  }
}
