import { createHash } from "node:crypto";

import { z } from "zod";

import { readBoundedResponse, requestTimeout } from "../http-safety";
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

export interface GitHubPublicRepositoryAdapterOptions {
  repositoryUrl: string;
  fetch?: typeof fetch;
  token?: string;
  maxManifestBytes?: number;
  maxTextTotalBytes?: number;
  maxAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
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

function treeContentHash(
  entries: z.infer<typeof treeEntrySchema>[],
  skillPath: string,
): string {
  const prefix = skillPath === "." ? "" : `${skillPath}/`;
  const inventory = entries
    .filter((entry) => entry.path === skillPath || entry.path.startsWith(prefix))
    .map((entry) => `${entry.path.slice(prefix.length)}\0${entry.type}\0${entry.mode}\0${entry.sha}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(inventory).digest("hex");
}

export class GitHubPublicRepositoryAdapter implements CatalogSourceConnector {
  readonly descriptor;
  private readonly coordinates;
  private readonly fetchImplementation: typeof fetch;
  private readonly token?: string;
  private readonly maxManifestBytes: number;
  private readonly maxTextTotalBytes: number;
  private readonly maxAttempts: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: GitHubPublicRepositoryAdapterOptions) {
    this.coordinates = repositoryCoordinates(options.repositoryUrl);
    this.fetchImplementation = options.fetch ?? fetch;
    this.token = options.token;
    this.maxManifestBytes = options.maxManifestBytes ?? 1_048_576;
    this.maxTextTotalBytes = options.maxTextTotalBytes ?? 2_097_152;
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

    const manifestEntries = tree.tree.filter(
      (entry) =>
        entry.type === "blob" &&
        entry.mode !== "120000" &&
        (entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md")),
    );
    const records: DiscoveredSkillRecord[] = [];
    const exclusions: string[] = [];
    let degraded = false;

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
        contentHash: treeContentHash(tree.tree, skillPath),
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
        await response.body?.cancel();
        degraded = true;
        exclusions.push(`${manifest.path}: manifest returned HTTP ${response.status}.`);
        records.push(unresolvedRecord(`manifest HTTP ${response.status}`));
        continue;
      }
      let contents: string;
      try {
        const bytes = await readBoundedResponse(response, this.maxManifestBytes);
        contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
      let totalBytes = new TextEncoder().encode(contents).byteLength;
      let artifactComplete = true;
      textFiles.push({
        path: manifest.path,
        contents,
        sha256: createHash("sha256").update(contents).digest("hex"),
      });
      for (const entry of skillEntries) {
        if (entry.path === manifest.path || entry.type !== "blob" || entry.mode === "120000") {
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
        const supportUrl = `/repos/${this.coordinates.owner}/${this.coordinates.repository}/contents/${entry.path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}?ref=${encodeURIComponent(commit.sha)}`;
        const supportResponse = await this.githubFetch(
          supportUrl,
          "application/vnd.github.raw+json",
        );
        if (!supportResponse.ok) {
          await supportResponse.body?.cancel();
          artifactComplete = false;
          degraded = true;
          continue;
        }
        const bytes = await readBoundedResponse(supportResponse, this.maxManifestBytes);
        totalBytes += bytes.byteLength;
        try {
          textFiles.push({
            path: entry.path,
            contents: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            sha256: createHash("sha256").update(bytes).digest("hex"),
          });
        } catch {
          // Binary assets remain represented by immutable inventory metadata.
        }
      }

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
        contentHash: treeContentHash(tree.tree, skillPath),
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
        artifact: {
          type: "skill-md",
          contents,
          complete: artifactComplete,
          textFiles,
          files: skillEntries.map((entry) => ({
            path: entry.path,
            type: entry.type,
            mode: entry.mode,
            size: entry.size,
            sha: entry.sha,
          })),
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

  private async githubJson(path: string): Promise<unknown> {
    const response = await this.githubFetch(path, "application/vnd.github+json");
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub API returned HTTP ${response.status}`);
    }
    const bytes = await readBoundedResponse(response, 4_194_304);
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
        await response.body?.cancel();
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
      await response.body?.cancel();
      await this.sleep(Math.min(Math.max(Math.ceil(requestedDelay), 0), 30_000));
    }
    return response!;
  }
}
