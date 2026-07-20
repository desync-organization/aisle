import { z } from "zod";

import {
  githubBranchHint,
  identityFromRepositoryFullName,
  type GitHubSkillIdentity,
} from "./github-identity";
import {
  BoundedHttpTransport,
  type BoundedHttpTransportOptions,
  RegistryContractError,
} from "./http-transport";

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGE_BYTES = 2 * 1024 * 1024;

const providerSkillSchema = z
  .object({
    id: z.union([z.string().min(1).max(512), z.number().int().nonnegative()]),
    name: z.string().min(1).max(256),
    description: z.string().max(10_000).optional(),
    author: z.string().min(1).max(256),
    scopedName: z.string().min(1).max(512).optional(),
    scoped_name: z.string().min(1).max(512).optional(),
    githubUrl: z.string().min(1).max(4_096).optional(),
    github_url: z.string().min(1).max(4_096).optional(),
    repoFullName: z.string().min(1).max(256).optional(),
    repo_full_name: z.string().min(1).max(256).optional(),
    path: z.string().min(1).max(2_048),
    branch: z.string().min(1).max(255).optional(),
    stars: z.number().int().nonnegative().optional(),
    forks: z.number().int().nonnegative().optional(),
    category: z.string().min(1).max(256).optional(),
    hasContent: z.boolean().optional(),
    has_content: z.boolean().optional(),
  })
  .passthrough();

const listResponseSchema = z
  .object({
    skills: z.array(providerSkillSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(MAX_PAGE_SIZE),
    offset: z.number().int().nonnegative(),
  })
  .passthrough();

export interface AgentSkillsInSkill {
  providerRecordId: string;
  name: string;
  description: string | null;
  scopedName: string;
  identity: GitHubSkillIdentity;
  githubUrlObservation: string;
  branchHint: string | null;
  immutableRef: null;
  stars: number | null;
  forks: number | null;
  category: string | null;
  contentReportedAvailable: boolean | null;
}

export interface AgentSkillsInPage {
  skills: AgentSkillsInSkill[];
  pagination: {
    offset: number;
    limit: number;
    reportedTotal: number;
    nextOffset: number | null;
    hasMore: boolean;
    stalledBeforeReportedEnd: boolean;
  };
  snapshot: {
    immutable: false;
    complete: false;
    reason: "mutable_offset_listing_requires_stable_sweeps";
  };
}

export interface AgentSkillsInClientOptions
  extends Omit<BoundedHttpTransportOptions, "baseUrl" | "maxJsonBytes"> {
  baseUrl?: string;
  maxPageBytes?: number;
}

function oneAlias(label: string, ...values: Array<string | undefined>): string {
  const present = values.map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  if (present.length === 0) {
    throw new RegistryContractError(`AgentSkills.in record is missing ${label}`);
  }
  if (new Set(present.map((value) => value.toLowerCase())).size !== 1) {
    throw new RegistryContractError(`AgentSkills.in record has conflicting ${label} values`);
  }
  return present[0] ?? "";
}

function normalizeScopedName(value: string, owner: string, name: string): string {
  const match = /^@([^/]+)\/(.+)$/.exec(value);
  if (
    !match ||
    match[1]?.toLowerCase() !== owner.toLowerCase() ||
    match[2]?.toLowerCase() !== name.toLowerCase()
  ) {
    throw new RegistryContractError("AgentSkills.in scoped name conflicts with its GitHub identity");
  }
  return `@${match[1]}/${match[2]}`;
}

function normalizeSkill(skill: z.infer<typeof providerSkillSchema>): AgentSkillsInSkill {
  const repositoryFullName = oneAlias(
    "repository identity",
    skill.repoFullName,
    skill.repo_full_name,
  );
  const githubUrl = oneAlias("GitHub URL", skill.githubUrl, skill.github_url);
  const identity = identityFromRepositoryFullName({
    repositoryFullName,
    path: skill.path,
    pathIncludesSkillFile: true,
    repositoryUrlObservation: githubUrl,
  });

  if (skill.author.trim().toLowerCase() !== identity.owner.toLowerCase()) {
    throw new RegistryContractError("AgentSkills.in author conflicts with its GitHub repository owner");
  }

  const scopedName = normalizeScopedName(
    oneAlias("scoped name", skill.scopedName, skill.scoped_name),
    identity.owner,
    skill.name,
  );

  return {
    providerRecordId: String(skill.id),
    name: skill.name,
    description: skill.description?.trim() || null,
    scopedName,
    identity,
    githubUrlObservation: githubUrl,
    branchHint: githubBranchHint(githubUrl, skill.branch),
    immutableRef: null,
    stars: skill.stars ?? null,
    forks: skill.forks ?? null,
    category: skill.category?.trim() || null,
    contentReportedAvailable: skill.hasContent ?? skill.has_content ?? null,
  };
}

function validatePageInput(offset: number, limit: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError("AgentSkills.in offset must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new RangeError(`AgentSkills.in limit must be between 1 and ${MAX_PAGE_SIZE}`);
  }
}

export class AgentSkillsInClient {
  private readonly transport: BoundedHttpTransport;
  private readonly maxPageBytes: number;

  constructor(options: AgentSkillsInClientOptions = {}) {
    const { baseUrl, maxPageBytes, ...transportOptions } = options;
    this.maxPageBytes = Math.min(maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES, DEFAULT_MAX_PAGE_BYTES);
    if (!Number.isSafeInteger(this.maxPageBytes) || this.maxPageBytes <= 0) {
      throw new RangeError("AgentSkills.in page byte limit must be a positive integer");
    }
    this.transport = new BoundedHttpTransport({
      ...transportOptions,
      baseUrl: baseUrl ?? "https://www.agentskills.in/api/",
      maxJsonBytes: this.maxPageBytes,
    });
  }

  async listSkills(offset = 0, limit = DEFAULT_PAGE_SIZE): Promise<AgentSkillsInPage> {
    validatePageInput(offset, limit);
    const query = new URLSearchParams({
      search: "",
      offset: String(offset),
      limit: String(limit),
    });
    const response = await this.transport.getJson(
      `skills?${query.toString()}`,
      listResponseSchema,
      this.maxPageBytes,
    );

    if (response.offset !== offset || response.limit !== limit) {
      throw new RegistryContractError(
        `AgentSkills.in returned offset ${response.offset}/limit ${response.limit} for offset ${offset}/limit ${limit}`,
      );
    }

    const skills = response.skills.map(normalizeSkill);
    const advancedOffset = response.offset + skills.length;
    const stalledBeforeReportedEnd = skills.length === 0 && advancedOffset < response.total;
    const hasMore = skills.length > 0 && advancedOffset < response.total;

    return {
      skills,
      pagination: {
        offset: response.offset,
        limit: response.limit,
        reportedTotal: response.total,
        nextOffset: hasMore ? advancedOffset : null,
        hasMore,
        stalledBeforeReportedEnd,
      },
      snapshot: {
        immutable: false,
        complete: false,
        reason: "mutable_offset_listing_requires_stable_sweeps",
      },
    };
  }
}
