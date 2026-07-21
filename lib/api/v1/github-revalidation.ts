import { z } from "zod";

import { cancelBestEffort, readBoundedResponse, requestTimeout } from "@/lib/catalog/http-safety";
import {
  MAX_SKILLS_PER_PLAN,
  githubBranchSchema,
  githubDiscoveryPathSchema,
} from "@/lib/install-plan/contracts";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 25_000;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAXIMUM_TREE_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_MAXIMUM_TREE_ENTRIES = 50_000;
const DEFAULT_SCOPE_CACHE_TTL_MS = 20_000;
const DEFAULT_MAXIMUM_SCOPE_CACHE_ENTRIES = 256;
const MAXIMUM_REPOSITORY_BYTES = 128 * 1_024;
const MAXIMUM_COMMIT_BYTES = 64 * 1_024;

const githubOwnerSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/);
const githubRepositorySchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^(?!\.{1,2}$)[A-Za-z0-9._-]+$/);
const commitResponseSchema = z.object({
  sha: z.string().regex(/^[a-fA-F0-9]{40}$/),
});
const repositoryResponseSchema = z.object({
  full_name: z.string().min(3).max(141),
  private: z.boolean(),
  visibility: z.enum(["public", "private", "internal"]),
  default_branch: githubBranchSchema,
});
const treeEntrySchema = z.object({
  path: z.string().min(1).max(1_024),
  mode: z.string().min(1).max(16),
  type: z.enum(["blob", "tree", "commit"]),
});
const treeResponseSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(treeEntrySchema),
});

export type StackGithubVerificationCandidate = Readonly<{
  selectionId: string;
  owner: string;
  repository: string;
  branch: string;
  persistedHeadSha: string;
  skillPath: string;
}>;

export type StackGithubVerificationResult =
  | Readonly<{ state: "verified"; headSha: string; candidateKey: string }>
  | Readonly<{ state: "unavailable" }>
  | Readonly<{ state: "changed" }>
  | Readonly<{ state: "ambiguous" }>;

export type StackGithubRevalidationOptions = Readonly<{
  fetch?: typeof globalThis.fetch;
  token?: string | null;
  timeoutMs?: number;
  overallTimeoutMs?: number;
  concurrency?: number;
  maximumTreeBytes?: number;
  maximumTreeEntries?: number;
  scopeCache?: boolean;
  scopeCacheTtlMs?: number;
  maximumScopeCacheEntries?: number;
  signal?: AbortSignal;
}>;

type VerifiedCandidate = StackGithubVerificationCandidate;
type CachedScopeVerification = Readonly<{
  state: "verified" | "ambiguous";
  expiresAt: number;
}>;

const scopeVerificationCache = new Map<string, CachedScopeVerification>();

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value!), 1), maximum);
}

function validateCandidate(candidate: StackGithubVerificationCandidate): VerifiedCandidate | null {
  if (
    !/^skill_[a-f0-9]{24}$/.test(candidate.selectionId) ||
    !githubOwnerSchema.safeParse(candidate.owner).success ||
    !githubRepositorySchema.safeParse(candidate.repository).success ||
    !githubBranchSchema.safeParse(candidate.branch).success ||
    !githubDiscoveryPathSchema.safeParse(candidate.skillPath).success ||
    !/^[a-f0-9]{40}$/.test(candidate.persistedHeadSha)
  ) {
    return null;
  }
  return candidate;
}

function groupKey(candidate: VerifiedCandidate): string {
  return JSON.stringify([
    candidate.owner.toLowerCase(),
    candidate.repository.toLowerCase(),
    candidate.branch,
  ]);
}

function scopeCacheKey(candidate: VerifiedCandidate, liveHeadSha: string): string {
  return JSON.stringify([
    candidate.owner.toLowerCase(),
    candidate.repository.toLowerCase(),
    candidate.branch,
    liveHeadSha,
    candidate.skillPath,
  ]);
}

