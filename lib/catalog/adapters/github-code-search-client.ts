import { z } from "zod";

import {
  GITHUB_CODE_SEARCH_RESULT_CAP,
  GITHUB_REST_API_VERSION,
  composeGitHubCodeSearchQuery,
  githubCodeSearchResponseSchema,
  type GitHubCodeSearchWireItem,
} from "./github-code-search-contract";
import {
  normalizeGitHubSkillIdentity,
  type GitHubSkillIdentity,
} from "./github-identity";
import {
  BoundedHttpTransport,
  type BoundedHttpTransportOptions,
  RegistryBodyTooLargeError,
  RegistryContractError,
  RegistryHttpError,
} from "./http-transport";

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TREE_BYTES = 8 * 1024 * 1024;
const MAX_RESOLUTION_PATH_DEPTH = 32;
const SHA_1_PATTERN = /^[a-f\d]{40}$/i;
const TOKEN_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

type TokenProvider = () => Promise<string | undefined>;

const repositoryDetailSchema = z
  .object({
    id: z.number().int().nonnegative(),
    name: z.string().min(1).max(256),
    full_name: z.string().min(3).max(512),
    private: z.boolean(),
    visibility: z.enum(["public", "private", "internal"]).optional(),
    html_url: z.string().min(1).max(4_096),
    owner: z.object({ login: z.string().min(1).max(256) }).passthrough(),
  })
  .passthrough();

const gitCommitSchema = z
  .object({
    sha: z.string().regex(SHA_1_PATTERN),
    tree: z
      .object({
        sha: z.string().regex(SHA_1_PATTERN),
      })
      .passthrough(),
  })
  .passthrough();

const treeEntrySchema = z
  .object({
    path: z.string().min(1).max(2_048),
    mode: z.string().min(1).max(16),
    type: z.enum(["blob", "tree", "commit"]),
    sha: z.string().regex(SHA_1_PATTERN),
    size: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const gitTreeSchema = z
  .object({
    sha: z.string().regex(SHA_1_PATTERN),
    truncated: z.boolean(),
    tree: z.array(treeEntrySchema).max(100_000),
  })
  .passthrough();

export class GitHubCodeSearchAuthenticationError extends Error {
  readonly status = 401;

  constructor(message = "GitHub Code Search requires a server-side access token") {
    super(message);
    this.name = "GitHubCodeSearchAuthenticationError";
  }
}

export interface GitHubCodeSearchResult {
  providerRecordId: string;
  repositoryIdObservation: number;
  identity: GitHubSkillIdentity;
  directoryNameObservation: string;
  blobShaObservation: string;
  blobShaKind: "git_blob";
  commitRefObservation: string | null;
  immutableRevision: null;
  contentApiUrlObservation: string;
  htmlUrlObservation: string;
  repositoryPublicEvidence: {
    queryQualifierApplied: true;
    private: false;
    visibility: "public" | null;
  };
  repositoryStateObservations: {
    archived: boolean | null;
    disabled: boolean | null;
  };
}

export interface GitHubCodeSearchPage {
  query: {
    user: string;
    composed: string;
  };
  results: GitHubCodeSearchResult[];
  pagination: {
    page: number;
    perPage: number;
    nextPage: number | null;
    reachableTotal: number;
    stalledBeforeReachableEnd: boolean;
  };
  coverage: {
    mode: "query_only";
    partial: true;
    sourceComplete: false;
    resultCap: 1_000;
    reportedTotal: number;
    resultSetCapped: boolean;
    providerIncompleteResults: boolean;
    reasons: readonly (
      | "query_scoped"
      | "github_1000_result_cap"
      | "github_incomplete_results"
      | "page_subset"
    )[];
  };
}

export type GitHubExactCommitResolution =
  | {
      resolved: true;
      commitSha: string;
      rootTreeSha: string;
      blobSha: string;
      immutableRevision: string;
      binding: "verified_non_recursive_tree_walk";
      repositoryPublicEvidence: {
        private: false;
        visibility: "public" | null;
      };
    }
  | {
      resolved: false;
      reason:
        | "missing_commit_ref"
        | "path_too_deep"
        | "repository_not_public"
        | "path_missing"
        | "path_type_mismatch"
        | "tree_truncated"
        | "tree_oversize"
        | "blob_mismatch";
    };

export interface GitHubCodeSearchClientOptions
  extends Omit<BoundedHttpTransportOptions, "baseUrl" | "fetch" | "maxJsonBytes"> {
  baseUrl?: string;
  fetch?: typeof fetch;
  tokenProvider?: TokenProvider;
  maxResponseBytes?: number;
  maxTreeBytes?: number;
}

async function defaultTokenProvider(): Promise<string | undefined> {
  if (typeof window !== "undefined") {
    throw new GitHubCodeSearchAuthenticationError(
      "GitHub Code Search credentials are server-only and cannot be used in a browser",
    );
  }
  return process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || undefined;
}

function boundedResponseBytes(value: number | undefined): number {
  const chosen = Math.min(value ?? DEFAULT_MAX_RESPONSE_BYTES, DEFAULT_MAX_RESPONSE_BYTES);
  if (!Number.isSafeInteger(chosen) || chosen <= 0) {
    throw new RangeError("GitHub response byte limit must be a positive integer");
  }
  return chosen;
}

function boundedTreeBytes(value: number | undefined): number {
  const chosen = Math.min(value ?? DEFAULT_MAX_TREE_BYTES, DEFAULT_MAX_TREE_BYTES);
  if (!Number.isSafeInteger(chosen) || chosen <= 0) {
    throw new RangeError("GitHub tree byte limit must be a positive integer");
  }
  return chosen;
}

function repositoryParts(fullName: string): { owner: string; repository: string } {
  const segments = fullName.trim().split("/");
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new RegistryContractError("GitHub search result has an invalid repository identity");
  }
  return { owner: segments[0], repository: segments[1] };
}

function validatedUrl(value: string, hostname: "github.com" | "api.github.com", label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new RegistryContractError(`GitHub ${label} is not a valid URL`, error);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw new RegistryContractError(`GitHub ${label} is not an official HTTPS GitHub URL`);
  }
  return parsed;
}

