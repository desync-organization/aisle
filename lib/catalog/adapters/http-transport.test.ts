// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  BoundedHttpTransport,
  RegistryBodyTooLargeError,
  RegistryTimeoutError,
  parseRetryAfter,
} from "./http-transport";

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

describe("BoundedHttpTransport", () => {
  it("retries the supported statuses, cancels discarded bodies, and uses non-zero fallback delay", async () => {
    const cancel = vi.fn(async () => undefined);
    const retryBody = new ReadableStream<Uint8Array>({ cancel });
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(retryBody, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const transport = new BoundedHttpTransport({
      baseUrl: "https://registry.example.test/api/",
      fetch: fetchMock,
      sleep,
      random: () => 0,
      backoffBaseMs: 7,
      maxAttempts: 2,
    });

    await expect(transport.getJson("items", z.object({ ok: z.literal(true) }))).resolves.toEqual({
      ok: true,
    });

    expect(cancel).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(7);
  });

  it("honors Retry-After and parses both supported header formats", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 429, { "retry-after": "2" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const transport = new BoundedHttpTransport({
      baseUrl: "https://registry.example.test/",
      fetch: fetchMock,
      sleep,
      maxAttempts: 2,
    });

    await transport.getJson("items", z.object({ ok: z.literal(true) }));

    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(parseRetryAfter("1.5", 0)).toBe(1_500);
    expect(parseRetryAfter("Thu, 01 Jan 1970 00:00:05 GMT", 1_000)).toBe(4_000);
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter("invalid", 0)).toBeNull();
  });

  it("retries a GitHub-style rate-limited 403 at its reset time", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({}, 403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "12",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const transport = new BoundedHttpTransport({
      baseUrl: "https://api.example.test/",
      fetch: fetchMock,
      sleep,
      now: () => 10_000,
      maxAttempts: 2,
    });

    await transport.getJson("search/code", z.object({ ok: z.literal(true) }));

    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("aborts a timed-out attempt", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    });
    const transport = new BoundedHttpTransport({
      baseUrl: "https://registry.example.test/",
      fetch: fetchMock,
      timeoutMs: 5,
      maxAttempts: 1,
    });

    await expect(transport.getJson("items", z.unknown())).rejects.toBeInstanceOf(
      RegistryTimeoutError,
    );
    expect(observedSignal?.aborted).toBe(true);
  });

  it("streams no more than the configured byte cap and cancels an oversized body", async () => {
    const cancel = vi.fn(async () => undefined);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"'));
        controller.enqueue(new TextEncoder().encode("too-large"));
      },
      cancel,
    });
    const transport = new BoundedHttpTransport({
      baseUrl: "https://registry.example.test/",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(body, { headers: { "content-type": "application/json" } }),
      ),
      maxAttempts: 1,
      maxJsonBytes: 12,
    });

    await expect(transport.getJson("items", z.unknown())).rejects.toBeInstanceOf(
      RegistryBodyTooLargeError,
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects insecure base URLs and paths that escape the base", async () => {
    expect(
      () => new BoundedHttpTransport({ baseUrl: "http://registry.example.test/api" }),
    ).toThrow(/HTTPS/);

    const transport = new BoundedHttpTransport({
      baseUrl: "https://registry.example.test/api/",
      fetch: vi.fn<typeof fetch>(),
    });
    await expect(transport.getJson("../private", z.unknown())).rejects.toThrow(/escaped/);
    await expect(transport.getJson("//other.example.test/items", z.unknown())).rejects.toThrow(
      /relative/,
    );
  });
});
