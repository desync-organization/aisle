import { z } from "zod";

export const SKILLMD_MAX_RAW_BYTES = 200 * 1024;

const DEFAULT_BASE_URL = "https://api.skillmd.com";
const DEFAULT_JSON_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_ERROR_MAX_BYTES = 64 * 1024;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const skillMdListItemWireSchema = z
  .object({
    slug: z.string().min(1),
    type: z.string().min(1),
    title: z.string().min(1),
    description: z.string(),
    verified: z.boolean(),
    agents: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    avg_rating: z.number().nonnegative().nullable().optional(),
    rating_count: z.number().int().nonnegative().optional(),
    raw_url: z.string().url().nullable().optional(),
  })
  .passthrough();

export const skillMdListResponseSchema = z
  .object({
    items: z.array(skillMdListItemWireSchema),
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().nonnegative(),
  })
  .passthrough();

const skillMdInventoryItemWireSchema = z
  .object({
    path: z.string().min(1),
    size_bytes: z.number().int().nonnegative(),
    is_script: z.union([z.boolean(), z.literal(0), z.literal(1)]),
    storage: z.string().min(1),
  })
  .passthrough();

const skillMdDetailWireSchema = z
  .object({
    slug: z.string().min(1),
    title: z.string().min(1),
    description: z.string(),
    type: z.string().min(1),
    verified: z.boolean(),
    avg_rating: z.number().nonnegative().nullable().optional(),
    rating_count: z.number().int().nonnegative().optional(),
    install_count: z.number().int().nonnegative().optional(),
    license: z.string().nullable(),
    source_repo: z.string().nullable(),
    commit_sha: z.string().min(1).nullable(),
    last_synced_at: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    install_snippet: z.string().nullable(),
    raw_url: z.string().url().nullable().optional(),
    bundle_url: z.string().url().nullable().optional(),
    files: z.array(skillMdInventoryItemWireSchema).nullable().optional(),
    inventory: z.array(skillMdInventoryItemWireSchema).nullable().optional(),
    body_md: z.string().optional(),
    raw_md: z.string().optional(),
  })
  .passthrough();

export interface SkillMdListItem {
  slug: string;
  type: string;
  title: string;
  description: string;
  verified: boolean;
  /** SkillMD's publisher badge, not a security or code-safety attestation. */
  verified_scope: "provider-badge-only";
  agents?: string | null;
  category?: string | null;
  avg_rating?: number | null;
  rating_count?: number;
  raw_url?: string | null;
}

export interface SkillMdInventoryItem {
  path: string;
  size_bytes: number;
  is_script: boolean | 0 | 1;
  storage: string;
}

/**
 * The only detail shape callers may persist. The wire response's `body_md` and
 * `raw_md` fields are deliberately absent; raw SKILL.md access is a separate,
 * bounded and transient operation.
 */
export interface SkillMdSkillMetadata {
  slug: string;
  title: string;
  description: string;
  type: string;
  verified: boolean;
  /** SkillMD's publisher badge, not a security or code-safety attestation. */
  verified_scope: "provider-badge-only";
  avg_rating?: number | null;
  rating_count?: number;
  install_count?: number;
  license: string | null;
  source_repo: string | null;
  commit_sha: string | null;
  last_synced_at?: string | null;
  category?: string | null;
  /** Provider display metadata only. Never pass this value to a shell. */
  install_snippet: string | null;
  raw_url?: string | null;
  bundle_url?: string | null;
  inventory: SkillMdInventoryItem[];
}

export interface SkillMdListPage {
  items: SkillMdListItem[];
  limit: number;
  offset: number;
  /** Null once SkillMD returns fewer than `limit` records. */
  nextOffset: number | null;
}

export interface SkillMdRequestOptions {
  signal?: AbortSignal;
}

export interface SkillMdListOptions extends SkillMdRequestOptions {
  limit?: number;
  offset?: number;
}

type Sleep = (milliseconds: number) => Promise<void>;

export interface SkillMdClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: Sleep;
  random?: () => number;
  now?: () => number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  maxRetryDelayMs?: number;
  requestTimeoutMs?: number;
  jsonMaxBytes?: number;
  /** Test overrides are allowed, but production reads are always capped at 200 KiB. */
  maxRawBytes?: number;
}

export class SkillMdSlugError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillMdSlugError";
  }
}

export class SkillMdContractError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SkillMdContractError";
  }
}

export class SkillMdHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = "SkillMdHttpError";
  }
}

