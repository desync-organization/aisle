import { ZodError } from "zod";

import {
  CatalogSyncLeaseLostError,
  type CatalogRepository,
} from "../db/repository";
import {
  CatalogIngestionService,
  type DiscoveryRecordValidator,
  type OfficialPublisherPolicy,
} from "./ingestion";
import { startSyncLeaseHeartbeat } from "./lease-heartbeat";
import { CatalogNormalizationError } from "./normalization";
import {
  type CatalogSourceConnector,
  type ConnectorSyncResult,
} from "./source-contract";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CatalogSyncOrchestratorOptions {
  validateRecord: DiscoveryRecordValidator;
  officialPublisherPolicy?: OfficialPublisherPolicy;
  unavailableAfterCompleteMisses?: number;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
}

export class CatalogSyncOrchestrator {
  private readonly ingestion: CatalogIngestionService;
  private readonly unavailableAfterCompleteMisses: number;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;

  constructor(
    private readonly repository: CatalogRepository,
    options: CatalogSyncOrchestratorOptions,
  ) {
    this.ingestion = new CatalogIngestionService(
      repository,
      options.validateRecord,
      options.officialPublisherPolicy,
    );
    this.unavailableAfterCompleteMisses = Math.max(
      options.unavailableAfterCompleteMisses ?? 2,
      1,
    );
    this.leaseDurationMs = Math.max(options.leaseDurationMs ?? 300_000, 100);
    this.heartbeatIntervalMs = Math.min(
      Math.max(options.heartbeatIntervalMs ?? 30_000, 10),
      Math.max(Math.floor(this.leaseDurationMs / 2), 10),
    );
  }

  async sync(connectors: readonly CatalogSourceConnector[]): Promise<ConnectorSyncResult[]> {
    const results: ConnectorSyncResult[] = [];
    for (const connector of connectors) results.push(await this.syncConnector(connector));
    return results;
  }

  async syncConnector(connector: CatalogSourceConnector): Promise<ConnectorSyncResult> {
    try {
      return await this.runConnector(connector);
    } catch (error) {
      return {
        sourceId: connector.descriptor.id,
        status: "partial",
        processed: 0,
        failures: [message(error)],
        exclusions: connector.descriptor.knownExclusions ?? [],
      };
    }
  }

