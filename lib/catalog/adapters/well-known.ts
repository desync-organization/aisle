import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { z } from "zod";

import {
  computeArtifactContentHash,
  normalizeArtifactFilePath,
} from "../artifact-fingerprint";
import { readBoundedResponse, requestTimeout } from "../http-safety";
import type {
  CatalogSourceConnector,
  ConnectorContext,
  ConnectorPage,
  DiscoveredSkillRecord,
} from "../source-contract";

const CURRENT_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
const PRIMARY_PATH = "/.well-known/agent-skills/index.json";
const LEGACY_PATH = "/.well-known/skills/index.json";

const indexEntrySchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^(?!-)(?!.*--)[a-z0-9-]+(?<!-)$/),
  type: z.enum(["skill-md", "archive"]),
  description: z.string().min(1).max(1_024),
  url: z.string().min(1),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

const discoveryIndexSchema = z.object({
  $schema: z.literal(CURRENT_SCHEMA),
  skills: z.array(indexEntrySchema).max(10_000),
});

const legacyDiscoveryIndexSchema = z.object({
  skills: z.array(
    z.object({
      name: z
        .string()
        .min(1)
        .max(64)
        .regex(/^(?!-)(?!.*--)[a-z0-9-]+(?<!-)$/),
      description: z.string().min(1).max(1_024),
      files: z.array(z.string().min(1)).min(1),
    }),
  ),
});

export interface WellKnownAdapterOptions {
  origin: string;
  adminApprovedOrigins: string[];
  fetch?: typeof fetch;
  allowedArtifactOrigins?: string[];
  maxArtifactBytes?: number;
  maxIndexBytes?: number;
  resolveHostname?: HostnameResolver;
  unsafeAllowUnpinnedHostnameFetch?: boolean;
}

type HostnameResolver = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

function assertPublicHttpsOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Well-known discovery requires a credential-free HTTPS origin");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    (isIP(hostname) !== 0 && isNonPublicIp(hostname)) ||
    /^(127\.|10\.|192\.168\.|169\.254\.)/.test(hostname)
  ) {
    throw new Error("Well-known discovery cannot target a local or private-network host");
  }
  return new URL(url.origin);
}

function isNonPublicIp(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0]!;
  if (normalized.startsWith("::ffff:")) {
    return isNonPublicIp(normalized.slice("::ffff:".length));
  }
  if (isIP(normalized) === 4) {
    const octets = normalized.split(".").map(Number);
    const [a = 0, b = 0] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(normalized) === 6) {
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("2001:db8:")
    );
  }
  return true;
}

function assertSafeRelativeFile(path: string): string {
  try {
    return normalizeArtifactFilePath(path);
  } catch {
    throw new Error("Legacy discovery file paths must be traversal-free relative paths");
  }
}

async function defaultResolver(hostname: string) {
  return lookup(hostname, { all: true, verbatim: true });
}

export class WellKnownSkillsAdapter implements CatalogSourceConnector {
  readonly descriptor;
  private readonly origin: URL;
  private readonly fetchImplementation: typeof fetch;
  private readonly allowedArtifactOrigins: Set<string>;
  private readonly maxArtifactBytes: number;
  private readonly maxIndexBytes: number;
  private readonly resolveHostname: HostnameResolver;
  private readonly unsafeAllowUnpinnedHostnameFetch: boolean;

  constructor(options: WellKnownAdapterOptions) {
    this.origin = assertPublicHttpsOrigin(options.origin);
    const adminApprovedOrigins = new Set(
      options.adminApprovedOrigins.map((value) => assertPublicHttpsOrigin(value).origin),
    );
    if (!adminApprovedOrigins.has(this.origin.origin)) {
      throw new Error("Well-known discovery origin is not in the administrator allowlist");
    }
    this.fetchImplementation = options.fetch ?? fetch;
    this.allowedArtifactOrigins = new Set([
      this.origin.origin,
      ...(options.allowedArtifactOrigins ?? []).map((value) => {
        const origin = assertPublicHttpsOrigin(value).origin;
        if (!adminApprovedOrigins.has(origin)) {
          throw new Error("Artifact origin is not in the administrator allowlist");
        }
        return origin;
      }),
    ]);
    this.maxArtifactBytes = options.maxArtifactBytes ?? 1_048_576;
    this.maxIndexBytes = options.maxIndexBytes ?? 2_097_152;
    this.resolveHostname = options.resolveHostname ?? defaultResolver;
    this.unsafeAllowUnpinnedHostnameFetch = options.unsafeAllowUnpinnedHostnameFetch ?? false;
    this.descriptor = {
      id: `well-known:${this.origin.hostname}`,
      name: `${this.origin.hostname} Agent Skills`,
      baseUrl: new URL(PRIMARY_PATH, this.origin).toString(),
      mode: "full" as const,
      upstreamIdentifier: `${this.origin.hostname}${PRIMARY_PATH}`,
      enabled: this.unsafeAllowUnpinnedHostnameFetch,
      initialCoverageState: this.unsafeAllowUnpinnedHostnameFetch
        ? "not-synced"
        : "not-configured",
      knownExclusions: [
        this.unsafeAllowUnpinnedHostnameFetch
          ? "Unsafe override enabled: hostname-based fetches are DNS-preflighted but not IP-pinned against DNS rebinding."
          : "Disabled: hostname-based fetches are not IP-pinned or egress-contained against DNS rebinding.",
      ],
    };
  }

