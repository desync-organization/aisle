import { z } from "zod";

import {
  normalizeGitHubSkillIdentity,
  type GitHubSkillIdentity,
} from "./github-identity";
import {
  BoundedHttpTransport,
  type BoundedHttpTransportOptions,
  RegistryContractError,
  type TextResponse,
} from "./http-transport";

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_DETAIL_BYTES = 512 * 1024;
export const ASKSKILL_MAX_RAW_BYTES = 200 * 1024;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const badgeSchema = z.union([
  z.array(z.string().min(1).max(128)).max(50),
  z.record(z.string().min(1).max(128), z.boolean()),
]);

const providerSkillSchema = z
  .object({
    id: z.union([z.number().int().nonnegative(), z.string().min(1).max(512)]),
    installRef: z.string().min(1).max(4_096).nullable().optional(),
    name: z.string().min(1).max(256),
    skillName: z.string().min(1).max(256).optional(),
    description: z.string().max(20_000).nullable().optional(),
    tags: z.array(z.string().min(1).max(128)).max(100).optional(),
    stars: z.number().int().nonnegative().optional(),
    favoriteCount: z.number().int().nonnegative().optional(),
    aiScore: z.number().min(0).max(100).nullable().optional(),
    llmScore: z.number().min(0).max(100).nullable().optional(),
    aiBreakdown: z.record(z.string(), z.number().min(0).max(100)).nullable().optional(),
    owner: z.string().min(1).max(256).optional(),
    repoOwner: z.string().min(1).max(256).optional(),
    repo: z.string().min(1).max(256).optional(),
    repoName: z.string().min(1).max(256).optional(),
    path: z.string().min(1).max(2_048),
    filePath: z.string().min(1).max(2_048).optional(),
    updatedAt: z.string().min(1).max(128).optional(),
    source: z.string().min(1).max(128).nullable().optional(),
    publishedSlug: z.string().min(1).max(512).nullable().optional(),
    verified: z.boolean().optional(),
    official: z.boolean().optional(),
    badges: badgeSchema.optional(),
  })
  .passthrough();

const paginationSchema = z
  .object({
    page: z.number().int().positive(),
    limit: z.number().int().positive().max(MAX_PAGE_SIZE),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
    totalIsEstimate: z.boolean(),
    hasMore: z.boolean(),
    pageWindowLimited: z.boolean(),
  })
  .passthrough();

const listResponseSchema = z
  .object({
    data: z.array(providerSkillSchema),
    pagination: paginationSchema,
  })
  .passthrough();

const detailResponseSchema = providerSkillSchema;

export interface AskSkillProviderObservations {
  aiScore: number | null;
  llmScore: number | null;
  scoreBreakdown: Readonly<Record<string, number>> | null;
  favoriteCount: number | null;
  verifiedBadge: boolean | null;
  officialBadge: boolean | null;
  badges: readonly string[];
  sourceLabel: string | null;
}

export interface AskSkillSkill {
  providerRecordId: string;
  name: string;
  description: string | null;
  tags: readonly string[];
  identity: GitHubSkillIdentity;
  immutableRef: null;
  installRefObservation: string | null;
  providerObservations: AskSkillProviderObservations;
  stars: number | null;
  updatedAtObservation: string | null;
  publishedSlugObservation: string | null;
}

export interface AskSkillPage {
  skills: AskSkillSkill[];
  pagination: {
    page: number;
    limit: number;
    reportedTotal: number;
    reportedTotalPages: number;
    totalIsEstimate: boolean;
    hasMore: boolean;
    pageWindowLimited: boolean;
    nextPage: number | null;
    reachableWindowExhausted: boolean;
  };
  snapshot: {
    immutable: false;
    complete: false;
    reason: "provider_page_window" | "estimated_total" | "mutable_page_listing";
  };
}

export interface TransientAskSkillRaw extends TextResponse {
  transient: true;
}

export interface AskSkillClientOptions
  extends Omit<BoundedHttpTransportOptions, "baseUrl" | "maxJsonBytes"> {
  baseUrl?: string;
  maxPageBytes?: number;
  maxDetailBytes?: number;
  maxRawBytes?: number;
}

function oneAlias(label: string, ...values: Array<string | undefined>): string {
  const present = values.map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  if (present.length === 0) {
    throw new RegistryContractError(`AskSkill record is missing ${label}`);
  }
  if (new Set(present.map((value) => value.toLowerCase())).size !== 1) {
    throw new RegistryContractError(`AskSkill record has conflicting ${label} values`);
  }
  return present[0] ?? "";
}

function providerBadges(skill: z.infer<typeof providerSkillSchema>): string[] {
  const observed = new Set<string>();
  if (Array.isArray(skill.badges)) {
    for (const badge of skill.badges) {
      observed.add(badge);
    }
  } else if (skill.badges) {
    for (const [badge, enabled] of Object.entries(skill.badges)) {
      if (enabled) {
        observed.add(badge);
      }
    }
  }
  return [...observed].sort((left, right) => left.localeCompare(right));
}