  private async runConnector(connector: CatalogSourceConnector): Promise<ConnectorSyncResult> {
    await this.repository.upsertSource({
      ...connector.descriptor,
      initialCoverageState: connector.descriptor.initialCoverageState,
      knownExclusions: connector.descriptor.knownExclusions,
    });
    if (connector.descriptor.enabled === false) {
      await this.repository.markSourceNotConfigured(
        connector.descriptor.id,
        connector.descriptor.knownExclusions ?? [],
      );
      return {
        sourceId: connector.descriptor.id,
        status: "not-configured",
        processed: 0,
        failures: [],
        exclusions: connector.descriptor.knownExclusions ?? [],
      };
    }

    const run = await this.repository.acquireSyncRun(
      connector.descriptor.id,
      this.leaseDurationMs,
      {
        resumePartial:
          connector.descriptor.freshnessPolicy !== "latest-completed-observation",
      },
    );
    const fence = {
      sourceId: connector.descriptor.id,
      runId: run.id,
      leaseToken: run.leaseToken,
    };
    const heartbeat = startSyncLeaseHeartbeat(this.repository, {
      runId: run.id,
      leaseToken: run.leaseToken,
      leaseDurationMs: this.leaseDurationMs,
      intervalMs: this.heartbeatIntervalMs,
    });
    let cursor = run.cursor;
    let processed = run.processedCount;
    let pageCount = run.pageCount;
    const checkpoint = run.checkpointJson as { reportedTotalKnown?: boolean };
    let reportedTotalMode: "unset" | "reported" | "absent" =
      checkpoint.reportedTotalKnown === true
        ? "reported"
        : checkpoint.reportedTotalKnown === false && run.resumed
          ? "absent"
          : "unset";
    let reportedTotal = reportedTotalMode === "absent" ? null : run.sourceTotal;
    let completeSnapshot = false;
    let sawPage = false;
    let sawTerminalPage = false;
    let degraded = false;
    const failures: string[] = [];
    const exclusions = new Set<string>(connector.descriptor.knownExclusions ?? []);

    try {
      for await (const page of connector.enumerate({ cursor })) {
        await heartbeat.assertActive();
        const pageTotalMode = page.reportedTotal === null ? "absent" : "reported";
        if (reportedTotalMode !== "unset" && reportedTotalMode !== pageTotalMode) {
          throw new Error("Connector changed reported-total semantics during one snapshot");
        }
        if (
          page.reportedTotal !== null &&
          (!Number.isSafeInteger(page.reportedTotal) || page.reportedTotal < 0)
        ) {
          throw new Error("Connector reported an invalid total");
        }
        if (
          page.reportedTotal !== null &&
          reportedTotalMode === "reported" &&
          reportedTotal !== null &&
          page.reportedTotal !== reportedTotal
        ) {
          throw new Error(
            `Connector reported-total drifted from ${reportedTotal} to ${page.reportedTotal}`,
          );
        }
        reportedTotalMode = pageTotalMode;
        sawPage = true;
        completeSnapshot = page.completeSnapshot;
        degraded ||= page.degraded ?? false;
        reportedTotal = page.reportedTotal ?? reportedTotal;
        for (const exclusion of page.exclusions ?? []) exclusions.add(exclusion);

        const transientFailures: string[] = [];
        for (const candidate of page.records) {
          try {
            await this.ingestion.persist(fence, candidate);
            processed += 1;
          } catch (error) {
            if (error instanceof ZodError || error instanceof CatalogNormalizationError) {
              degraded = true;
              exclusions.add(`Rejected malformed public record: ${message(error)}`);
            } else {
              transientFailures.push(message(error));
            }
          }
        }
        if (transientFailures.length) {
          failures.push(...transientFailures);
          throw new Error("Connector page was not fully durable; the page will be replayed");
        }

        pageCount += 1;
        if (page.hasMore && (!page.nextCursor || page.nextCursor === cursor)) {
          throw new Error("Connector returned hasMore without an advancing cursor");
        }
        cursor = page.nextCursor;
        await this.repository.checkpointSyncRun({
          runId: run.id,
          leaseToken: run.leaseToken,
          nextPage: pageCount,
          pageCount,
          processedCount: processed,
          sourceTotal: reportedTotal ?? processed,
          cursor,
          reportedTotalKnown: reportedTotalMode === "reported",
          leaseDurationMs: this.leaseDurationMs,
        });
        if (!page.hasMore) {
          sawTerminalPage = true;
          break;
        }
      }

      const recordCount = await this.repository.countSourceListings(connector.descriptor.id);
      const seenCount = await this.repository.countListingsSeenInRun(
        connector.descriptor.id,
        run.id,
      );
      await heartbeat.stop();
      await this.repository.renewSyncLease(run.id, run.leaseToken, this.leaseDurationMs);
      const coverageFailures: string[] = [];
      if (degraded) coverageFailures.push("Connector reported contract-degraded coverage");
      if (!sawPage) coverageFailures.push("Connector produced no pages");
      else if (!sawTerminalPage) coverageFailures.push("Connector ended before a terminal page");
      else if (!completeSnapshot) coverageFailures.push("Terminal page did not declare a complete snapshot");
      if (seenCount !== processed) {
        coverageFailures.push(
          `Snapshot observed ${processed} records but persisted ${seenCount} distinct source identities`,
        );
      }
      if (
        reportedTotalMode === "reported" &&
        (reportedTotal === null || processed !== reportedTotal || seenCount !== reportedTotal)
      ) {
        coverageFailures.push(
          `Snapshot proved ${seenCount} distinct durable records and ${processed} observations for reported total ${reportedTotal ?? "unknown"}`,
        );
      }
      const reportedTotalConsistent =
        reportedTotalMode !== "reported" ||
        (reportedTotal !== null && processed === reportedTotal && seenCount === reportedTotal);
      const observationSweepComplete =
        sawPage &&
        sawTerminalPage &&
        !degraded &&
        seenCount === processed &&
        reportedTotalConsistent;
      const completeCrawl =
        observationSweepComplete &&
        completeSnapshot &&
        coverageFailures.length === 0;
      await this.repository.finishSyncRun({
        runId: run.id,
        leaseToken: run.leaseToken,
        sourceId: connector.descriptor.id,
        sourceTotal: reportedTotal ?? recordCount,
        recordCount,
        partialFailures: coverageFailures,
        exclusions: [...exclusions],
        completeCrawl,
        observationSweepComplete,
        unavailableAfter: this.unavailableAfterCompleteMisses,
      });

      return {
        sourceId: connector.descriptor.id,
        status: completeCrawl ? "current" : "partial",
        processed,
        failures: coverageFailures,
        exclusions: [...exclusions],
      };
    } catch (error) {
      await heartbeat.stop().catch(() => undefined);
      failures.push(message(error));
      if (!(error instanceof CatalogSyncLeaseLostError)) {
        await this.repository
          .failSyncRun({
            runId: run.id,
            leaseToken: run.leaseToken,
            sourceId: connector.descriptor.id,
            message: message(error),
          })
          .catch((failureError: unknown) => {
            failures.push(message(failureError));
          });
      }
      return {
        sourceId: connector.descriptor.id,
        status: "partial",
        processed,
        failures,
        exclusions: [...exclusions],
      };
    }
  }
}

export function coverageStatement(entry: {
  name: string;
  mode: string;
  state: string;
  recordCount: number;
  lastSuccessfulSyncAt: Date | null;
  error: string | null;
}): string {
  const label = `${entry.name} (${entry.mode})`;
  if (entry.state === "not-configured") {
    return `${label}: not configured; no records are claimed.`;
  }
  if (entry.state === "credentials-required") {
    return `${label}: credentials are required; the existing ${entry.recordCount} records are not claimed current.`;
  }
  if (!entry.lastSuccessfulSyncAt) {
    return `${label}: no successful sync has completed; no current coverage claim is available.`;
  }
  const timestamp = entry.lastSuccessfulSyncAt.toISOString();
  if (entry.state === "partial") {
    return `${label}: partial at ${timestamp}; ${entry.recordCount} retained records, with error: ${entry.error ?? "see source details"}.`;
  }
  return `${label}: ${entry.recordCount} records indexed as of ${timestamp}.`;
}
