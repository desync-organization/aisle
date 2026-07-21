import { z } from "zod";

import {
  BoundedHttpTransport,
  type BoundedHttpTransportOptions,
  RegistryContractError,
} from "./http-transport";

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_CURSOR_LENGTH = 4_096;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const safeNumber = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const authorHandle = z
  .string()
  .regex(/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/iu)
  .max(39);
const repositoryName = z.string().regex(/^[A-Za-z\d._-]{1,100}$/u);
const tag = z.string().regex(/^[a-z\d]+(?:-[a-z\d]+)*$/u).max(128);

const searchRequestSchema = z
  .object({
    authorHandle: authorHandle.optional(),
    categories: z.array(z.string().min(1).max(128)).max(32).optional(),
    cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
    limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
    repoName: repositoryName.optional(),
    query: z.string().min(1).max(4_096).optional(),
    rewriteQuery: z.boolean().optional(),
    searchMode: z.enum(["keyword", "semantic"]).optional(),
    sort: z
      .enum([
        "newest",
        "updated",
        "views",
        "downloads-trending",
        "downloads-all-time",
        "stars",
      ])
      .optional(),
    tags: z.array(z.string().min(1).max(128)).max(32).optional(),
  })
  .strict();

const aiMatchSchema = z
  .object({
    itemKey: z.string().max(512).optional(),
    score: z.number().finite().optional(),
    snippet: z.string().max(20_000).optional(),
    sourcePath: z.string().max(2_048).optional(),
    version: z.string().max(256).optional(),
  })
  .strict();

const authorSchema = z
  .object({
    avatarUrl: z.string().max(4_096).nullable().optional(),
    bio: z.string().max(20_000).nullable().optional(),
    githubUrl: z.url().max(4_096).optional(),
    handle: authorHandle,
    isVerified: z.boolean().optional(),
    name: z.string().max(512).nullable().optional(),
    repoCount: safeInteger.optional(),
    skillCount: safeInteger.optional(),
  })
  .strict();

const staticAuditSchema = z
  .object({
    isBlocked: z.boolean(),
    overallScore: z.number().int().min(0).max(100),
    riskLevel: z.enum(["safe", "low", "medium", "high", "critical"]),
    safeToPublish: z.boolean(),
    status: z.enum(["pass", "fail"]),
    summary: z.string().max(20_000),
    syncTime: safeInteger,
  })
  .strict();

const providerSkillSchema = z
  .object({
    aiMatch: aiMatchSchema.optional(),
    author: authorSchema.optional(),
    authorHandle: authorHandle.optional(),
    createdAt: safeInteger.optional(),
    description: z.string().max(20_000),
    downloadsAllTime: safeInteger.optional(),
    downloadsTrending: safeInteger.optional(),
    forkCount: safeNumber.optional(),
    id: z.string().min(1).max(512),
    isVerified: z.boolean().optional(),
    latestAuditScore: z.number().int().min(0).max(100).optional(),
    latestSnapshotId: z.string().max(512).optional(),
    latestSnapshotTotalBytes: safeInteger.optional(),
    latestVersion: z.string().max(256).optional(),
    license: z.string().max(256).optional(),
    primaryCategory: z.string().max(256).optional(),
    repoName: repositoryName.optional(),
    repoUrl: z.string().max(4_096).optional(),
    slug: z.string().regex(/^[a-z\d-]+$/u).max(256),
    stargazerCount: safeNumber.optional(),
    staticAudit: staticAuditSchema.optional(),
    syncTime: safeInteger.optional(),
    tags: z.array(tag).max(100).optional(),
    title: z.string().max(512),
    updatedAt: safeInteger.optional(),
    viewsAllTime: safeInteger.optional(),
  })
  .strict();

const searchResponseSchema = z
  .object({
    ai: z
      .object({
        raw: z.unknown().optional(),
        resolvedSkillsCount: safeInteger,
        resultCount: safeInteger,
      })
      .strict()
      .optional(),
    continueCursor: z.string().max(MAX_CURSOR_LENGTH),
    isDone: z.boolean(),
    page: z.array(providerSkillSchema).max(MAX_PAGE_SIZE),
  })
  .strict();