export class SkillMdPayloadTooLargeError extends Error {
  constructor(
    readonly maximumBytes: number,
    readonly observedBytes: number | null,
  ) {
    super(
      observedBytes === null
        ? `SkillMD response exceeded the ${maximumBytes}-byte limit`
        : `SkillMD response was ${observedBytes} bytes, exceeding the ${maximumBytes}-byte limit`,
    );
    this.name = "SkillMdPayloadTooLargeError";
  }
}

export class SkillMdTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`SkillMD request exceeded its ${timeoutMs}ms timeout`);
    this.name = "SkillMdTimeoutError";
  }
}

interface RequestSignal {
  signal: AbortSignal;
  dispose: () => void;
}

interface TextResponse {
  response: Response;
  text: string;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

export function parseSkillMdRetryAfter(
  value: string | null,
  now = Date.now(),
): number | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** Accepts only SkillMD's canonical `owner/name` slug form. */
export function splitSkillMdSlug(slug: string): { owner: string; name: string } {
  if (slug !== slug.trim() || slug.length > 512) {
    throw new SkillMdSlugError("SkillMD slug must be a canonical owner/name value");
  }

  const segments = slug.split("/");
  if (segments.length !== 2) {
    throw new SkillMdSlugError("SkillMD slug must contain exactly one owner/name separator");
  }

  const [owner, name] = segments;
  const invalidSegment = (segment: string | undefined): boolean =>
    !segment ||
    segment.length > 255 ||
    segment === "." ||
    segment === ".." ||
    /[\\/?#\s\u0000-\u001f\u007f]/u.test(segment) ||
    /%(?:2f|5c)/iu.test(segment);

  if (invalidSegment(owner) || invalidSegment(name) || owner === undefined || name === undefined) {
    throw new SkillMdSlugError("SkillMD slug contains an invalid owner or name segment");
  }

  return { owner, name };
}

function encodeSlug(slug: string): string {
  const { owner, name } = splitSkillMdSlug(slug);
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function createRequestSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): RequestSignal {
  const controller = new AbortController();
  const timeoutError = new SkillMdTimeoutError(timeoutMs);
  const timeout = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const abortFromExternal = (): void => {
    controller.abort(
      externalSignal?.reason ?? new DOMException("The operation was aborted", "AbortError"),
    );
  };

  if (externalSignal?.aborted) {
    abortFromExternal();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    },
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function cancelBody(response: Response, reason: unknown): Promise<void> {
  if (!response.body) {
    return;
  }
  await response.body.cancel(reason).catch(() => undefined);
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const contentLengthHeader = response.headers.get("content-length")?.trim();
  if (contentLengthHeader && /^\d+$/u.test(contentLengthHeader)) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isSafeInteger(contentLength) && contentLength > maximumBytes) {
      const error = new SkillMdPayloadTooLargeError(maximumBytes, contentLength);
      await cancelBody(response, error);
      throw error;
    }
  }

  if (!response.body) {
    if (signal.aborted) {
      throw abortReason(signal);
    }
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let observedBytes = 0;
  const cancelOnAbort = (): void => {
    void reader.cancel(abortReason(signal)).catch(() => undefined);
  };
  signal.addEventListener("abort", cancelOnAbort, { once: true });

  try {
    while (true) {
      if (signal.aborted) {
        throw abortReason(signal);
      }

      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      observedBytes += value.byteLength;
      if (observedBytes > maximumBytes) {
        const error = new SkillMdPayloadTooLargeError(maximumBytes, observedBytes);
        await reader.cancel(error).catch(() => undefined);
        throw error;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }

    if (signal.aborted) {
      throw abortReason(signal);
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } catch (error) {
    if (error instanceof SkillMdPayloadTooLargeError) {
      throw error;
    }
    if (signal.aborted) {
      throw abortReason(signal);
    }
    throw new SkillMdContractError("SkillMD returned an unreadable UTF-8 response", error);
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }
}

function errorMessage(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof body.message === "string" && body.message.trim()) {
      return body.message;
    }
    if (typeof body.error === "string" && body.error.trim()) {
      return body.error;
    }
  } catch {
    // SkillMD sometimes returns a gateway's text or HTML error response.
  }
  return `SkillMD returned HTTP ${status}`;
}

function toListItem(
  item: z.infer<typeof skillMdListItemWireSchema>,
): SkillMdListItem {
  return {
    slug: item.slug,
    type: item.type,
    title: item.title,
    description: item.description,
    verified: item.verified,
    verified_scope: "provider-badge-only",
    ...(item.agents !== undefined ? { agents: item.agents } : {}),
    ...(item.category !== undefined ? { category: item.category } : {}),
    ...(item.avg_rating !== undefined ? { avg_rating: item.avg_rating } : {}),
    ...(item.rating_count !== undefined ? { rating_count: item.rating_count } : {}),
    ...(item.raw_url !== undefined ? { raw_url: item.raw_url } : {}),
  };
}

function toInventoryItem(
  item: z.infer<typeof skillMdInventoryItemWireSchema>,
): SkillMdInventoryItem {
  return {
    path: item.path,
    size_bytes: item.size_bytes,
    is_script: item.is_script,
    storage: item.storage,
  };
}

function toMetadata(
  detail: z.infer<typeof skillMdDetailWireSchema>,
): SkillMdSkillMetadata {
  const inventory = detail.inventory ?? detail.files ?? [];
  return {
    slug: detail.slug,
    title: detail.title,
    description: detail.description,
    type: detail.type,
    verified: detail.verified,
    verified_scope: "provider-badge-only",
    ...(detail.avg_rating !== undefined ? { avg_rating: detail.avg_rating } : {}),
    ...(detail.rating_count !== undefined ? { rating_count: detail.rating_count } : {}),
    ...(detail.install_count !== undefined ? { install_count: detail.install_count } : {}),
    license: detail.license,
    source_repo: detail.source_repo,
    commit_sha: detail.commit_sha,
    ...(detail.last_synced_at !== undefined
      ? { last_synced_at: detail.last_synced_at }
      : {}),
    ...(detail.category !== undefined ? { category: detail.category } : {}),
    install_snippet: detail.install_snippet,
    ...(detail.raw_url !== undefined ? { raw_url: detail.raw_url } : {}),
    ...(detail.bundle_url !== undefined ? { bundle_url: detail.bundle_url } : {}),
    inventory: inventory.map(toInventoryItem),
  };
}

export class SkillMdClient {
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly jsonMaxBytes: number;
  private readonly maxRawBytes: number;

  constructor(options: SkillMdClientOptions = {}) {
    const baseUrl = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
    if (!(["http:", "https:"] as const).includes(baseUrl.protocol as "http:" | "https:")) {
      throw new TypeError("SkillMD base URL must use HTTP or HTTPS");
    }
    if (baseUrl.username || baseUrl.password) {
      throw new TypeError("SkillMD base URL must not contain credentials");
    }

    this.baseUrl = baseUrl.toString().replace(/\/$/u, "");
    this.fetchImplementation = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.maxAttempts = clampInteger(options.maxAttempts ?? 4, 1, 10);
    this.backoffBaseMs = clampInteger(options.backoffBaseMs ?? 250, 1, 60_000);
    this.maxRetryDelayMs = clampInteger(options.maxRetryDelayMs ?? 60_000, 1, 300_000);
    this.requestTimeoutMs = clampInteger(options.requestTimeoutMs ?? 10_000, 1, 120_000);
    this.jsonMaxBytes = clampInteger(
      options.jsonMaxBytes ?? DEFAULT_JSON_MAX_BYTES,
      1,
      10 * 1024 * 1024,
    );
    this.maxRawBytes = clampInteger(
      options.maxRawBytes ?? SKILLMD_MAX_RAW_BYTES,
      1,
      SKILLMD_MAX_RAW_BYTES,
    );
  }

  async listSkills(options: SkillMdListOptions = {}): Promise<SkillMdListPage> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("SkillMD list limit must be an integer from 1 through 100");
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError("SkillMD list offset must be a non-negative safe integer");
    }

    const parameters = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    const { text } = await this.request(
      `/v1/skills?${parameters.toString()}`,
      "application/json",
      this.jsonMaxBytes,
      options.signal,
    );
    const parsed = this.decodeJson(text, skillMdListResponseSchema, "list");
    if (parsed.offset !== offset) {
      throw new SkillMdContractError(
        `SkillMD returned offset ${parsed.offset} while offset ${offset} was requested`,
      );
    }
    if (parsed.limit !== limit) {
      throw new SkillMdContractError(
        `SkillMD returned limit ${parsed.limit} while limit ${limit} was requested`,
      );
    }
    if (parsed.items.length > parsed.limit) {
      throw new SkillMdContractError(
        `SkillMD returned ${parsed.items.length} items for a ${parsed.limit}-item page`,
      );
    }

    return {
      items: parsed.items.map(toListItem),
      limit: parsed.limit,
      offset: parsed.offset,
      nextOffset:
        parsed.items.length === parsed.limit
          ? parsed.offset + parsed.items.length
          : null,
    };
  }

