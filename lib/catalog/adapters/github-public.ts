import { createHash } from "node:crypto";

import { z } from "zod";

import { computeArtifactContentHash } from "../artifact-fingerprint";
import { cancelBestEffort, readBoundedResponse, requestTimeout } from "../http-safety";
import { normalizeSkillPath, normalizeSourceUrl } from "../normalization";
import type {
  CatalogSourceConnector,
  ConnectorContext,
  ConnectorPage,
  DiscoveredSkillRecord,
} from "../source-contract";

const repositorySchema = z.object({
  full_name: z.string().min(3),
  html_url: z.url(),
  private: z.boolean(),
  visibility: z.string().optional(),
  default_branch: z.string().min(1),
  owner: z.object({ login: z.string().min(1) }),
  name: z.string().min(1),
});

const commitSchema = z.object({ sha: z.string().min(7) });

const treeEntrySchema = z.object({
  path: z.string().min(1),
  mode: z.string().min(1),
  type: z.enum(["blob", "tree", "commit"]),
  sha: z.string().min(1),
  size: z.number().int().nonnegative().optional(),
});

const treeSchema = z.object({
  sha: z.string().min(1),
  truncated: z.boolean(),
  tree: z.array(treeEntrySchema),
});

const MAX_REQUESTED_MANIFESTS = 256;
const MAX_TREE_BYTES = 4_194_304;
const MAX_TREE_ENTRIES = 50_000;
const MAX_ARTIFACT_FILES = 512;
const MAX_HYDRATED_MANIFESTS = 256;

export interface GitHubPublicRepositoryAdapterOptions {
  repositoryUrl: string;
  fetch?: typeof fetch;
  token?: string;
  /** Exact, case-sensitive repository paths ending in SKILL.md. */
  manifestFilePaths?: readonly string[];
  maxManifestBytes?: number;
  maxTextTotalBytes?: number;
  maxLicenseBytes?: number;
  maxTreeEntries?: number;
  maxArtifactFiles?: number;
  maxHydratedManifests?: number;
  maxAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RangeError(`${label} must be an integer from 1 through ${maximum}`);
  }
  return resolved;
}

function repositoryCoordinates(repositoryUrl: string): { owner: string; repository: string; url: string } {
  const normalized = normalizeSourceUrl(repositoryUrl);
  const url = new URL(normalized);
  if (url.hostname !== "github.com") {
    throw new Error("The GitHub adapter only accepts github.com repository URLs");
  }
  const [owner, repository] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repository) {
    throw new Error("GitHub repository URL must include owner and repository");
  }
  return { owner, repository, url: normalized };
}

function directoryForManifest(path: string): string {
  const segments = path.split("/");
  segments.pop();
  return normalizeSkillPath(segments.join("/") || ".");
}

function exactManifestFilePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed !== "SKILL.md" && !trimmed.endsWith("/SKILL.md")) {
    throw new Error("Requested GitHub manifest paths must end with an exact SKILL.md segment");
  }
  const skillPath = directoryForManifest(trimmed);
  const normalized = skillPath === "." ? "SKILL.md" : `${skillPath}/SKILL.md`;
  if (normalized !== trimmed) {
    throw new Error("Requested GitHub manifest paths must already be normalized repository paths");
  }
  return normalized;
}

function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

function isKnownBinary(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|avif|ico|pdf|zip|gz|tgz|7z|rar|woff2?|ttf|otf|mp[34]|wav|mov|avi|exe|dll|dylib|so|bin|class|jar)$/i.test(
    path,
  );
}

