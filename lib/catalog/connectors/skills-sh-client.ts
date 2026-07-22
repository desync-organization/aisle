import { getVercelOidcToken } from "@vercel/oidc";
import { z } from "zod";

import { cancelBestEffort, readBoundedResponse, requestTimeout } from "../http-safety";

const v1SkillSchema = z
  .object({
    id: z.string().min(1).max(1_024),
    slug: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    source: z.string().min(1).max(512),
    installs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sourceType: z.string().min(1).max(64),
    installUrl: z.url().max(2_048).nullable(),
    url: z.url().max(2_048),
    hash: z.string().min(1).max(256).nullable().optional(),
    duplicate: z.boolean().optional(),
    isDuplicate: z.boolean().optional(),
  });

const paginationSchema = z.object({
  page: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  perPage: z.number().int().positive().max(500),
  total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  hasMore: z.boolean(),
});

export const skillsShListResponseSchema = z.object({
  data: z.array(v1SkillSchema).max(500),
  pagination: paginationSchema,
});

const detailFileSchema = z.object({
  path: z.string().min(1).max(4_096),
  contents: z.string(),
});

const auditTimestampSchema = z
  .iso.datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

export const skillsShDetailResponseSchema = z.object({
  id: z.string().min(1).max(1_024),
  source: z.string().min(1).max(512),
  slug: z.string().min(1).max(256),
  installs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  hash: z.string().min(1).max(256).nullable(),
  files: z.array(detailFileSchema).nullable(),
});

const auditEntrySchema = z
  .object({
    provider: z.string().min(1).max(128),
    slug: z.string().min(1).max(128),
    status: z.enum(["pass", "warn", "fail"]),
    summary: z.string().min(1).max(4_096),
    auditedAt: auditTimestampSchema.optional(),
    riskLevel: z.string().min(1).max(128).optional(),
  });

export const skillsShAuditResponseSchema = z.object({
  id: z.string().min(1).max(1_024),
  source: z.string().min(1).max(512),
  slug: z.string().min(1).max(256),
  audits: z.array(auditEntrySchema).max(128),
});

const errorResponseSchema = z
  .object({
    error: z.string().max(4_096).optional(),
    message: z.string().max(4_096).optional(),
  });

export type SkillsShListResponse = z.infer<typeof skillsShListResponseSchema>;
export type SkillsShSkill = z.infer<typeof v1SkillSchema>;
export type SkillsShDetailResponse = z.infer<typeof skillsShDetailResponseSchema>;
export type SkillsShAuditResponse = z.infer<typeof skillsShAuditResponseSchema>;

export interface SkillsShCacheMetadata {
  etag: string | null;
  lastModified: string | null;
  cacheControl: string | null;
}

export type SkillsShFetchResult<T> =
  | ({ notModified: true; data: null } & SkillsShCacheMetadata)
  | ({ notModified: false; data: T } & SkillsShCacheMetadata);

export class SkillsShAuthenticationError extends Error {
  readonly status = 401;

  constructor(message = "skills.sh credentials are missing or invalid") {
    super(message);
    this.name = "SkillsShAuthenticationError";
  }
}

export class SkillsShHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = "SkillsShHttpError";
  }
}

export class SkillsShContractError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SkillsShContractError";
  }
}

type TokenProvider = () => Promise<string | undefined>;
type Sleep = (milliseconds: number) => Promise<void>;

export interface SkillsShClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  tokenProvider?: TokenProvider;
  sleep?: Sleep;
  random?: () => number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  maxRetryDelayMs?: number;
  maxResponseBytes?: number;
}

