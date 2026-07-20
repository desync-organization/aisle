import { z } from "zod";

export const GITHUB_REST_API_VERSION = "2026-03-10";
export const GITHUB_CODE_SEARCH_RESULT_CAP = 1_000;
export const GITHUB_CODE_SEARCH_MAX_PAGE_SIZE = 100;
export const GITHUB_CODE_SEARCH_MAX_QUERY_LENGTH = 200;

const SHA_1_PATTERN = /^[a-f\d]{40}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const RAW_SYNTAX_PATTERN = /[*?:"'`\\{}[\]()|&]/;
const BOOLEAN_OPERATOR_PATTERN = /(?:^|\s)(?:AND|OR|NOT)(?:\s|$)/i;
const NEGATED_TOKEN_PATTERN = /(?:^|\s)-\S/;

const repositoryOwnerSchema = z
  .object({
    login: z.string().min(1).max(256),
  })
  .passthrough();

export const githubSearchRepositorySchema = z
  .object({
    id: z.number().int().nonnegative(),
    name: z.string().min(1).max(256),
    full_name: z.string().min(3).max(512),
    private: z.boolean(),
    owner: repositoryOwnerSchema,
    html_url: z.string().min(1).max(4_096),
    url: z.string().min(1).max(4_096),
    visibility: z.enum(["public", "private", "internal"]).optional(),
    archived: z.boolean().optional(),
    disabled: z.boolean().optional(),
  })
  .passthrough();

export const githubCodeSearchItemSchema = z
  .object({
    name: z.string().min(1).max(256),
    path: z.string().min(1).max(2_048),
    sha: z.string().regex(SHA_1_PATTERN),
    url: z.string().min(1).max(4_096),
    git_url: z.string().min(1).max(4_096),
    html_url: z.string().min(1).max(4_096),
    repository: githubSearchRepositorySchema,
  })
  .passthrough();

export const githubCodeSearchResponseSchema = z
  .object({
    total_count: z.number().int().nonnegative(),
    incomplete_results: z.boolean(),
    items: z.array(githubCodeSearchItemSchema).max(GITHUB_CODE_SEARCH_MAX_PAGE_SIZE),
  })
  .passthrough();

export type GitHubCodeSearchWireItem = z.infer<typeof githubCodeSearchItemSchema>;
export type GitHubCodeSearchWireResponse = z.infer<typeof githubCodeSearchResponseSchema>;

export interface ComposedGitHubCodeSearchQuery {
  userQuery: string;
  githubQuery: string;
  page: number;
  perPage: number;
  requestPath: string;
}

/**
 * Live contract verified 2026-07-21 against GitHub REST Code Search.
 * GitHub owns both qualifiers; callers can supply terms, never raw search syntax.
 * See https://docs.github.com/en/rest/search/search and
 * https://docs.github.com/en/rest/about-the-rest-api/api-versions.
 */
export function composeGitHubCodeSearchQuery(
  query: string,
  page = 1,
  perPage = GITHUB_CODE_SEARCH_MAX_PAGE_SIZE,
): ComposedGitHubCodeSearchQuery {
  const normalized = query.trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw new TypeError("GitHub Code Search requires a non-empty user query");
  }
  if (normalized.length > GITHUB_CODE_SEARCH_MAX_QUERY_LENGTH) {
    throw new RangeError(
      `GitHub Code Search query cannot exceed ${GITHUB_CODE_SEARCH_MAX_QUERY_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new TypeError("GitHub Code Search query cannot contain control characters");
  }
  if (
    RAW_SYNTAX_PATTERN.test(normalized) ||
    BOOLEAN_OPERATOR_PATTERN.test(normalized) ||
    NEGATED_TOKEN_PATTERN.test(normalized)
  ) {
    throw new TypeError("GitHub Code Search query cannot contain raw qualifiers or operators");
  }
  const searchableCharacters = normalized.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  if (searchableCharacters < 2) {
    throw new TypeError("GitHub Code Search query must contain at least two letters or numbers");
  }
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new RangeError("GitHub Code Search page must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(perPage) ||
    perPage < 1 ||
    perPage > GITHUB_CODE_SEARCH_MAX_PAGE_SIZE
  ) {
    throw new RangeError(
      `GitHub Code Search page size must be between 1 and ${GITHUB_CODE_SEARCH_MAX_PAGE_SIZE}`,
    );
  }
  if ((page - 1) * perPage >= GITHUB_CODE_SEARCH_RESULT_CAP) {
    throw new RangeError(
      `GitHub Code Search cannot page beyond its ${GITHUB_CODE_SEARCH_RESULT_CAP}-result cap`,
    );
  }

  const githubQuery = `${normalized} filename:SKILL.md is:public`;
  const parameters = new URLSearchParams({
    q: githubQuery,
    page: String(page),
    per_page: String(perPage),
  });
  return {
    userQuery: normalized,
    githubQuery,
    page,
    perPage,
    requestPath: `search/code?${parameters.toString()}`,
  };
}