function decodedPathname(url: URL, label: string): string {
  try {
    return decodeURIComponent(url.pathname);
  } catch (error) {
    throw new RegistryContractError(`GitHub ${label} contains invalid URL encoding`, error);
  }
}

function observedCommitRef(item: GitHubCodeSearchWireItem, identity: GitHubSkillIdentity): string | null {
  const contentUrl = validatedUrl(item.url, "api.github.com", "content API URL");
  const expectedContentPath = `/repositories/${item.repository.id}/contents/${identity.skillFilePath}`;
  const contentPath = decodedPathname(contentUrl, "content API URL");
  if (
    contentPath !== expectedContentPath ||
    contentUrl.hash ||
    [...contentUrl.searchParams.keys()].some((key) => key !== "ref") ||
    contentUrl.searchParams.getAll("ref").length > 1
  ) {
    throw new RegistryContractError("GitHub content API URL conflicts with its repository or path");
  }

  const htmlUrl = validatedUrl(item.html_url, "github.com", "result URL");
  const expectedHtmlPrefix = `/${identity.owner}/${identity.repository}/blob/`;
  const expectedHtmlSuffix = `/${identity.skillFilePath}`;
  const htmlPath = decodedPathname(htmlUrl, "result URL");
  if (
    !htmlPath.startsWith(expectedHtmlPrefix) ||
    !htmlPath.endsWith(expectedHtmlSuffix) ||
    htmlUrl.search ||
    htmlUrl.hash
  ) {
    throw new RegistryContractError("GitHub result URL conflicts with its repository or path");
  }

  const repositoryApiUrl = validatedUrl(item.repository.url, "api.github.com", "repository API URL");
  if (
    decodedPathname(repositoryApiUrl, "repository API URL").replace(/\/+$/, "") !==
      `/repos/${identity.owner}/${identity.repository}` ||
    repositoryApiUrl.search ||
    repositoryApiUrl.hash
  ) {
    throw new RegistryContractError("GitHub repository API URL conflicts with its identity");
  }

  const gitUrl = validatedUrl(item.git_url, "api.github.com", "Git blob URL");
  const gitPath = decodedPathname(gitUrl, "Git blob URL");
  const allowedGitPaths = new Set([
    `/repositories/${item.repository.id}/git/blobs/${item.sha}`,
    `/repos/${identity.owner}/${identity.repository}/git/blobs/${item.sha}`,
  ]);
  if (!allowedGitPaths.has(gitPath) || gitUrl.search || gitUrl.hash) {
    throw new RegistryContractError("GitHub blob URL conflicts with the reported blob SHA");
  }

  const contentRef = contentUrl.searchParams.get("ref");
  const htmlRef = htmlPath.slice(expectedHtmlPrefix.length, -expectedHtmlSuffix.length);
  const contentSha = contentRef && SHA_1_PATTERN.test(contentRef) ? contentRef.toLowerCase() : null;
  const htmlSha = SHA_1_PATTERN.test(htmlRef) ? htmlRef.toLowerCase() : null;
  if (contentSha && htmlSha && contentSha !== htmlSha) {
    throw new RegistryContractError("GitHub search result exposes conflicting commit references");
  }
  return contentSha ?? htmlSha;
}

