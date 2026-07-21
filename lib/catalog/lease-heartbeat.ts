import type { CatalogRepository } from "../db/repository";

export interface SyncLeaseHeartbeat {
  assertActive(): Promise<void>;
  stop(): Promise<void>;
}

export function startSyncLeaseHeartbeat(
  repository: CatalogRepository,
  input: {
    runId: string;
    leaseToken: string;
    leaseDurationMs: number;
    intervalMs: number;
  },
): SyncLeaseHeartbeat {
  let lost: unknown = null;
  let pending = Promise.resolve();
  const renew = () => {
    pending = pending
      .then(() =>
        repository.renewSyncLease(input.runId, input.leaseToken, input.leaseDurationMs),
      )
      .catch((error: unknown) => {
        lost = error;
      });
  };
  const timer = setInterval(renew, Math.max(input.intervalMs, 10));
  timer.unref?.();

  async function assertActive(): Promise<void> {
    await pending;
    if (lost) throw lost;
  }

  return {
    assertActive,
    async stop() {
      clearInterval(timer);
      await assertActive();
    },
  };
}
