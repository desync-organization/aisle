import { createHash } from "node:crypto";

import { z } from "zod";

import { computeArtifactContentHash, normalizeArtifactFilePath } from "../artifact-fingerprint";
import { cancelBestEffort, readBoundedResponse, requestTimeout } from "../http-safety";
import { createPersistedSkillRaw } from "../provider-raw";
import { normalizeSkillPath, normalizeSourceUrl } from "../normalization";
import type {
  CatalogSourceConnector,
  ConnectorContext,
  ConnectorPage,
  DiscoveredSkillRecord,
} from "../source-contract";
import {
  SkillMdClient,
  type SkillMdListItem,
  type SkillMdSkillMetadata,
} from "./skillmd-client";

const repositorySchema = z.object({
  full_name: z.string().min(3).max(256),
  html_url: z.url(),
  private: z.boolean(),
  visibility: z.string().optional(),
  owner: z.object({ login: z.string().min(1).max(128) }),
  name: z.string().min(1).max(128),
  default_branch: z.string().min(1).max(256),
});

const gitCommitSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40}$/i),
  tree: z.object({ sha: z.string().min(7).max(64) }),
});

const branchHeadSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40}$/i),
});

const treeEntrySchema = z.object({
  path: z.string().min(1).max(4_096),
  mode: z.string().min(1).max(16),
  type: z.enum(["blob", "tree", "commit"]),
  sha: z.string().min(1).max(128),
  size: z.number().int().nonnegative().optional(),
});

const treeSchema = z.object({
  sha: z.string().min(1),
  truncated: z.boolean(),
  tree: z.array(treeEntrySchema).max(100_000),
});

type TreeEntry = z.infer<typeof treeEntrySchema>;

const MAX_REPOSITORY_LICENSE_BYTES = 262_144;

interface SkillMdCatalogClient {
  listSkills(options: { limit: number; offset: number }): ReturnType<SkillMdClient["listSkills"]>;
  detail(slug: string): ReturnType<SkillMdClient["detail"]>;
}

export interface SkillMdAdapterOptions {
  client?: SkillMdCatalogClient;
  fetch?: typeof fetch;
  pageSize?: number;
  maxConcurrentHydrations?: number;
  maxTextFileBytes?: number;
  maxTextTotalBytes?: number;
  githubToken?: string;
}

interface GitHubCoordinates {
  owner: string;
  repository: string;
  sourceUrl: string;
  hintedSkillPath: string | null;
}

interface GitHubSnapshot {
  repository: z.infer<typeof repositorySchema>;
  tree: z.infer<typeof treeSchema>;
  observedBranchHead: {
    branch: string;
    headSha: string;
  };
  repositoryLicenseEvidence: DiscoveredSkillRecord["repositoryLicenseEvidence"];
}

function boundedProviderText(value: string, maximumLength: number): string {
  return value.slice(0, maximumLength);
}

function boundedNullableProviderText(
  value: string | null | undefined,
  maximumLength: number,
): string | null {
  return value === null || value === undefined
    ? null
    : boundedProviderText(value, maximumLength);
}

function persistedSkillMdListing(item: SkillMdListItem): Record<string, unknown> {
  return {
    slug: boundedProviderText(item.slug, 512),
    type: boundedProviderText(item.type, 64),
    title: boundedProviderText(item.title, 256),
    description: boundedProviderText(item.description, 4_096),
    verified: item.verified,
    verifiedScope: item.verified_scope,
    agents: boundedNullableProviderText(item.agents, 1_024),
    category: boundedNullableProviderText(item.category, 128),
    averageRating: item.avg_rating ?? null,
    ratingCount: item.rating_count ?? null,
  };
}

