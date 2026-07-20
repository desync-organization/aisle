import { z } from "zod";

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_MAX_JSON_BYTES = 2 * 1024 * 1024;

type FetchImplementation = typeof fetch;
type Sleep = (milliseconds: number) => Promise<void>;

export interface BoundedHttpTransportOptions {
  baseUrl: string;
  fetch?: FetchImplementation;
  sleep?: Sleep;
  random?: () => number;
  now?: () => number;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  maxRetryDelayMs?: number;
  maxJsonBytes?: number;
}

export interface TextResponse {
  content: string;
  byteLength: number;
  contentType: string | null;
}

export class RegistryHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = "RegistryHttpError";
  }
}

export class RegistryTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Registry request exceeded the ${timeoutMs}ms attempt timeout`);
    this.name = "RegistryTimeoutError";
  }
}

export class RegistryBodyTooLargeError extends Error {
  constructor(
    readonly maxBytes: number,
    readonly observedBytes: number | null,
  ) {
    super(
      observedBytes === null
        ? `Registry response exceeded the ${maxBytes}-byte limit`
        : `Registry response was ${observedBytes} bytes, above the ${maxBytes}-byte limit`,
    );
    this.name = "RegistryBodyTooLargeError";
  }
}

export class RegistryContractError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "RegistryContractError";
  }
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null || value.trim() === "") {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`Expected an integer between 1 and ${maximum}`);
  }
  return value;
}

function validateBaseUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new TypeError("Registry base URL must be an absolute HTTPS URL", { cause: error });
  }

  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new TypeError("Registry base URL must be an HTTPS URL without credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new TypeError("Registry base URL cannot include a query string or fragment");
  }

  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/`;
  return parsed;
}

async function cancelResponse(response: Response | undefined): Promise<void> {
  if (!response?.body) {
    return;
  }
  try {
    await response.body.cancel();
  } catch {
    // Aborted and errored streams can reject cancellation. The body is still discarded.
  }
}

function contentLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = contentLength(response);
  if (declaredLength !== null && declaredLength > maxBytes) {
    await cancelResponse(response);
    throw new RegistryBodyTooLargeError(maxBytes, declaredLength);
  }

  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (!value) {
        continue;
      }

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RegistryBodyTooLargeError(maxBytes, total);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation errors from an already aborted/errored stream.
      }
    }
    throw error;
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

export class BoundedHttpTransport {
  private readonly baseUrl: URL;
  private readonly fetchImplementation: FetchImplementation;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly maxJsonBytes: number;

  constructor(options: BoundedHttpTransportOptions) {
    this.baseUrl = validateBaseUrl(options.baseUrl);
    this.fetchImplementation = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.timeoutMs = positiveInteger(options.timeoutMs, 15_000, 120_000);
    this.maxAttempts = positiveInteger(options.maxAttempts, 4, 8);
    this.backoffBaseMs = positiveInteger(options.backoffBaseMs, 250, 60_000);
    this.maxRetryDelayMs = positiveInteger(options.maxRetryDelayMs, 60_000, 300_000);
    this.maxJsonBytes = positiveInteger(options.maxJsonBytes, DEFAULT_MAX_JSON_BYTES, 16 * 1024 * 1024);
  }

  async getJson<T>(path: string, schema: z.ZodType<T>, maxBytes = this.maxJsonBytes): Promise<T> {
    const bytes = await this.request(path, "application/json", maxBytes);
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes.body);
    } catch (error) {
      throw new RegistryContractError("Registry returned invalid UTF-8 JSON", error);
    }

    let json: unknown;
    try {
      json = JSON.parse(decoded);
    } catch (error) {
      throw new RegistryContractError("Registry returned invalid JSON", error);
    }

    const result = schema.safeParse(json);
    if (!result.success) {
      throw new RegistryContractError(
        `Registry response failed validation: ${result.error.issues[0]?.message ?? "unknown error"}`,
        result.error,
      );
    }
    return result.data;
  }

  async getText(path: string, maxBytes: number): Promise<TextResponse> {
    const bytes = await this.request(path, "text/markdown, text/plain;q=0.9", maxBytes);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.body);
    } catch (error) {
      throw new RegistryContractError("Registry returned invalid UTF-8 text", error);
    }
    return {
      content,
      byteLength: bytes.body.byteLength,
      contentType: bytes.contentType,
    };
  }

  private resolvePath(path: string): URL {
    if (!path || path.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(path)) {
      throw new TypeError("Registry request path must be a non-empty relative path");
    }
    const trimmed = path.replace(/^\/+/, "");
    if (!trimmed) {
      throw new TypeError("Registry request path must be a non-empty relative path");
    }

    const resolved = new URL(trimmed, this.baseUrl);
    if (resolved.origin !== this.baseUrl.origin || !resolved.pathname.startsWith(this.baseUrl.pathname)) {
      throw new TypeError("Registry request path escaped the configured base URL");
    }
    return resolved;
  }

  private async request(
    path: string,
    accept: string,
    maxBytes: number,
  ): Promise<{ body: Uint8Array; contentType: string | null }> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 16 * 1024 * 1024) {
      throw new TypeError("Response byte limit must be between 1 and 16777216");
    }

    const url = this.resolvePath(path);
    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      let timedOut = false;
      let response: Response | undefined;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new RegistryTimeoutError(this.timeoutMs));
        }, this.timeoutMs);
      });

      try {
        response = await Promise.race([
          this.fetchImplementation(url, {
            headers: { accept },
            signal: controller.signal,
          }),
          timeout,
        ]);

        if (!response.ok) {
          const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), this.now());
          const error = new RegistryHttpError(
            `Registry returned HTTP ${response.status}`,
            response.status,
            retryAfterMs,
          );
          await cancelResponse(response);

          if (!RETRYABLE_STATUSES.has(response.status) || attempt + 1 >= this.maxAttempts) {
            throw error;
          }

          lastError = error;
          if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
          }
          await this.sleep(this.backoffDelay(attempt, retryAfterMs));
          continue;
        }

        const body = await Promise.race([readBoundedBody(response, maxBytes), timeout]);
        return { body, contentType: response.headers.get("content-type") };
      } catch (error) {
        await cancelResponse(response);

        if (
          error instanceof RegistryBodyTooLargeError ||
          error instanceof RegistryContractError ||
          (error instanceof RegistryHttpError && !RETRYABLE_STATUSES.has(error.status))
        ) {
          throw error;
        }

        lastError = timedOut ? new RegistryTimeoutError(this.timeoutMs) : error;
        if (attempt + 1 >= this.maxAttempts) {
          break;
        }
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
        await this.sleep(this.backoffDelay(attempt, null));
      } finally {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new RegistryHttpError("Registry request failed", 503, null);
  }

  private backoffDelay(attempt: number, retryAfterMs: number | null): number {
    if (retryAfterMs !== null) {
      return Math.min(retryAfterMs, this.maxRetryDelayMs);
    }
    const exponential = this.backoffBaseMs * 2 ** attempt;
    const jitter = exponential * 0.25 * this.random();
    return Math.min(Math.max(1, Math.ceil(exponential + jitter)), this.maxRetryDelayMs);
  }
}