export class GitHubPublicRepositoryAdapter implements CatalogSourceConnector {
  readonly descriptor;
  private readonly coordinates;
  private readonly fetchImplementation: typeof fetch;
  private readonly token?: string;
  private readonly manifestFilePaths: ReadonlySet<string> | null;
  private readonly maxManifestBytes: number;
  private readonly maxTextTotalBytes: number;
  private readonly maxLicenseBytes: number;
  private readonly maxTreeEntries: number;
  private readonly maxArtifactFiles: number;
  private readonly maxHydratedManifests: number;
  private readonly maxAttempts: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: GitHubPublicRepositoryAdapterOptions) {
    this.coordinates = repositoryCoordinates(options.repositoryUrl);
    this.fetchImplementation = options.fetch ?? fetch;
    this.token = options.token;
    const requestedManifests = options.manifestFilePaths?.map(exactManifestFilePath);
    if (requestedManifests && requestedManifests.length === 0) {
      throw new RangeError("At least one GitHub manifest path must be requested");
    }
    if (requestedManifests && requestedManifests.length > MAX_REQUESTED_MANIFESTS) {
      throw new RangeError(
        `At most ${MAX_REQUESTED_MANIFESTS} exact GitHub manifest paths may be requested`,
      );
    }
    if (requestedManifests && new Set(requestedManifests).size !== requestedManifests.length) {
      throw new Error("Requested GitHub manifest paths must be unique");
    }
    this.manifestFilePaths = requestedManifests ? new Set(requestedManifests) : null;
    this.maxManifestBytes = options.maxManifestBytes ?? 1_048_576;
    this.maxTextTotalBytes = options.maxTextTotalBytes ?? 2_097_152;
    this.maxLicenseBytes = options.maxLicenseBytes ?? 262_144;
    this.maxTreeEntries = boundedPositiveInteger(
      options.maxTreeEntries,
      MAX_TREE_ENTRIES,
      MAX_TREE_ENTRIES,
      "GitHub tree entry limit",
    );
    this.maxArtifactFiles = boundedPositiveInteger(
      options.maxArtifactFiles,
      MAX_ARTIFACT_FILES,
      MAX_ARTIFACT_FILES,
      "GitHub artifact file limit",
    );
    this.maxHydratedManifests = boundedPositiveInteger(
      options.maxHydratedManifests,
      MAX_HYDRATED_MANIFESTS,
      MAX_HYDRATED_MANIFESTS,
      "GitHub hydrated manifest limit",
    );
    this.maxAttempts = Math.max(options.maxAttempts ?? 3, 1);
    this.sleep =
      options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.descriptor = {
      id: `github:${this.coordinates.owner}/${this.coordinates.repository}`,
      name: `${this.coordinates.owner}/${this.coordinates.repository}`,
      baseUrl: this.coordinates.url,
      mode: "on-demand" as const,
      upstreamIdentifier: `GitHub public repository ${this.coordinates.owner}/${this.coordinates.repository}`,
      termsUrl: "https://docs.github.com/en/site-policy/github-terms/github-terms-of-service",
    };
  }

  async *enumerate(context: ConnectorContext): AsyncIterable<ConnectorPage> {
    void context;
    const repository = repositorySchema.parse(
      await this.githubJson(`/repos/${this.coordinates.owner}/${this.coordinates.repository}`),
    );
    if (repository.private || (repository.visibility && repository.visibility !== "public")) {
      throw new Error("Private or internal GitHub repositories are not eligible for public import");
    }

    const commit = commitSchema.parse(
      await this.githubJson(
        `/repos/${this.coordinates.owner}/${this.coordinates.repository}/commits/${encodeURIComponent(repository.default_branch)}`,
      ),
    );
    const tree = treeSchema.parse(
      await this.githubJson(
        `/repos/${this.coordinates.owner}/${this.coordinates.repository}/git/trees/${encodeURIComponent(commit.sha)}?recursive=1`,
      ),
    );
    if (tree.truncated) {
      throw new Error("GitHub recursive tree was truncated; refusing to claim a complete repository import");
    }
    if (tree.tree.length > this.maxTreeEntries) {
      throw new Error(
        `GitHub tree contained ${tree.tree.length} entries, above the ${this.maxTreeEntries}-entry hydration limit`,
      );
    }

    const exclusions: string[] = [];
    const allManifestEntries = tree.tree.filter(
      (entry) =>
        entry.type === "blob" &&
        entry.mode !== "120000" &&
        (entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md")),
    );
    const manifestEntries = this.manifestFilePaths
      ? allManifestEntries.filter((entry) => this.manifestFilePaths!.has(entry.path))
      : allManifestEntries;
    if (manifestEntries.length > this.maxHydratedManifests) {
      throw new Error(
        `GitHub hydration selected ${manifestEntries.length} manifests, above the ${this.maxHydratedManifests}-manifest limit`,
      );
    }
    const missingRequestedManifests = this.manifestFilePaths
      ? [...this.manifestFilePaths].filter(
          (path) => !manifestEntries.some((entry) => entry.path === path),
        )
      : [];
    if (missingRequestedManifests.length) {
      const sample = missingRequestedManifests.slice(0, 5).join(", ").slice(0, 1_024);
      exclusions.push(
        `${missingRequestedManifests.length} requested SKILL.md path(s) were absent at the resolved commit${sample ? ` (${sample})` : ""}.`,
      );
    }
    const repositoryLicenseEvidence = manifestEntries.length
      ? await this.loadRepositoryLicenseEvidence(
          tree.tree,
          commit.sha,
          repository.html_url,
          exclusions,
        )
      : null;
    const records: DiscoveredSkillRecord[] = [];
    let degraded = missingRequestedManifests.length > 0;

    for (const manifest of manifestEntries) {
      const skillPath = directoryForManifest(manifest.path);
      const unresolvedRecord = (reason: string): DiscoveredSkillRecord => ({
        sourceRecordId: `${repository.full_name}:${skillPath}`,
        provider: "github",
        sourceType: "github",
        sourceUrl: repository.html_url,
        skillPath,
        upstreamName: null,
        upstreamDescription: null,
        compatibility: null,
        license: null,
        installUrl: `https://github.com/${repository.full_name}/tree/${commit.sha}${skillPath === "." ? "" : `/${skillPath}`}`,
        installSpec: {
          kind: "source",
          sourceUrl: repository.html_url,
          immutableRef: commit.sha,
          skillPath,
        },
        immutableRef: commit.sha,
        contentHash: null,
        upstreamHash: commit.sha,
        public: true,
        internal: false,
        aliases: [],
        repository: {
          provider: "github",
          url: repository.html_url,
          owner: repository.owner.login,
          name: repository.name,
          visibility: "public",
          defaultBranch: repository.default_branch,
        },
        artifact: null,
        raw: { repository: repository.full_name, manifestPath: manifest.path, commit: commit.sha, reason },
      });
      const manifestUrl = `/repos/${this.coordinates.owner}/${this.coordinates.repository}/contents/${manifest.path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}?ref=${encodeURIComponent(commit.sha)}`;
      const response = await this.githubFetch(manifestUrl, "application/vnd.github.raw+json");
      if (!response.ok) {
        cancelBestEffort(response.body, "GitHub manifest response discarded");
        degraded = true;
        exclusions.push(`${manifest.path}: manifest returned HTTP ${response.status}.`);
        records.push(unresolvedRecord(`manifest HTTP ${response.status}`));
        continue;
      }
      let contents: string;
      let manifestBytes: Uint8Array;
      try {
        manifestBytes = await readBoundedResponse(response, this.maxManifestBytes);
        contents = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
      } catch {
        degraded = true;
        exclusions.push(`${manifest.path}: manifest exceeds the size limit.`);
        records.push(unresolvedRecord("manifest exceeded bounded UTF-8 read limits"));
        continue;
      }
      const prefix = skillPath === "." ? "" : `${skillPath}/`;
      const skillEntries = tree.tree.filter(
        (entry) => entry.path === skillPath || entry.path.startsWith(prefix),
      );
      const textFiles: Array<{ path: string; contents: string; sha256: string }> = [];
      const verifiedFiles = new Map<
        string,
        { path: string; type: string; mode: string; size: number; sha: string }
      >();
      let totalBytes = 0;
      let artifactComplete = true;
      const fileEntries = skillEntries.filter((entry) => entry.type !== "tree");
      if (fileEntries.length > this.maxArtifactFiles) {
        degraded = true;
        exclusions.push(
          `${manifest.path}: skill artifact contains ${fileEntries.length} files, above the ${this.maxArtifactFiles}-file limit.`,
        );
        records.push(unresolvedRecord("artifact exceeded the bounded file inventory limit"));
        continue;
      }
      for (const entry of fileEntries) {
        const relativePath = entry.path.slice(prefix.length);
        if (entry.type !== "blob" || entry.mode === "120000") {
          artifactComplete = false;
          degraded = true;
          continue;
        }
        if (
          entry.size === undefined ||
          entry.size > this.maxManifestBytes ||
          totalBytes + entry.size > this.maxTextTotalBytes
        ) {
          artifactComplete = false;
          degraded = true;
          continue;
        }
        let bytes: Uint8Array;
        if (entry.path === manifest.path) {
          bytes = manifestBytes;
        } else {
          const supportUrl = `/repos/${this.coordinates.owner}/${this.coordinates.repository}/contents/${entry.path
            .split("/")
            .map(encodeURIComponent)
            .join("/")}?ref=${encodeURIComponent(commit.sha)}`;
          const supportResponse = await this.githubFetch(
            supportUrl,
            "application/vnd.github.raw+json",
          );
          if (!supportResponse.ok) {
            cancelBestEffort(supportResponse.body, "GitHub support-file response discarded");
            artifactComplete = false;
            degraded = true;
            continue;
          }
          bytes = await readBoundedResponse(supportResponse, this.maxManifestBytes);
        }
        totalBytes += bytes.byteLength;
        if (
          bytes.byteLength !== entry.size ||
          !/^[a-f0-9]{40}$/i.test(entry.sha) ||
          gitBlobSha(bytes) !== entry.sha.toLowerCase()
        ) {
          artifactComplete = false;
          degraded = true;
          continue;
        }
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        let type = "file";
        try {
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (isKnownBinary(relativePath)) {
            type = "binary";
          } else {
            textFiles.push({ path: relativePath, contents: decoded, sha256 });
          }
        } catch {
          type = "binary";
        }
        verifiedFiles.set(relativePath, {
          path: relativePath,
          type,
          mode: entry.mode,
          size: bytes.byteLength,
          sha: sha256,
        });
      }
      const artifactFiles = fileEntries.map((entry) => {
        const relativePath = entry.path.slice(prefix.length);
        return verifiedFiles.get(relativePath) ?? {
          path: relativePath,
          type: entry.type,
          mode: entry.mode,
          size: entry.size,
        };
      });
      const manifestText = textFiles.find((file) => file.path === "SKILL.md");
      if (!manifestText || manifestText.contents !== contents) artifactComplete = false;

      records.push({
        sourceRecordId: `${repository.full_name}:${skillPath}`,
        provider: "github",
        sourceType: "github",
        sourceUrl: repository.html_url,
        skillPath,
        upstreamName: null,
        upstreamDescription: null,
        compatibility: null,
        license: null,
        installUrl: `https://github.com/${repository.full_name}/tree/${commit.sha}${skillPath === "." ? "" : `/${skillPath}`}`,
        installSpec: {
          kind: "source",
          sourceUrl: repository.html_url,
          immutableRef: commit.sha,
          skillPath,
        },
        immutableRef: commit.sha,
        contentHash: artifactComplete ? computeArtifactContentHash(artifactFiles) : null,
        upstreamHash: commit.sha,
        public: true,
        internal: false,
        aliases: [],
        repository: {
          provider: "github",
          url: repository.html_url,
          owner: repository.owner.login,
          name: repository.name,
          visibility: "public",
          defaultBranch: repository.default_branch,
        },
        repositoryLicenseEvidence,
        artifact: {
          type: "skill-md",
          contents,
          complete: artifactComplete,
          textFiles,
          files: artifactFiles,
        },
        raw: {
          repository: repository.full_name,
          manifestPath: manifest.path,
          commit: commit.sha,
          tree: tree.sha,
        },
      });
    }

    yield {
      records,
      nextCursor: null,
      hasMore: false,
      reportedTotal: manifestEntries.length,
      completeSnapshot: !degraded,
      degraded,
      exclusions,
    };
  }

  private async loadRepositoryLicenseEvidence(
    entries: z.infer<typeof treeEntrySchema>[],
    immutableRef: string,
    sourceUrl: string,
    exclusions: string[],
  ): Promise<DiscoveredSkillRecord["repositoryLicenseEvidence"]> {
    const candidates = entries.filter(
      (entry) =>
        !entry.path.includes("/") &&
        /^(?:license|licence|copying)(?:\.[a-z0-9]+)?$/i.test(entry.path),
    );
    if (candidates.length === 0) return null;
    if (candidates.length !== 1) {
      exclusions.push("Repository-root license evidence was ambiguous; no license was inferred.");
      return null;
    }
    const [entry] = candidates;
    if (
      !entry ||
      entry.type !== "blob" ||
      entry.mode === "120000" ||
      entry.size === undefined ||
      entry.size > this.maxLicenseBytes
    ) {
      exclusions.push("Repository-root license evidence was not a bounded regular file.");
      return null;
    }
    try {
      const path = entry.path.split("/").map(encodeURIComponent).join("/");
      const response = await this.githubFetch(
        `/repos/${this.coordinates.owner}/${this.coordinates.repository}/contents/${path}?ref=${encodeURIComponent(immutableRef)}`,
        "application/vnd.github.raw+json",
      );
      if (!response.ok) {
        cancelBestEffort(response.body, "GitHub license response discarded");
        exclusions.push(`Repository-root ${entry.path} returned HTTP ${response.status}.`);
        return null;
      }
      const bytes = await readBoundedResponse(response, this.maxLicenseBytes);
      if (
        bytes.byteLength !== entry.size ||
        !/^[a-f0-9]{40}$/i.test(entry.sha) ||
        gitBlobSha(bytes) !== entry.sha.toLowerCase()
      ) {
        exclusions.push(`Repository-root ${entry.path} did not match its exact Git blob.`);
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
    } catch (error) {
      exclusions.push(
        `Repository-root ${entry.path} license evidence was unavailable (${error instanceof Error ? error.message : String(error)}).`,
      );
      return null;
    }
  }

  private async githubJson(path: string): Promise<unknown> {
    const response = await this.githubFetch(path, "application/vnd.github+json");
    if (!response.ok) {
      cancelBestEffort(response.body, "GitHub JSON response discarded");
      throw new Error(`GitHub API returned HTTP ${response.status}`);
    }
    const bytes = await readBoundedResponse(response, MAX_TREE_BYTES);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }

  private async githubFetch(path: string, accept: string): Promise<Response> {
    const headers = new Headers({
      accept,
      "x-github-api-version": "2026-03-10",
    });
    if (this.token) {
      headers.set("authorization", `Bearer ${this.token}`);
    }
    let response: Response | null = null;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      response = await this.fetchImplementation(`https://api.github.com${path}`, {
        headers,
        redirect: "manual",
        signal: requestTimeout(),
      });
      if (response.status >= 300 && response.status < 400) {
        cancelBestEffort(response.body, "GitHub redirect discarded");
        throw new Error("GitHub API redirects are not followed");
      }
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
      const retryable = rateLimited || [502, 503, 504].includes(response.status);
      if (!retryable || attempt + 1 >= this.maxAttempts) {
        return response;
      }

      const retryAfterHeader = response.headers.get("retry-after");
      const resetHeader = response.headers.get("x-ratelimit-reset");
      const retryAfterSeconds = retryAfterHeader === null ? null : Number(retryAfterHeader);
      const resetSeconds = resetHeader === null ? null : Number(resetHeader);
      const requestedDelay = retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds * 1_000
        : resetSeconds !== null && Number.isFinite(resetSeconds)
          ? resetSeconds * 1_000 - Date.now()
          : 500 * 2 ** attempt;
      cancelBestEffort(response.body, "retryable GitHub response discarded");
      await this.sleep(Math.min(Math.max(Math.ceil(requestedDelay), 0), 30_000));
    }
    return response!;
  }
}