  async detail(
    slug: string,
    options: SkillMdRequestOptions = {},
  ): Promise<SkillMdSkillMetadata> {
    const encodedSlug = encodeSlug(slug);
    const { text } = await this.request(
      `/v1/skills/${encodedSlug}`,
      "application/json",
      this.jsonMaxBytes,
      options.signal,
    );
    const parsed = this.decodeJson(text, skillMdDetailWireSchema, "detail");
    if (parsed.slug !== slug) {
      throw new SkillMdContractError(
        `SkillMD detail slug ${parsed.slug} did not match requested slug ${slug}`,
      );
    }
    return toMetadata(parsed);
  }

  /**
   * Returns raw SKILL.md transiently. This client never caches it, and every
   * read is stream-bounded to at most 200 KiB.
   */
  async rawSkillMd(slug: string, options: SkillMdRequestOptions = {}): Promise<string> {
    const encodedSlug = encodeSlug(slug);
    const { text } = await this.request(
      `/api/skills/${encodedSlug}/raw`,
      "text/markdown, text/plain;q=0.9",
      this.maxRawBytes,
      options.signal,
    );
    return text;
  }

  private decodeJson<T>(text: string, schema: z.ZodType<T>, endpoint: string): T {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new SkillMdContractError(`SkillMD ${endpoint} returned invalid JSON`, error);
    }