function persistedSkillMdDetail(
  detail: SkillMdSkillMetadata | null,
): Record<string, unknown> | null {
  if (!detail) return null;
  const inventory = detail.inventory.slice(0, 100_000);
  return {
    slug: boundedProviderText(detail.slug, 512),
    type: boundedProviderText(detail.type, 64),
    title: boundedProviderText(detail.title, 256),
    description: boundedProviderText(detail.description, 4_096),
    verified: detail.verified,
    verifiedScope: detail.verified_scope,
    license: boundedNullableProviderText(detail.license, 256),
    sourceRepository: boundedNullableProviderText(detail.source_repo, 2_048),
    commitSha: boundedNullableProviderText(detail.commit_sha, 256),
    lastSyncedAt: boundedNullableProviderText(detail.last_synced_at, 128),
    category: boundedNullableProviderText(detail.category, 128),
    averageRating: detail.avg_rating ?? null,
    ratingCount: detail.rating_count ?? null,
    installCount: detail.install_count ?? null,
    inventory: {
      fileCount: inventory.length,
      truncated: detail.inventory.length > inventory.length,
      totalBytes: inventory.reduce(
        (total, file) =>
          total > Number.MAX_SAFE_INTEGER - file.size_bytes
            ? Number.MAX_SAFE_INTEGER
            : total + file.size_bytes,
        0,
      ),
      scriptCount: inventory.filter((file) => file.is_script === true || file.is_script === 1)
        .length,
    },
  };
}

function boundedUnresolvedReason(reason: string): string {
  return boundedProviderText(reason, 1_024);
}

function skillMdCategoryHints(
  item: SkillMdListItem,
  detail: SkillMdSkillMetadata | null,
): NonNullable<DiscoveredSkillRecord["categoryHints"]> {
  const categories = [detail?.category, item.category].filter(
    (value): value is string => Boolean(value?.trim()),
  );
  return { categories: [...new Set(categories)], tags: [] };
}

function parseGitHubCoordinates(source: string | null): GitHubCoordinates | null {
  if (!source) return null;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null;
  if (url.username || url.password) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const owner = segments[0]!;
  const repository = segments[1]!.replace(/\.git$/i, "");
  const treeIndex = segments.indexOf("tree", 2);
  const hintedSkillPath =
    treeIndex >= 0 && segments.length > treeIndex + 2
      ? normalizeSkillPath(segments.slice(treeIndex + 2).join("/"))
      : null;
  return {
    owner,
    repository,
    sourceUrl: normalizeSourceUrl(`https://github.com/${owner}/${repository}`),
    hintedSkillPath,
  };
}

function isKnownBinary(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|avif|ico|pdf|zip|gz|tgz|7z|rar|woff2?|ttf|otf|mp[34]|wav|mov|avi|exe|dll|dylib|so|bin|class|jar)$/i.test(
    path,
  );
}

function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

function relativeEntries(tree: readonly TreeEntry[], skillPath: string): TreeEntry[] {
  const prefix = skillPath === "." ? "" : `${skillPath}/`;
  return tree
    .filter((entry) => entry.path === skillPath || entry.path.startsWith(prefix))
    .filter((entry) => entry.type !== "tree")
    .map((entry) => ({
      ...entry,
      path: normalizeArtifactFilePath(entry.path.slice(prefix.length)),
    }));
}