  async *enumerate(context: ConnectorContext): AsyncIterable<ConnectorPage> {
    void context;
    if (!this.unsafeAllowUnpinnedHostnameFetch) {
      throw new Error(
        "Well-known discovery is disabled until fetches are IP-pinned or egress-contained",
      );
    }
    const { response, indexUrl, usedLegacyPath } = await this.fetchIndex();
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) {
      throw new Error("Well-known index must be served as application/json");
    }
    const indexBytes = await readBoundedResponse(response, this.maxIndexBytes);
    let indexJson: unknown;
    try {
      indexJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(indexBytes));
    } catch {
      throw new Error("Well-known index was not valid UTF-8 JSON");
    }
    const current = discoveryIndexSchema.safeParse(indexJson);
    const legacy = usedLegacyPath ? legacyDiscoveryIndexSchema.safeParse(indexJson) : null;
    if (!current.success && !legacy?.success) {
      throw new Error(
        `Unsupported or malformed Agent Skills discovery index: ${current.error.issues[0]?.message ?? legacy?.error.issues[0]?.message ?? "invalid index"}`,
      );
    }

    const entries = current.success
      ? current.data.skills.map((entry) => ({ ...entry, legacyFiles: null, raw: entry }))
      : legacy && legacy.success
        ? legacy.data.skills.map((entry) => {
          const manifest = entry.files.find(
            (file) => file === "SKILL.md" || file.endsWith("/SKILL.md"),
          );
          return {
            name: entry.name,
            type: "skill-md" as const,
            description: entry.description,
            url: manifest ?? "",
            digest: null,
            legacyFiles: entry.files,
            raw: entry,
          };
        })
        : [];

    const records: DiscoveredSkillRecord[] = [];
    const exclusions: string[] = usedLegacyPath
      ? [`Primary ${PRIMARY_PATH} returned 404; used legacy ${LEGACY_PATH}.`]
      : [];
    let degraded = false;

    for (const entry of entries) {
      try {
      if (!entry.url) {
        degraded = true;
        exclusions.push(`${entry.name}: legacy index did not identify a SKILL.md file.`);
        continue;
      }
      let legacyManifestPath: string | null = null;
      try {
        legacyManifestPath = entry.legacyFiles ? assertSafeRelativeFile(entry.url) : null;
      } catch (error) {
        degraded = true;
        exclusions.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}.`);
        continue;
      }
      const artifactUrl = entry.legacyFiles
        ? new URL(
            `${encodeURIComponent(entry.name)}/${legacyManifestPath!
              .split("/")
              .map(encodeURIComponent)
              .join("/")}`,
            new URL("/.well-known/skills/", this.origin),
          )
        : new URL(entry.url, indexUrl);
      if (
        artifactUrl.protocol !== "https:" ||
        artifactUrl.username ||
        artifactUrl.password ||
        !this.allowedArtifactOrigins.has(artifactUrl.origin)
      ) {
        degraded = true;
        exclusions.push(`${entry.name}: artifact origin is not allowlisted.`);
        continue;
      }
      try {
        await this.assertPublicDestination(artifactUrl);
      } catch (error) {
        degraded = true;
        exclusions.push(`${entry.name}: public-destination validation failed (${error instanceof Error ? error.message : String(error)}).`);
        continue;
      }
      const unresolvedRecord = (reason: string): DiscoveredSkillRecord => ({
        sourceRecordId: entry.name,
        provider: "well-known",
        sourceType: "well-known",
        sourceUrl: this.origin.toString(),
        skillPath: entry.name,
        upstreamName: entry.name,
        upstreamDescription: entry.description,
        compatibility: null,
        license: null,
        installUrl: this.origin.toString(),
        installSpec: entry.digest
          ? {
              kind: "registry",
              registry: `well-known:${this.origin.hostname}`,
              identifier: entry.name,
              version: entry.digest,
            }
          : null,
        immutableRef: entry.digest,
        contentHash: null,
        upstreamHash: entry.digest,
        public: true,
        internal: false,
        aliases: [entry.name],
        repository: null,
        artifact: null,
        raw: { ...entry.raw, artifactUrl: artifactUrl.toString(), unresolved: reason },
      });

      let artifact: DiscoveredSkillRecord["artifact"] = {
        type: entry.type,
        complete: false,
      };
      let resolvedContentHash = entry.digest;
      if (entry.type === "skill-md") {
        const artifactResponse = await this.fetchImplementation(artifactUrl, {
          headers: { accept: "text/markdown, text/plain;q=0.9" },
          redirect: "manual",
          signal: requestTimeout(),
        });
        if (!artifactResponse.ok) {
          degraded = true;
          exclusions.push(`${entry.name}: artifact returned HTTP ${artifactResponse.status}.`);
          await artifactResponse.body?.cancel();
          records.push(unresolvedRecord(`artifact HTTP ${artifactResponse.status}`));
          continue;
        }
        let bytes: Uint8Array;
        try {
          bytes = await readBoundedResponse(artifactResponse, this.maxArtifactBytes);
        } catch (error) {
          degraded = true;
          exclusions.push(`${entry.name}: bounded artifact read failed (${error instanceof Error ? error.message : String(error)}).`);
          records.push(unresolvedRecord("bounded artifact read failed"));
          continue;
        }
        const actualDigest = createHash("sha256").update(bytes).digest("hex");
        const expectedDigest = entry.digest?.slice("sha256:".length) ?? actualDigest;
        resolvedContentHash = `sha256:${expectedDigest}`;
        if (entry.digest && actualDigest !== expectedDigest) {
          degraded = true;
          exclusions.push(`${entry.name}: artifact digest did not match the discovery index.`);
          records.push(unresolvedRecord("artifact digest mismatch"));
          continue;
        }
        try {
          const contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          const artifactPath = entry.legacyFiles ? legacyManifestPath! : "SKILL.md";
          artifact = {
            type: "skill-md",
            contents,
            complete: !entry.legacyFiles || entry.legacyFiles.length === 1,
            textFiles: [
              {
                path: artifactPath,
                contents,
                sha256: actualDigest,
              },
            ],
            files: (entry.legacyFiles ?? [artifactPath]).map((path) =>
              path === artifactPath
                ? {
                    path,
                    type: "file",
                    size: bytes.byteLength,
                    sha: actualDigest,
                  }
                : { path, type: "unverified" },
            ),
          };
          if (!artifact.complete) {
            degraded = true;
            exclusions.push(`${entry.name}: legacy supporting files were not fully fetched for static scanning.`);
          }
        } catch {
          degraded = true;
          exclusions.push(`${entry.name}: artifact was not valid UTF-8.`);
          records.push(unresolvedRecord("artifact was not UTF-8"));
          continue;
        }
      } else {
        degraded = true;
        exclusions.push(`${entry.name}: archive recorded as unresolved pending safe archive validation.`);
      }
      if (!resolvedContentHash) {
        exclusions.push(`${entry.name}: no immutable content digest was available.`);
        continue;
      }

      records.push({
        sourceRecordId: entry.name,
        provider: "well-known",
        sourceType: "well-known",
        sourceUrl: this.origin.toString(),
        skillPath: entry.name,
        upstreamName: entry.name,
        upstreamDescription: entry.description,
        compatibility: null,
        license: null,
        installUrl: this.origin.toString(),
        installSpec: {
          kind: "registry",
          registry: `well-known:${this.origin.hostname}`,
          identifier: entry.name,
          version: resolvedContentHash,
        },
        immutableRef: resolvedContentHash,
        contentHash:
          artifact?.type === "skill-md" && artifact.complete && artifact.files?.length
            ? computeArtifactContentHash(artifact.files)
            : null,
        upstreamHash: resolvedContentHash,
        public: true,
        internal: false,
        aliases: [entry.name],
        repository: null,
        artifact,
        raw: { ...entry.raw, artifactUrl: artifactUrl.toString() },
      });
      } catch (error) {
        degraded = true;
        exclusions.push(
          `${entry.name}: artifact hydration failed (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    }

    yield {
      records,
      nextCursor: null,
      hasMore: false,
      reportedTotal: entries.length,
      completeSnapshot: !degraded,
      degraded,
      exclusions,
    };
  }

  private async fetchIndex(): Promise<{
    response: Response;
    indexUrl: URL;
    usedLegacyPath: boolean;
  }> {
    const primaryUrl = new URL(PRIMARY_PATH, this.origin);
    await this.assertPublicDestination(primaryUrl);
    const primary = await this.fetchImplementation(primaryUrl, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: requestTimeout(),
    });
    if (primary.ok) {
      return { response: primary, indexUrl: primaryUrl, usedLegacyPath: false };
    }
    await primary.body?.cancel();
    if (primary.status !== 404) {
      throw new Error(`Well-known index returned HTTP ${primary.status}`);
    }

    const legacyUrl = new URL(LEGACY_PATH, this.origin);
    await this.assertPublicDestination(legacyUrl);
    const legacy = await this.fetchImplementation(legacyUrl, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: requestTimeout(),
    });
    if (!legacy.ok) {
      await legacy.body?.cancel();
      throw new Error(`Well-known index was not found (legacy HTTP ${legacy.status})`);
    }
    return { response: legacy, indexUrl: legacyUrl, usedLegacyPath: true };
  }

  private async assertPublicDestination(url: URL): Promise<void> {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const directAddress = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : null;
    const addresses = directAddress ?? (await this.resolveHostname(hostname));
    if (!addresses.length || addresses.some(({ address }) => isNonPublicIp(address))) {
      throw new Error(`Well-known destination ${hostname} resolved to a non-public address`);
    }
  }
}

export const wellKnownDiscoverySchemaUri = CURRENT_SCHEMA;