    const decoded = schema.safeParse(json);
    if (!decoded.success) {
      throw new SkillMdContractError(
        `SkillMD ${endpoint} response failed validation: ${decoded.error.issues[0]?.message ?? "unknown error"}`,
        decoded.error,
      );
    }
    return decoded.data;
  }

  private async request(
    path: string,
    accept: string,
    maximumBytes: number,
    externalSignal: AbortSignal | undefined,
  ): Promise<TextResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      if (externalSignal?.aborted) {
        throw abortReason(externalSignal);
      }

      const requestSignal = createRequestSignal(externalSignal, this.requestTimeoutMs);
      try {
        const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
          method: "GET",
          headers: { accept },
          cache: "no-store",
          redirect: "manual",
          signal: requestSignal.signal,
        });

        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new SkillMdHttpError(
            "SkillMD redirects are not followed",
            response.status,
            null,
          );
        }

        if (!response.ok) {
          let body = "";
          try {
            body = await readBoundedText(
              response,
              Math.min(DEFAULT_ERROR_MAX_BYTES, maximumBytes),
              requestSignal.signal,
            );
          } catch (error) {
            if (requestSignal.signal.aborted) {
              throw abortReason(requestSignal.signal);
            }
            if (!(error instanceof SkillMdPayloadTooLargeError)) {
              throw error;
            }
          }

          const retryAfterMs = parseSkillMdRetryAfter(
            response.headers.get("retry-after"),
            this.now(),
          );
          const httpError = new SkillMdHttpError(
            errorMessage(response.status, body),
            response.status,
            retryAfterMs,
          );
          if (!RETRYABLE_STATUSES.has(response.status) || attempt + 1 >= this.maxAttempts) {
            throw httpError;
          }

          lastError = httpError;
          requestSignal.dispose();
          await this.sleep(this.retryDelay(attempt, retryAfterMs));
          continue;
        }

        const text = await readBoundedText(response, maximumBytes, requestSignal.signal);
        return { response, text };
      } catch (error) {
        if (externalSignal?.aborted) {
          throw abortReason(externalSignal);
        }

        const normalizedError =
          requestSignal.signal.aborted &&
          requestSignal.signal.reason instanceof SkillMdTimeoutError
            ? requestSignal.signal.reason
            : error;
        if (
          normalizedError instanceof SkillMdContractError ||
          normalizedError instanceof SkillMdPayloadTooLargeError ||
          normalizedError instanceof SkillMdHttpError
        ) {
          throw normalizedError;
        }

        lastError = normalizedError;
        if (attempt + 1 >= this.maxAttempts) {
          break;
        }
        requestSignal.dispose();
        await this.sleep(this.retryDelay(attempt, null));
      } finally {
        requestSignal.dispose();
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new SkillMdHttpError("SkillMD request failed", 503, null);
  }

  private retryDelay(attempt: number, retryAfterMs: number | null): number {
    if (retryAfterMs !== null) {
      return Math.min(retryAfterMs, this.maxRetryDelayMs);
    }

    const exponential = this.backoffBaseMs * 2 ** attempt;
    const random = Math.min(Math.max(this.random(), 0), 1);
    const jitter = exponential * 0.25 * random;
    return Math.min(Math.ceil(exponential + jitter), this.maxRetryDelayMs);
  }
}