function normalizeSkill(skill: z.infer<typeof providerSkillSchema>): AskSkillSkill {
  const owner = oneAlias("GitHub owner", skill.owner, skill.repoOwner);
  const repository = oneAlias("GitHub repository", skill.repo, skill.repoName);
  const identity = normalizeGitHubSkillIdentity({
    owner,
    repository,
    path: skill.filePath ?? skill.path,
    pathIncludesSkillFile: skill.filePath !== undefined,
  });

  if (skill.filePath) {
    const directoryIdentity = normalizeGitHubSkillIdentity({
      owner,
      repository,
      path: skill.path,
      pathIncludesSkillFile: false,
    });
    if (directoryIdentity.skillFilePath !== identity.skillFilePath) {
      throw new RegistryContractError("AskSkill file path conflicts with its skill directory");
    }
  }
  if (skill.skillName && skill.skillName.toLowerCase() !== skill.name.toLowerCase()) {
    throw new RegistryContractError("AskSkill name aliases conflict");
  }

  return {
    providerRecordId: String(skill.id),
    name: skill.name,
    description: skill.description?.trim() || null,
    tags: [...(skill.tags ?? [])],
    identity,
    immutableRef: null,
    installRefObservation: skill.installRef?.trim() || null,
    providerObservations: {
      aiScore: skill.aiScore ?? null,
      llmScore: skill.llmScore ?? null,
      scoreBreakdown: skill.aiBreakdown ? { ...skill.aiBreakdown } : null,
      favoriteCount: skill.favoriteCount ?? null,
      verifiedBadge: skill.verified ?? null,
      officialBadge: skill.official ?? null,
      badges: providerBadges(skill),
      sourceLabel: skill.source?.trim() || null,
    },
    stars: skill.stars ?? null,
    updatedAtObservation: skill.updatedAt?.trim() || null,
    publishedSlugObservation: skill.publishedSlug?.trim() || null,
  };
}

function pageInput(page: number, limit: number): void {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new RangeError("AskSkill page must be a positive safe integer");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new RangeError(`AskSkill limit must be between 1 and ${MAX_PAGE_SIZE}`);
  }
}

function safeIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  if (!trimmed || trimmed.length > 1_024 || CONTROL_CHARACTER_PATTERN.test(trimmed)) {
    throw new TypeError("AskSkill identifier is invalid");
  }
  return encodeURIComponent(trimmed);
}

function cappedBytes(value: number | undefined, fallback: number, hardCap: number, label: string): number {
  const chosen = Math.min(value ?? fallback, hardCap);
  if (!Number.isSafeInteger(chosen) || chosen <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return chosen;
}

export class AskSkillClient {
  private readonly transport: BoundedHttpTransport;
  private readonly maxPageBytes: number;
  private readonly maxDetailBytes: number;
  private readonly maxRawBytes: number;

  constructor(options: AskSkillClientOptions = {}) {
    const { baseUrl, maxPageBytes, maxDetailBytes, maxRawBytes, ...transportOptions } = options;
    this.maxPageBytes = cappedBytes(
      maxPageBytes,
      DEFAULT_MAX_PAGE_BYTES,
      DEFAULT_MAX_PAGE_BYTES,
      "AskSkill page byte limit",
    );
    this.maxDetailBytes = cappedBytes(
      maxDetailBytes,
      DEFAULT_MAX_DETAIL_BYTES,
      DEFAULT_MAX_DETAIL_BYTES,
      "AskSkill detail byte limit",
    );
    this.maxRawBytes = cappedBytes(
      maxRawBytes,
      ASKSKILL_MAX_RAW_BYTES,
      ASKSKILL_MAX_RAW_BYTES,
      "AskSkill raw byte limit",
    );
    this.transport = new BoundedHttpTransport({
      ...transportOptions,
      baseUrl: baseUrl ?? "https://askill.sh/api/v1/",
      maxJsonBytes: this.maxPageBytes,
    });
  }

  async listSkills(page = 1, limit = DEFAULT_PAGE_SIZE): Promise<AskSkillPage> {
    pageInput(page, limit);
    const query = new URLSearchParams({ page: String(page), limit: String(limit) });
    const response = await this.transport.getJson(
      `skills?${query.toString()}`,
      listResponseSchema,
      this.maxPageBytes,
    );

    if (response.pagination.page !== page || response.pagination.limit !== limit) {
      throw new RegistryContractError(
        `AskSkill returned page ${response.pagination.page}/limit ${response.pagination.limit} for page ${page}/limit ${limit}`,
      );
    }

    const reachableWindowExhausted =
      !response.pagination.hasMore || response.pagination.page >= response.pagination.totalPages;
    const nextPage = reachableWindowExhausted ? null : response.pagination.page + 1;
    const reason = response.pagination.pageWindowLimited
      ? "provider_page_window"
      : response.pagination.totalIsEstimate
        ? "estimated_total"
        : "mutable_page_listing";

    return {
      skills: response.data.map(normalizeSkill),
      pagination: {
        page: response.pagination.page,
        limit: response.pagination.limit,
        reportedTotal: response.pagination.total,
        reportedTotalPages: response.pagination.totalPages,
        totalIsEstimate: response.pagination.totalIsEstimate,
        hasMore: response.pagination.hasMore,
        pageWindowLimited: response.pagination.pageWindowLimited,
        nextPage,
        reachableWindowExhausted,
      },
      snapshot: { immutable: false, complete: false, reason },
    };
  }

  async detail(identifier: string): Promise<AskSkillSkill> {
    const response = await this.transport.getJson(
      `skills/${safeIdentifier(identifier)}`,
      detailResponseSchema,
      this.maxDetailBytes,
    );
    return normalizeSkill(response);
  }

  async rawForValidation(identifier: string): Promise<TransientAskSkillRaw> {
    const response = await this.transport.getText(
      `skills/${safeIdentifier(identifier)}/raw`,
      this.maxRawBytes,
    );
    if (response.contentType && !response.contentType.toLowerCase().startsWith("text/")) {
      throw new RegistryContractError("AskSkill raw endpoint returned a non-text content type");
    }
    return { ...response, transient: true };
  }
}