async function defaultTokenProvider(): Promise<string | undefined> {
  const localToken =
    // SKILLS_SH_TOKEN is a deprecated compatibility alias for early Aisle environments.
    process.env.SKILLS_SH_OIDC_TOKEN?.trim() || process.env.SKILLS_SH_TOKEN?.trim();
  if (localToken) {
    return localToken;
  }

  try {
    return (await getVercelOidcToken()).trim() || undefined;
  } catch {
    return undefined;
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function encodeSkillId(id: string): string {
  return id.split("/").map(encodeURIComponent).join("/");
}

export class SkillsShClient {
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly tokenProvider: TokenProvider;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: SkillsShClientOptions = {}) {
    const baseUrl = new URL(options.baseUrl ?? "https://skills.sh/api/v1");
    if (
      baseUrl.origin !== "https://skills.sh" ||
      baseUrl.username ||
      baseUrl.password
    ) {
      throw new TypeError(
        "Authenticated skills.sh requests are restricted to the exact https://skills.sh origin",
      );
    }
    this.baseUrl = baseUrl.toString().replace(/\/$/, "");
    this.fetchImplementation = options.fetch ?? fetch;
    this.tokenProvider = options.tokenProvider ?? defaultTokenProvider;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.maxAttempts = Math.max(options.maxAttempts ?? 4, 1);
    this.backoffBaseMs = Math.max(options.backoffBaseMs ?? 250, 1);
    this.maxRetryDelayMs = Math.max(options.maxRetryDelayMs ?? 60_000, 1);
    this.maxResponseBytes = Math.max(options.maxResponseBytes ?? 8_388_608, 1_024);
  }

  async listSkills(page: number, perPage = 500): Promise<SkillsShFetchResult<SkillsShListResponse>> {
    const parameters = new URLSearchParams({
      view: "all-time",
      page: String(page),
      per_page: String(perPage),
    });
    const result = await this.request(
      `/skills?${parameters.toString()}`,
      skillsShListResponseSchema,
    );
    if (!result.notModified && result.data.pagination.page !== page) {
      throw new SkillsShContractError(
        `skills.sh returned page ${result.data.pagination.page} while page ${page} was requested`,
      );
    }
    return result;
  }

  detail(
    id: string,
    cache?: { etag?: string | null; lastModified?: string | null },
  ): Promise<SkillsShFetchResult<SkillsShDetailResponse>> {
    return this.request(`/skills/${encodeSkillId(id)}`, skillsShDetailResponseSchema, cache);
  }

  async audit(id: string): Promise<SkillsShFetchResult<SkillsShAuditResponse>> {
    try {
      return await this.request(`/skills/audit/${encodeSkillId(id)}`, skillsShAuditResponseSchema);
    } catch (error) {
      if (error instanceof SkillsShHttpError && error.status === 404) {
        const segments = id.split("/");
        return {
          notModified: false,
          data: {
            id,
            source: segments.slice(0, -1).join("/"),
            slug: segments.at(-1) ?? id,
            audits: [],
          },
          etag: null,
          lastModified: null,
          cacheControl: null,
        };
      }
      throw error;
    }
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    cache?: { etag?: string | null; lastModified?: string | null },
  ): Promise<SkillsShFetchResult<T>> {
    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const token = await this.tokenProvider();
      if (!token) {
        throw new SkillsShAuthenticationError(
          "skills.sh sync requires request-scoped Vercel OIDC or SKILLS_SH_OIDC_TOKEN for local development",
        );
      }

      const headers = new Headers({
        accept: "application/json",
        authorization: `Bearer ${token}`,
      });
      if (cache?.etag) {
        headers.set("if-none-match", cache.etag);
      }
      if (cache?.lastModified) {
        headers.set("if-modified-since", cache.lastModified);
      }

      let response: Response;
      try {
        response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
          headers,
          redirect: "manual",
          signal: requestTimeout(),
        });
      } catch (error) {
        lastError = error;
        if (attempt + 1 >= this.maxAttempts) {
          break;
        }
        await this.sleep(this.backoffDelay(attempt, null));
        continue;
      }

      const metadata: SkillsShCacheMetadata = {
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        cacheControl: response.headers.get("cache-control"),
      };
      if (response.status === 304) {
        return { notModified: true, data: null, ...metadata };
      }
      if (response.status >= 300 && response.status < 400) {
        cancelBestEffort(response.body, "skills.sh redirect discarded");
        throw new SkillsShHttpError("skills.sh redirects are not followed", response.status, null);
      }

      if (!response.ok) {
        const errorBytes = await readBoundedResponse(response, 16_384).catch(
          () => new Uint8Array(),
        );
        let errorJson: unknown = {};
        try {
          errorJson = JSON.parse(new TextDecoder().decode(errorBytes));
        } catch {
          errorJson = {};
        }
        const body = errorResponseSchema.safeParse(errorJson);
        const message = body.success
          ? body.data.message || body.data.error || `skills.sh returned HTTP ${response.status}`
          : `skills.sh returned HTTP ${response.status}`;
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        const error =
          response.status === 401
            ? new SkillsShAuthenticationError(message)
            : new SkillsShHttpError(message, response.status, retryAfterMs);

        if (![429, 503].includes(response.status) || attempt + 1 >= this.maxAttempts) {
          throw error;
        }
        lastError = error;
        await this.sleep(this.backoffDelay(attempt, retryAfterMs));
        continue;
      }

      let json: unknown;
      try {
        const bytes = await readBoundedResponse(response, this.maxResponseBytes);
        json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch (error) {
        throw new SkillsShContractError("skills.sh returned invalid JSON", error);
      }
      const decoded = schema.safeParse(json);
      if (!decoded.success) {
        throw new SkillsShContractError(
          `skills.sh response failed validation: ${decoded.error.issues[0]?.message ?? "unknown error"}`,
          decoded.error,
        );
      }
      return { notModified: false, data: decoded.data, ...metadata };
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new SkillsShHttpError("skills.sh request failed", 503, null);
  }

  private backoffDelay(attempt: number, retryAfterMs: number | null): number {
    if (retryAfterMs !== null) {
      return Math.min(retryAfterMs, this.maxRetryDelayMs);
    }
    const exponential = this.backoffBaseMs * 2 ** attempt;
    const jitter = exponential * 0.25 * this.random();
    return Math.min(Math.ceil(exponential + jitter), this.maxRetryDelayMs);
  }
}