function normalizeSearchResult(item: GitHubCodeSearchWireItem): GitHubCodeSearchResult {
  if (item.repository.private || (item.repository.visibility && item.repository.visibility !== "public")) {
    throw new RegistryContractError("GitHub Code Search returned a repository without public evidence");
  }
  if (item.name !== "SKILL.md") {
    throw new RegistryContractError("GitHub Code Search result is not a SKILL.md file");
  }

  const repository = repositoryParts(item.repository.full_name);
  if (
    item.repository.owner.login.toLowerCase() !== repository.owner.toLowerCase() ||
    item.repository.name.toLowerCase() !== repository.repository.toLowerCase()
  ) {
    throw new RegistryContractError("GitHub repository aliases conflict");
  }
  const identity = normalizeGitHubSkillIdentity({
    ...repository,
    path: item.path,
    pathIncludesSkillFile: true,
    repositoryUrlObservation: item.repository.html_url,
  });
  const repositoryHtmlUrl = validatedUrl(
    item.repository.html_url,
    "github.com",
    "repository URL",
  );
  if (
    decodedPathname(repositoryHtmlUrl, "repository URL").replace(/\/+$/, "") !==
      `/${identity.owner}/${identity.repository}` ||
    repositoryHtmlUrl.search ||
    repositoryHtmlUrl.hash
  ) {
    throw new RegistryContractError("GitHub repository URL conflicts with its identity");
  }

  return {
    providerRecordId: `github-code-search:${item.repository.id}:${item.sha.toLowerCase()}:${identity.skillFilePath}`,
    repositoryIdObservation: item.repository.id,
    identity,
    directoryNameObservation:
      identity.directoryPath === "."
        ? identity.repository
        : (identity.directoryPath.split("/").at(-1) ?? identity.repository),
    blobShaObservation: item.sha.toLowerCase(),
    blobShaKind: "git_blob",
    commitRefObservation: observedCommitRef(item, identity),
    immutableRevision: null,
    contentApiUrlObservation: item.url,
    htmlUrlObservation: item.html_url,
    repositoryPublicEvidence: {
      queryQualifierApplied: true,
      private: false,
      visibility: item.repository.visibility === "public" ? "public" : null,
    },
    repositoryStateObservations: {
      archived: item.repository.archived ?? null,
      disabled: item.repository.disabled ?? null,
    },
  };
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

export class GitHubCodeSearchClient {
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly tokenProvider: TokenProvider;
  private readonly maxResponseBytes: number;
  private readonly maxTreeBytes: number;
  private readonly transportOptions: Omit<
    BoundedHttpTransportOptions,
    "baseUrl" | "fetch" | "maxJsonBytes"
  >;

  constructor(options: GitHubCodeSearchClientOptions = {}) {
    const {
      baseUrl,
      fetch: fetchImplementation,
      tokenProvider,
      maxResponseBytes,
      maxTreeBytes,
      ...transportOptions
    } = options;
    this.baseUrl = baseUrl ?? "https://api.github.com/";
    this.fetchImplementation = fetchImplementation ?? fetch;
    this.tokenProvider = tokenProvider ?? defaultTokenProvider;
    this.maxResponseBytes = boundedResponseBytes(maxResponseBytes);
    this.maxTreeBytes = boundedTreeBytes(maxTreeBytes);
    this.transportOptions = transportOptions;
  }

  async search(query: string, page = 1, perPage = 100): Promise<GitHubCodeSearchPage> {
    const composed = composeGitHubCodeSearchQuery(query, page, perPage);
    const transport = await this.authenticatedTransport();
    let response: z.infer<typeof githubCodeSearchResponseSchema>;
    try {
      response = await transport.getJson(
        composed.requestPath,
        githubCodeSearchResponseSchema,
        this.maxResponseBytes,
      );
    } catch (error) {
      this.rethrowAuthentication(error);
    }

    const results = response.items.map(normalizeSearchResult);
    const reachableTotal = Math.min(response.total_count, GITHUB_CODE_SEARCH_RESULT_CAP);
    const consumed = (page - 1) * perPage + results.length;
    const stalledBeforeReachableEnd = results.length === 0 && consumed < reachableTotal;
    const nextPage =
      !stalledBeforeReachableEnd && results.length > 0 && page * perPage < reachableTotal
        ? page + 1
        : null;
    const reasons: GitHubCodeSearchPage["coverage"]["reasons"][number][] = ["query_scoped"];
    if (response.total_count > GITHUB_CODE_SEARCH_RESULT_CAP) {
      reasons.push("github_1000_result_cap");
    }
    if (response.incomplete_results) {
      reasons.push("github_incomplete_results");
    }
    if (nextPage !== null || page > 1) {
      reasons.push("page_subset");
    }

    return {
      query: { user: composed.userQuery, composed: composed.githubQuery },
      results,
      pagination: {
        page,
        perPage,
        nextPage,
        reachableTotal,
        stalledBeforeReachableEnd,
      },
      coverage: {
        mode: "query_only",
        partial: true,
        sourceComplete: false,
        resultCap: 1_000,
        reportedTotal: response.total_count,
        resultSetCapped: response.total_count > GITHUB_CODE_SEARCH_RESULT_CAP,
        providerIncompleteResults: response.incomplete_results,
        reasons,
      },
    };
  }

  /**
   * Resolves a selected search result without fetching its body. The result's `sha`
   * remains a blob observation; only a matching non-recursive tree walk binds it to
   * the separately observed commit SHA.
   */
  async resolveExactCommit(result: GitHubCodeSearchResult): Promise<GitHubExactCommitResolution> {
    if (
      result.repositoryPublicEvidence.private !== false ||
      result.repositoryPublicEvidence.queryQualifierApplied !== true
    ) {
      return { resolved: false, reason: "repository_not_public" };
    }
    if (!result.commitRefObservation || !SHA_1_PATTERN.test(result.commitRefObservation)) {
      return { resolved: false, reason: "missing_commit_ref" };
    }
    if (result.identity.skillFilePath.split("/").length > MAX_RESOLUTION_PATH_DEPTH) {
      return { resolved: false, reason: "path_too_deep" };
    }

    const identity = normalizeGitHubSkillIdentity({
      owner: result.identity.owner,
      repository: result.identity.repository,
      path: result.identity.skillFilePath,
      pathIncludesSkillFile: true,
    });
    if (identity.canonicalKey !== result.identity.canonicalKey) {
      throw new RegistryContractError("GitHub resolution input contains conflicting canonical identity");
    }
    if (!SHA_1_PATTERN.test(result.blobShaObservation) || result.blobShaKind !== "git_blob") {
      throw new RegistryContractError("GitHub resolution input does not contain a valid blob observation");
    }

    const transport = await this.authenticatedTransport();
    const repositoryPath = `repos/${encodeSegment(identity.owner)}/${encodeSegment(identity.repository)}`;
    let repository: z.infer<typeof repositoryDetailSchema>;
    try {
      repository = await transport.getJson(
        repositoryPath,
        repositoryDetailSchema,
        this.maxResponseBytes,
      );
    } catch (error) {
      this.rethrowAuthentication(error);
    }
    if (repository.private || (repository.visibility && repository.visibility !== "public")) {
      return { resolved: false, reason: "repository_not_public" };
    }
    const repositoryIdentity = repositoryParts(repository.full_name);
    if (
      repositoryIdentity.owner.toLowerCase() !== identity.owner.toLowerCase() ||
      repositoryIdentity.repository.toLowerCase() !== identity.repository.toLowerCase() ||
      repository.owner.login.toLowerCase() !== identity.owner.toLowerCase() ||
      repository.id !== result.repositoryIdObservation
    ) {
      throw new RegistryContractError("GitHub repository response conflicts with the selected result");
    }
    normalizeGitHubSkillIdentity({
      owner: identity.owner,
      repository: identity.repository,
      path: identity.skillFilePath,
      pathIncludesSkillFile: true,
      repositoryUrlObservation: repository.html_url,
    });

    const commitRef = result.commitRefObservation.toLowerCase();
    let commit: z.infer<typeof gitCommitSchema>;
    try {
      commit = await transport.getJson(
        `${repositoryPath}/git/commits/${commitRef}`,
        gitCommitSchema,
        this.maxResponseBytes,
      );
    } catch (error) {
      this.rethrowAuthentication(error);
    }
    if (commit.sha.toLowerCase() !== commitRef) {
      throw new RegistryContractError("GitHub commit response conflicts with the observed commit ref");
    }

    const pathSegments = identity.skillFilePath.split("/");
    let treeSha = commit.tree.sha.toLowerCase();
    const rootTreeSha = treeSha;
    for (let index = 0; index < pathSegments.length; index += 1) {
      let tree: z.infer<typeof gitTreeSchema>;
      try {
        tree = await transport.getJson(
          `${repositoryPath}/git/trees/${treeSha}`,
          gitTreeSchema,
          this.maxTreeBytes,
        );
      } catch (error) {
        if (error instanceof RegistryHttpError && error.status === 404) {
          return { resolved: false, reason: "path_missing" };
        }
        if (error instanceof RegistryBodyTooLargeError) {
          return { resolved: false, reason: "tree_oversize" };
        }
        this.rethrowAuthentication(error);
      }
      if (tree.sha.toLowerCase() !== treeSha) {
        throw new RegistryContractError("GitHub tree response conflicts with the requested tree SHA");
      }
      if (tree.truncated) {
        return { resolved: false, reason: "tree_truncated" };
      }

      const segment = pathSegments[index];
      const matches = tree.tree.filter((entry) => entry.path === segment);
      if (matches.length === 0) {
        return { resolved: false, reason: "path_missing" };
      }
      if (matches.length > 1) {
        throw new RegistryContractError("GitHub tree contains duplicate entries for a path segment");
      }
      const entry = matches[0];
      const finalSegment = index === pathSegments.length - 1;
      if (!entry || (finalSegment ? entry.type !== "blob" : entry.type !== "tree")) {
        return { resolved: false, reason: "path_type_mismatch" };
      }
      treeSha = entry.sha.toLowerCase();
    }

    if (treeSha !== result.blobShaObservation.toLowerCase()) {
      return { resolved: false, reason: "blob_mismatch" };
    }
    return {
      resolved: true,
      commitSha: commitRef,
      rootTreeSha,
      blobSha: treeSha,
      immutableRevision: commitRef,
      binding: "verified_non_recursive_tree_walk",
      repositoryPublicEvidence: {
        private: false,
        visibility: repository.visibility === "public" ? "public" : null,
      },
    };
  }

  private async authenticatedTransport(): Promise<BoundedHttpTransport> {
    const token = (await this.tokenProvider())?.trim();
    if (!token || token.length > 4_096 || TOKEN_CONTROL_PATTERN.test(token)) {
      throw new GitHubCodeSearchAuthenticationError();
    }

    const authenticatedFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("accept", "application/vnd.github+json");
      headers.set("authorization", `Bearer ${token}`);
      headers.set("user-agent", "Aisle catalog sync");
      headers.set("x-github-api-version", GITHUB_REST_API_VERSION);
      return this.fetchImplementation(input, { ...init, headers });
    };
    return new BoundedHttpTransport({
      ...this.transportOptions,
      baseUrl: this.baseUrl,
      fetch: authenticatedFetch,
      maxJsonBytes: this.maxResponseBytes,
    });
  }

  private rethrowAuthentication(error: unknown): never {
    if (error instanceof RegistryHttpError && error.status === 401) {
      throw new GitHubCodeSearchAuthenticationError("GitHub rejected the Code Search access token");
    }
    throw error;
  }
}