export type SkillsReSearchRequest = z.infer<typeof searchRequestSchema>;

export interface SkillsReSkill {
  providerRecordId: string;
  slug: string;
  title: string;
  description: string;
  primaryCategory: string | null;
  tags: readonly string[];
}

export interface SkillsRePage {
  skills: SkillsReSkill[];
  pagination: {
    requestedLimit: number;
    nextCursor: string | null;
    isDone: boolean;
  };
  snapshot: {
    immutable: false;
    complete: false;
    reason: "mutable_search_cursor_without_global_snapshot";
  };
}

export interface SkillsReClientOptions
  extends Omit<BoundedHttpTransportOptions, "baseUrl" | "maxJsonBytes"> {
  baseUrl?: string;
  maxPageBytes?: number;
}

function boundedPageBytes(value: number | undefined): number {
  const chosen = Math.min(value ?? DEFAULT_MAX_PAGE_BYTES, DEFAULT_MAX_PAGE_BYTES);
  if (!Number.isSafeInteger(chosen) || chosen <= 0) {
    throw new RangeError("Skills.re page byte limit must be a positive integer");
  }
  return chosen;
}

function assertOpaqueCursor(value: string, label: string): void {
  if (!value || value.length > MAX_CURSOR_LENGTH || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new RegistryContractError(`Skills.re ${label} cursor was invalid`);
  }
}

function normalizeSkill(skill: z.infer<typeof providerSkillSchema>): SkillsReSkill {
  return {
    providerRecordId: skill.id,
    slug: skill.slug,
    title: skill.title,
    description: skill.description,
    primaryCategory: skill.primaryCategory?.trim() || null,
    tags: [...(skill.tags ?? [])],
  };
}

export class SkillsReClient {
  private readonly transport: BoundedHttpTransport;
  private readonly maxPageBytes: number;

  constructor(options: SkillsReClientOptions = {}) {
    const { baseUrl, maxPageBytes, ...transportOptions } = options;
    this.maxPageBytes = boundedPageBytes(maxPageBytes);
    this.transport = new BoundedHttpTransport({
      ...transportOptions,
      baseUrl: baseUrl ?? "https://api.skills.re/",
      maxJsonBytes: this.maxPageBytes,
    });
  }

  async search(input: SkillsReSearchRequest = {}): Promise<SkillsRePage> {
    const parsed = searchRequestSchema.parse(input);
    if (parsed.cursor !== undefined) {
      assertOpaqueCursor(parsed.cursor, "request");
    }
    const requestedLimit = parsed.limit ?? DEFAULT_PAGE_SIZE;
    const response = await this.transport.postJsonQuery(
      "skills/search",
      { ...parsed, limit: requestedLimit },
      searchResponseSchema,
      this.maxPageBytes,
    );

    if (response.page.length > requestedLimit) {
      throw new RegistryContractError(
        `Skills.re returned ${response.page.length} records for a ${requestedLimit}-record page`,
      );
    }

    const providerRecordIds = new Set<string>();
    for (const skill of response.page) {
      if (providerRecordIds.has(skill.id)) {
        throw new RegistryContractError("Skills.re returned a duplicate provider ID in one page");
      }
      providerRecordIds.add(skill.id);
    }

    let nextCursor: string | null = null;
    if (!response.isDone) {
      assertOpaqueCursor(response.continueCursor, "continuation");
      if (response.continueCursor === parsed.cursor) {
        throw new RegistryContractError("Skills.re returned a non-advancing continuation cursor");
      }
      nextCursor = response.continueCursor;
    }

    return {
      skills: response.page.map(normalizeSkill),
      pagination: {
        requestedLimit,
        nextCursor,
        isDone: response.isDone,
      },
      snapshot: {
        immutable: false,
        complete: false,
        reason: "mutable_search_cursor_without_global_snapshot",
      },
    };
  }
}