function readCachedScopeVerification(
  key: string,
  now: number,
): CachedScopeVerification | null {
  const cached = scopeVerificationCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= now) {
    scopeVerificationCache.delete(key);
    return null;
  }
  scopeVerificationCache.delete(key);
  scopeVerificationCache.set(key, cached);
  return cached;
}

function writeCachedScopeVerification(
  key: string,
  state: CachedScopeVerification["state"],
  options: Readonly<{ now: number; ttlMs: number; maximumEntries: number }>,
): void {
  for (const [candidateKey, cached] of scopeVerificationCache) {
    if (cached.expiresAt <= options.now) scopeVerificationCache.delete(candidateKey);
  }
  scopeVerificationCache.delete(key);
  while (scopeVerificationCache.size >= options.maximumEntries) {
    const oldestKey = scopeVerificationCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    scopeVerificationCache.delete(oldestKey);
  }
  scopeVerificationCache.set(key, {
    state,
    expiresAt: options.now + options.ttlMs,
  });
}

export function stackGithubCandidateKey(candidate: StackGithubVerificationCandidate): string {
  return JSON.stringify([
    candidate.selectionId,
    candidate.owner.toLowerCase(),
    candidate.repository.toLowerCase(),
    candidate.branch,
    candidate.skillPath,
    candidate.persistedHeadSha,
  ]);
}