function locateSkillPath(
  tree: readonly TreeEntry[],
  hint: string | null,
  slug: string,
): string | null {
  const manifests = tree.filter(
    (entry) => entry.type === "blob" && (entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md")),
  );
  if (hint) {
    const manifest = hint === "." ? "SKILL.md" : `${hint}/SKILL.md`;
    return manifests.some((entry) => entry.path === manifest) ? hint : null;
  }
  const expectedName = slug.split("/").at(-1);
  const candidates = manifests
    .map((entry) => entry.path === "SKILL.md" ? "." : entry.path.slice(0, -"/SKILL.md".length))
    .filter((path) => path === "." || path.split("/").at(-1) === expectedName);
  return candidates.length === 1 ? normalizeSkillPath(candidates[0]!) : null;
}

export class SkillMdAdapter implements CatalogSourceConnector {
  readonly descriptor = {
    id: "skillmd",
    name: "SkillMD",
    baseUrl: "https://api.skillmd.com/v1/skills",
    mode: "federated" as const,
    upstreamIdentifier: "SkillMD public v1 skills API",
    termsUrl: "https://skillmd.com",
    knownExclusions: [
      "Entries without an immutable public GitHub source are indexed as unresolved and cannot be installed.",
      "Exact source artifacts that exceed bounded static-scan limits remain unresolved.",
      "SkillMD offset pages have no snapshot token; sweeps remain non-retiring partial coverage.",
    ],
  };

  private readonly client: SkillMdCatalogClient;
  private readonly fetchImplementation: typeof fetch;
  private readonly pageSize: number;
  private readonly maxConcurrentHydrations: number;
  private readonly maxTextFileBytes: number;
  private readonly maxTextTotalBytes: number;
  private readonly githubToken?: string;
  private readonly snapshotCache = new Map<string, Promise<GitHubSnapshot>>();

  constructor(options: SkillMdAdapterOptions = {}) {
    this.client = options.client ?? new SkillMdClient();
    this.fetchImplementation = options.fetch ?? fetch;
    this.pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 100);
    const requestedConcurrency = options.maxConcurrentHydrations ?? 1;
    this.maxConcurrentHydrations = Number.isSafeInteger(requestedConcurrency)
      ? Math.min(Math.max(requestedConcurrency, 1), 4)
      : 1;
    this.maxTextFileBytes = options.maxTextFileBytes ?? 204_800;
    this.maxTextTotalBytes = options.maxTextTotalBytes ?? 1_048_576;
    this.githubToken = options.githubToken?.trim() || undefined;
  }

  async *enumerate(context: ConnectorContext): AsyncIterable<ConnectorPage> {
    const parsedOffset = context.cursor === null ? 0 : Number(context.cursor);
    if (!Number.isSafeInteger(parsedOffset) || parsedOffset < 0) {
      throw new Error("SkillMD cursor must be a non-negative integer offset");
    }
    let offset = parsedOffset;
    do {
      const page = await this.client.listSkills({ limit: this.pageSize, offset });
      const records: DiscoveredSkillRecord[] = [];
      const exclusions: string[] = [];
      let degraded = true;
      exclusions.push(
        "SkillMD offset pagination has no stable snapshot token; this sweep cannot retire absent records.",
      );
      for (let index = 0; index < page.items.length; index += this.maxConcurrentHydrations) {
        const batch = page.items.slice(index, index + this.maxConcurrentHydrations);
        const hydratedBatch = await Promise.all(
          batch.map(async (item) => {
            const itemExclusions: string[] = [];
            try {
              const detail = await this.client.detail(item.slug);
              return {
                record: await this.hydrate(item, detail, itemExclusions),
                exclusions: itemExclusions,
                failed: false,
              };
            } catch (error) {
              itemExclusions.push(
                `${item.slug}: exact public source hydration failed (${error instanceof Error ? error.message : String(error)}).`,
              );
              return {
                record: this.unresolved(item, null, "exact public source hydration failed"),
                exclusions: itemExclusions,
                failed: true,
              };
            }
          }),
        );
        for (const result of hydratedBatch) {
          degraded ||= result.failed;
          exclusions.push(...result.exclusions);
          records.push(result.record);
        }
      }
      const nextCursor = page.nextOffset === null ? null : String(page.nextOffset);
      yield {
        records,
        nextCursor,
        hasMore: nextCursor !== null,
        reportedTotal: null,
        completeSnapshot: false,
        degraded,
        exclusions,
      };
      if (page.nextOffset === null) break;
      if (page.nextOffset <= offset) throw new Error("SkillMD returned a non-advancing offset");
      offset = page.nextOffset;
    } while (true);
  }

  private async hydrate(
    item: SkillMdListItem,
    detail: SkillMdSkillMetadata,
    exclusions: string[],
  ): Promise<DiscoveredSkillRecord> {
    if (detail.slug !== item.slug) throw new Error("SkillMD detail identity did not match listing");
    const coordinates = parseGitHubCoordinates(detail.source_repo);
    if (!coordinates || !detail.commit_sha || !/^[a-f0-9]{40}$/i.test(detail.commit_sha)) {
      exclusions.push(`${item.slug}: immutable public GitHub source metadata was unavailable.`);
      return this.unresolved(item, detail, "immutable public GitHub source unavailable");
    }
    const snapshot = await this.githubSnapshot(coordinates, detail.commit_sha);
    const skillPath = locateSkillPath(
      snapshot.tree.tree,
      coordinates.hintedSkillPath,
      item.slug,
    );
    if (!skillPath) {
      exclusions.push(`${item.slug}: source tree did not identify one exact SKILL.md directory.`);
      return this.unresolved(item, detail, "exact SKILL.md directory was ambiguous or missing");
    }

    const entries = relativeEntries(snapshot.tree.tree, skillPath);
    const paths = new Set<string>();
    for (const entry of entries) {
      if (paths.has(entry.path)) throw new Error(`duplicate source path ${entry.path}`);
      paths.add(entry.path);
    }
    const textFiles: Array<{ path: string; contents: string; sha256: string }> = [];
    const verifiedFiles = new Map<
      string,
      { path: string; type: string; mode: string; size: number; sha: string }
    >();
    let totalBytes = 0;
    let complete = true;
    for (const entry of entries) {
      if (entry.type !== "blob") {
        complete = false;
        continue;
      }
      if (entry.size === undefined || entry.size > this.maxTextFileBytes) {
        complete = false;
        exclusions.push(`${item.slug}: ${entry.path} exceeded the per-file scan limit.`);
        continue;
      }
      const sourcePath = skillPath === "." ? entry.path : `${skillPath}/${entry.path}`;
      const rawUrl = new URL(
        `/${coordinates.owner}/${coordinates.repository}/${detail.commit_sha}/${sourcePath
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
        "https://raw.githubusercontent.com",
      );
      const response = await this.fetchImplementation(rawUrl, {
        headers: { accept: "text/plain, application/octet-stream;q=0.5" },
        redirect: "manual",
        signal: requestTimeout(),
      });
      if (!response.ok) {
        cancelBestEffort(response.body, "SkillMD source-file response discarded");
        complete = false;
        exclusions.push(`${item.slug}: ${entry.path} returned HTTP ${response.status}.`);
        continue;
      }
      const bytes = await readBoundedResponse(response, this.maxTextFileBytes);
      if (
        bytes.byteLength !== entry.size ||
        !/^[a-f0-9]{40}$/i.test(entry.sha) ||
        gitBlobSha(bytes) !== entry.sha.toLowerCase()
      ) {
        complete = false;
        exclusions.push(`${item.slug}: ${entry.path} did not match the exact Git blob SHA.`);
        continue;
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > this.maxTextTotalBytes) {
        complete = false;
        exclusions.push(`${item.slug}: textual artifact set exceeded the aggregate scan limit.`);
        continue;
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      let type = entry.mode === "120000" ? "symlink" : "file";
      try {
        const contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (type === "file" && !isKnownBinary(entry.path)) {
          textFiles.push({ path: entry.path, contents, sha256 });
        } else if (type === "file") {
          type = "binary";
        }
      } catch {
        type = "binary";
      }
      verifiedFiles.set(entry.path, {
        path: entry.path,
        type,
        mode: entry.mode,
        size: bytes.byteLength,
        sha: sha256,
      });
    }
    const artifactFiles = entries.map((entry) =>
      verifiedFiles.get(entry.path) ?? {
        path: entry.path,
        type: entry.type,
        mode: entry.mode,
        size: entry.size,
      },
    );
    const manifest = textFiles.find((file) => file.path === "SKILL.md");
    if (!manifest) complete = false;
    if (!complete || !manifest) {
      exclusions.push(`${item.slug}: exact textual source inventory was not fully scanned.`);
    }
    const contentHash = manifest && complete
      ? computeArtifactContentHash(artifactFiles)
      : null;
    return {
      sourceRecordId: item.slug,
      provider: "skillmd",
      sourceType: "skillmd",
      sourceUrl: coordinates.sourceUrl,
      skillPath,
      upstreamName: detail.title,
      upstreamDescription: detail.description || item.description || null,
      categoryHints: skillMdCategoryHints(item, detail),
      compatibility: null,
      license: detail.license,
      installUrl: `https://github.com/${coordinates.owner}/${coordinates.repository}/tree/${detail.commit_sha}${skillPath === "." ? "" : `/${skillPath}`}`,
      installSpec: {
        kind: "source",
        sourceUrl: coordinates.sourceUrl,
        immutableRef: detail.commit_sha,
        skillPath,
      },
      immutableRef: detail.commit_sha,
      contentHash,
      upstreamHash: detail.commit_sha,
      public: true,
      internal: false,
      aliases: [item.slug],
      repository: {
        provider: "github",
        url: coordinates.sourceUrl,
        owner: snapshot.repository.owner.login,
        name: snapshot.repository.name,
        visibility: "public",
        defaultBranch: snapshot.repository.default_branch,
        observedBranchHead: snapshot.observedBranchHead,
      },
      repositoryLicenseEvidence: snapshot.repositoryLicenseEvidence,
      artifact: manifest
        ? {
            type: "skill-md",
            contents: manifest.contents,
            complete,
            textFiles,
            files: artifactFiles,
          }
        : null,
      raw: createPersistedSkillRaw({
        kind: "skillmd-skill",
        listing: persistedSkillMdListing(item),
        detail: persistedSkillMdDetail(detail),
        sourceTreeSha: snapshot.tree.sha,
        providerVerifiedScope: detail.verified_scope,
      }),
    };
  }

  private unresolved(
    item: SkillMdListItem,
    detail: SkillMdSkillMetadata | null,
    reason: string,
  ): DiscoveredSkillRecord {
    return {
      sourceRecordId: item.slug,
      provider: "skillmd",
      sourceType: "skillmd",
      sourceUrl: "https://skillmd.com",
      skillPath: item.slug,
      upstreamName: detail?.title ?? item.title,
      upstreamDescription: detail?.description || item.description || null,
      categoryHints: skillMdCategoryHints(item, detail),
      compatibility: null,
      license: detail?.license ?? null,
      installUrl: null,
      installSpec: null,
      immutableRef: detail?.commit_sha ?? null,
      contentHash: null,
      upstreamHash: detail?.commit_sha ?? null,
      public: true,
      internal: false,
      aliases: [item.slug],
      repository: null,
      artifact: null,
      raw: createPersistedSkillRaw({
        kind: "skillmd-skill",
        listing: persistedSkillMdListing(item),
        detail: persistedSkillMdDetail(detail),
        unresolved: boundedUnresolvedReason(reason),
      }),
    };
  }

  private githubSnapshot(
    coordinates: GitHubCoordinates,
    commit: string,
  ): Promise<GitHubSnapshot> {
    const key = `${coordinates.owner}/${coordinates.repository}@${commit}`;
    const cached = this.snapshotCache.get(key);
    if (cached) return cached;
    const promise = this.loadGitHubSnapshot(coordinates, commit).catch((error) => {
      this.snapshotCache.delete(key);
      throw error;
    });
    if (this.snapshotCache.size >= 128) {
      const oldest = this.snapshotCache.keys().next().value;
      if (oldest) this.snapshotCache.delete(oldest);
    }
    this.snapshotCache.set(key, promise);
    return promise;
  }

  private async loadGitHubSnapshot(
    coordinates: GitHubCoordinates,
    commit: string,
  ): Promise<GitHubSnapshot> {
    const repository = repositorySchema.parse(
      await this.githubJson(`/repos/${coordinates.owner}/${coordinates.repository}`),
    );
    if (repository.private || (repository.visibility && repository.visibility !== "public")) {
      throw new Error("SkillMD source repository is not public");
    }
    if (
      repository.full_name.toLowerCase() !==
        `${coordinates.owner}/${coordinates.repository}`.toLowerCase() ||
      normalizeSourceUrl(repository.html_url) !== coordinates.sourceUrl
    ) {
      throw new Error("GitHub repository identity did not match SkillMD provenance");
    }
    const branchHead = branchHeadSchema.parse(
      await this.githubJson(
        `/repos/${coordinates.owner}/${coordinates.repository}/commits/${encodeURIComponent(repository.default_branch)}`,
      ),
    );
    const observedHeadSha = branchHead.sha.toLowerCase();
    if (observedHeadSha !== commit.toLowerCase()) {
      throw new Error("SkillMD nominated commit is not the current public default-branch head");
    }
    const gitCommit = gitCommitSchema.parse(
      await this.githubJson(
        `/repos/${coordinates.owner}/${coordinates.repository}/git/commits/${commit}`,
      ),
    );
    if (gitCommit.sha.toLowerCase() !== commit.toLowerCase()) {
      throw new Error("GitHub commit identity did not match SkillMD provenance");
    }
    const tree = treeSchema.parse(
      await this.githubJson(
        `/repos/${coordinates.owner}/${coordinates.repository}/git/trees/${gitCommit.tree.sha}?recursive=1`,
      ),
    );
    if (tree.truncated) throw new Error("GitHub source tree was truncated");
    const repositoryLicenseEvidence = await this.loadRepositoryLicenseEvidence(
      tree.tree,
      observedHeadSha,
      coordinates.sourceUrl,
      coordinates,
    );
    return {
      repository,
      tree,
      observedBranchHead: {
        branch: repository.default_branch,
        headSha: observedHeadSha,
      },
      repositoryLicenseEvidence,
    };
  }

  private async loadRepositoryLicenseEvidence(
    entries: readonly TreeEntry[],
    immutableRef: string,
    sourceUrl: string,
    coordinates: GitHubCoordinates,
  ): Promise<DiscoveredSkillRecord["repositoryLicenseEvidence"]> {
    const candidates = entries.filter(
      (entry) =>
        !entry.path.includes("/") &&
        /^(?:license|licence|copying)(?:\.[a-z0-9]+)?$/i.test(entry.path),
    );
    if (candidates.length !== 1) return null;
    const [entry] = candidates;
    if (
      !entry ||
      entry.type !== "blob" ||
      entry.mode === "120000" ||
      entry.size === undefined ||
      entry.size > MAX_REPOSITORY_LICENSE_BYTES
    ) {
      return null;
    }
    try {
      const path = entry.path.split("/").map(encodeURIComponent).join("/");
      const response = await this.githubFetch(
        `/repos/${coordinates.owner}/${coordinates.repository}/contents/${path}?ref=${encodeURIComponent(immutableRef)}`,
        "application/vnd.github.raw+json",
      );
      if (!response.ok) {
        cancelBestEffort(response.body, "SkillMD GitHub license response discarded");
        return null;
      }
      const bytes = await readBoundedResponse(response, MAX_REPOSITORY_LICENSE_BYTES);
      if (
        bytes.byteLength !== entry.size ||
        !/^[a-f0-9]{40}$/i.test(entry.sha) ||
        gitBlobSha(bytes) !== entry.sha.toLowerCase()
      ) {
        return null;
      }
      const contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return {
        path: entry.path,
        contents,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sourceUrl,
        immutableRef,
      };
    } catch {
      return null;
    }
  }

  private async githubJson(path: string): Promise<unknown> {
    const response = await this.githubFetch(path, "application/vnd.github+json");
    if (!response.ok) {
      cancelBestEffort(response.body, "SkillMD GitHub metadata response discarded");
      throw new Error(`GitHub public source request returned HTTP ${response.status}`);
    }
    const bytes = await readBoundedResponse(response, 4_194_304);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }

  private async githubFetch(path: string, accept: string): Promise<Response> {
    return this.fetchImplementation(`https://api.github.com${path}`, {
      headers: {
        accept,
        "x-github-api-version": "2022-11-28",
        ...(this.githubToken ? { authorization: `Bearer ${this.githubToken}` } : {}),
      },
      redirect: "manual",
      signal: requestTimeout(),
    });
  }
}
