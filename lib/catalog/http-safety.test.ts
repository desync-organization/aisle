// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { cancelBestEffort, readBoundedResponse } from "./http-safety";

function nextTask<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), 0));
}

describe("catalog HTTP safety", () => {
  it.each(["declared length", "streamed bytes"] as const)(
    "does not await a never-settling cancellation for oversized %s",
    async (scenario) => {
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (scenario === "streamed bytes") {
            controller.enqueue(new Uint8Array([1, 2]));
          }
        },
        cancel,
      });
      const response = new Response(body, {
        headers: scenario === "declared length" ? { "content-length": "2" } : {},
      });
      const outcome = await Promise.race([
        readBoundedResponse(response, 1).then(
          () => "resolved",
          () => "rejected",
        ),
        nextTask("cancel-blocked"),
      ]);

      expect(outcome).toBe("rejected");
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it("swallows synchronous cancellation failures and asynchronous rejections", async () => {
    expect(() =>
      cancelBestEffort({
        cancel() {
          throw new Error("inert synchronous cancellation failure");
        },
      }),
    ).not.toThrow();

    cancelBestEffort({
      cancel: () => Promise.reject(new Error("inert asynchronous cancellation failure")),
    });
    await Promise.resolve();
    await Promise.resolve();
  });
});