function githubHeaders(token: string | null): Headers {
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "User-Agent": "aisle-stack-revalidator/1",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

function combinedRequestSignal(
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): AbortSignal {
  const timeoutSignal = requestTimeout(timeoutMs);
  return callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
}

async function fetchBoundedJson(
  fetchImplementation: typeof globalThis.fetch,
  url: string,
  options: Readonly<{
    maximumBytes: number;
    timeoutMs: number;
    token: string | null;
    signal?: AbortSignal;
  }>,
): Promise<unknown> {
  const response = await fetchImplementation(url, {
    headers: githubHeaders(options.token),
    redirect: "error",
    signal: combinedRequestSignal(options.timeoutMs, options.signal),
  });
  if (!response.ok) {
    cancelBestEffort(response.body, `GitHub verification returned HTTP ${response.status}`);
    throw new Error(`GitHub verification returned HTTP ${response.status}`);
  }
  const bytes = await readBoundedResponse(response, options.maximumBytes);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

function expectedManifestPath(skillPath: string): string {
  return skillPath === "." ? "SKILL.md" : `${skillPath}/SKILL.md`;
}

function manifestPathsInScope(
  entries: ReadonlyArray<z.infer<typeof treeEntrySchema>>,
  skillPath: string,
): string[] {
  const prefix = skillPath === "." ? "" : `${skillPath}/`;
  return entries
    .filter((entry) => {
      if (entry.type !== "blob" || entry.mode === "120000") return false;
      if (prefix && !entry.path.startsWith(prefix)) return false;
      const relativePath = prefix ? entry.path.slice(prefix.length) : entry.path;
      return relativePath === "SKILL.md" || relativePath.endsWith("/SKILL.md");
    })
    .map((entry) => entry.path);
}

async function verifyGroup(
  candidates: readonly VerifiedCandidate[],
  options: Required<
    Pick<
      StackGithubRevalidationOptions,
      | "fetch"
      | "timeoutMs"
      | "maximumTreeBytes"
      | "maximumTreeEntries"
      | "scopeCache"
      | "scopeCacheTtlMs"
      | "maximumScopeCacheEntries"
    >
  > & Readonly<{ token: string | null; deadlineMs: number; signal?: AbortSignal }>,
): Promise<Map<string, StackGithubVerificationResult>> {
  const results = new Map<string, StackGithubVerificationResult>();
  const first = candidates[0]!;
  const owner = encodeURIComponent(first.owner);
  const repository = encodeURIComponent(first.repository);
  const branch = encodeURIComponent(first.branch);

  const remainingTimeout = (): number => {
    const remaining = options.deadlineMs - Date.now();
    if (remaining <= 0) throw new Error("GitHub verification deadline elapsed");
    return Math.min(options.timeoutMs, remaining);
  };

  try {
    const repositoryMetadata = repositoryResponseSchema.parse(
      await fetchBoundedJson(
        options.fetch,
        `https://api.github.com/repos/${owner}/${repository}`,
        {
          maximumBytes: MAXIMUM_REPOSITORY_BYTES,
          timeoutMs: remainingTimeout(),
          token: options.token,
          signal: options.signal,
        },
      ),
    );
    const expectedFullName = `${first.owner}/${first.repository}`.toLowerCase();
    if (
      repositoryMetadata.private ||
      repositoryMetadata.visibility !== "public" ||
      repositoryMetadata.full_name.toLowerCase() !== expectedFullName
    ) {
      for (const candidate of candidates) {
        results.set(candidate.selectionId, { state: "unavailable" });
      }
      return results;
    }
    if (repositoryMetadata.default_branch !== first.branch) {
      for (const candidate of candidates) results.set(candidate.selectionId, { state: "changed" });
      return results;
    }

    const commit = commitResponseSchema.parse(
      await fetchBoundedJson(
        options.fetch,
        `https://api.github.com/repos/${owner}/${repository}/commits/${branch}`,
        {
          maximumBytes: MAXIMUM_COMMIT_BYTES,
          timeoutMs: remainingTimeout(),
          token: options.token,
          signal: options.signal,
        },
      ),
    );
    const liveHeadSha = commit.sha.toLowerCase();
    if (candidates.some((candidate) => candidate.persistedHeadSha !== liveHeadSha)) {
      for (const candidate of candidates) results.set(candidate.selectionId, { state: "changed" });
      return results;
    }

    if (options.scopeCache) {
      const now = Date.now();
      const cached = candidates.map((candidate) => ({
        candidate,
        result: readCachedScopeVerification(
          scopeCacheKey(candidate, liveHeadSha),
          now,
        ),
      }));
      if (cached.every((entry) => entry.result !== null)) {
        for (const entry of cached) {
          results.set(
            entry.candidate.selectionId,
            entry.result!.state === "verified"
              ? {
                  state: "verified",
                  headSha: liveHeadSha,
                  candidateKey: stackGithubCandidateKey(entry.candidate),
                }
              : { state: "ambiguous" },
          );
        }
        return results;
      }
    }

    const tree = treeResponseSchema.parse(
      await fetchBoundedJson(
        options.fetch,
        `https://api.github.com/repos/${owner}/${repository}/git/trees/${liveHeadSha}?recursive=1`,
        {
          maximumBytes: options.maximumTreeBytes,
          timeoutMs: remainingTimeout(),
          token: options.token,
          signal: options.signal,
        },
      ),
    );
    if (tree.truncated || tree.tree.length > options.maximumTreeEntries) {
      const now = Date.now();
      for (const candidate of candidates) {
        results.set(candidate.selectionId, { state: "ambiguous" });
        if (options.scopeCache) {
          writeCachedScopeVerification(
            scopeCacheKey(candidate, liveHeadSha),
            "ambiguous",
            {
              now,
              ttlMs: options.scopeCacheTtlMs,
              maximumEntries: options.maximumScopeCacheEntries,
            },
          );
        }
      }
      return results;
    }

    const now = Date.now();
    for (const candidate of candidates) {
      const manifests = manifestPathsInScope(tree.tree, candidate.skillPath);
      const expected = expectedManifestPath(candidate.skillPath);
      const state = manifests.length === 1 && manifests[0] === expected
        ? "verified"
        : "ambiguous";
      results.set(candidate.selectionId, state === "verified"
        ? {
            state: "verified",
            headSha: liveHeadSha,
            candidateKey: stackGithubCandidateKey(candidate),
          }
        : { state: "ambiguous" });
      if (options.scopeCache) {
        writeCachedScopeVerification(
          scopeCacheKey(candidate, liveHeadSha),
          state,
          {
            now,
            ttlMs: options.scopeCacheTtlMs,
            maximumEntries: options.maximumScopeCacheEntries,
          },
        );
      }
    }
    return results;
  } catch {
    for (const candidate of candidates) results.set(candidate.selectionId, { state: "unavailable" });
    return results;
  }
}

/**
 * Revalidates persisted GitHub candidates against current public-repository
 * metadata, the expected default branch head, and one complete bounded tree.
 * Only manifest-scope verdicts tied to an immutable commit are briefly cached.
 * This avoids the largest repeated recursive-tree call, but deliberately leaves
 * the repository-metadata and live-head quota calls uncached on every request.
 */
export async function revalidateGithubStackCandidates(
  candidates: readonly StackGithubVerificationCandidate[],
  input: StackGithubRevalidationOptions = {},
): Promise<ReadonlyMap<string, StackGithubVerificationResult>> {
  const results = new Map<string, StackGithubVerificationResult>();
  const maximumCandidates = Math.min(candidates.length, MAX_SKILLS_PER_PLAN);
  const valid: VerifiedCandidate[] = [];
  const seenIds = new Set<string>();
  for (const candidate of candidates.slice(0, maximumCandidates)) {
    const parsed = validateCandidate(candidate);
    if (!parsed || seenIds.has(candidate.selectionId)) {
      results.set(candidate.selectionId, { state: "unavailable" });
      continue;
    }
    seenIds.add(candidate.selectionId);
    valid.push(parsed);
  }
  for (const candidate of candidates.slice(maximumCandidates)) {
    results.set(candidate.selectionId, { state: "unavailable" });
  }

  const groups = new Map<string, VerifiedCandidate[]>();
  for (const candidate of valid) {
    const key = groupKey(candidate);
    const members = groups.get(key) ?? [];
    members.push(candidate);
    groups.set(key, members);
  }

  const options = {
    fetch: input.fetch ?? globalThis.fetch,
    token: input.token === undefined
      ? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null
      : input.token,
    timeoutMs: boundedInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, 30_000),
    overallTimeoutMs: boundedInteger(
      input.overallTimeoutMs,
      DEFAULT_OVERALL_TIMEOUT_MS,
      60_000,
    ),
    concurrency: boundedInteger(input.concurrency, DEFAULT_CONCURRENCY, 8),
    maximumTreeBytes: boundedInteger(
      input.maximumTreeBytes,
      DEFAULT_MAXIMUM_TREE_BYTES,
      DEFAULT_MAXIMUM_TREE_BYTES,
    ),
    maximumTreeEntries: boundedInteger(
      input.maximumTreeEntries,
      DEFAULT_MAXIMUM_TREE_ENTRIES,
      DEFAULT_MAXIMUM_TREE_ENTRIES,
    ),
    scopeCache: input.scopeCache ?? (input.fetch === undefined),
    scopeCacheTtlMs: boundedInteger(
      input.scopeCacheTtlMs,
      DEFAULT_SCOPE_CACHE_TTL_MS,
      60_000,
    ),
    maximumScopeCacheEntries: boundedInteger(
      input.maximumScopeCacheEntries,
      DEFAULT_MAXIMUM_SCOPE_CACHE_ENTRIES,
      1_024,
    ),
    signal: input.signal,
  } as const;

  const groupedCandidates = [...groups.values()];
  const deadlineMs = Date.now() + options.overallTimeoutMs;
  let nextGroup = 0;
  const worker = async (): Promise<void> => {
    while (nextGroup < groupedCandidates.length) {
      if (options.signal?.aborted) return;
      const index = nextGroup;
      nextGroup += 1;
      const members = groupedCandidates[index]!;
      if (Date.now() >= deadlineMs) return;
      const groupResults = await verifyGroup(members, { ...options, deadlineMs });
      for (const [selectionId, result] of groupResults) results.set(selectionId, result);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency, groupedCandidates.length) },
      () => worker(),
    ),
  );
  for (const candidate of valid) {
    if (!results.has(candidate.selectionId)) {
      results.set(candidate.selectionId, { state: "unavailable" });
    }
  }
  return results;
}
