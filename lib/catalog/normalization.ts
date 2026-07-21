import { createHash } from "node:crypto";

import type { DiscoveredSkillRecord } from "./source-contract";

export class CatalogNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogNormalizationError";
  }
}

function safeUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    if (/^git@github\.com:/i.test(value)) {
      return new URL(`https://github.com/${value.slice(value.indexOf(":") + 1)}`);
    }
    throw new CatalogNormalizationError(`Invalid source URL: ${value}`);
  }
}

export function normalizeSourceUrl(value: string): string {
  const url = safeUrl(value.trim());
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new CatalogNormalizationError(`Unsupported source URL protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new CatalogNormalizationError("Source URLs must not contain credentials");
  }
  url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "") || "/";

  if (url.hostname === "github.com") {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) {
      throw new CatalogNormalizationError("GitHub source URLs require owner and repository");
    }
    url.pathname = `/${segments[0]!.toLowerCase()}/${segments[1]!.toLowerCase()}`;
  }
  return url.toString().replace(/\/$/, "");
}

export function normalizeSkillPath(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new CatalogNormalizationError("Skill paths must not contain control bytes");
  }
  let path = value.trim();
  for (let depth = 0; depth < 4; depth += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      throw new CatalogNormalizationError("Skill paths must use valid percent encoding");
    }
    if (decoded === path) break;
    path = decoded;
    if (depth === 3 && /%[0-9a-f]{2}/i.test(path)) {
      throw new CatalogNormalizationError("Skill paths exceed the supported encoding depth");
    }
  }
  if (/[%][0-9a-f]{2}|[\u0000-\u001f\u007f]/i.test(path)) {
    throw new CatalogNormalizationError("Skill paths must not contain encoded or control bytes");
  }
  path = path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  path = path.replace(/\/+$/, "");
  if (path.toLowerCase().endsWith("/skill.md")) {
    path = path.slice(0, -"/SKILL.md".length);
  } else if (path.toLowerCase() === "skill.md") {
    path = ".";
  }
  if (!path || path.startsWith("/") || /^[a-z]:/i.test(path)) {
    throw new CatalogNormalizationError("Skill paths must be non-empty and relative");
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "..")) {
    throw new CatalogNormalizationError("Skill paths must not contain empty or traversal segments");
  }
  return segments.filter((segment) => segment !== ".").join("/") || ".";
}

export function canonicalSkillKey(provider: string, sourceUrl: string, skillPath: string): string {
  return [
    provider.trim().toLowerCase(),
    normalizeSourceUrl(sourceUrl),
    normalizeSkillPath(skillPath),
  ].join(":");
}

export function normalizeContentHash(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return value.trim().toLowerCase().replace(/^sha256:/, "");
}

export function stableCatalogId(namespace: string, value: string): string {
  return `${namespace}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

export interface NormalizedSkillRecord extends Omit<DiscoveredSkillRecord, "upstreamHash"> {
  upstreamHash: string | null;
  canonicalKey: string;
}

export function normalizeDiscoveredSkill(record: DiscoveredSkillRecord): NormalizedSkillRecord {
  if (!record.public || record.internal) {
    throw new CatalogNormalizationError("Private or internal skills cannot enter the public catalog");
  }
  const sourceUrl = normalizeSourceUrl(record.sourceUrl);
  const skillPath = normalizeSkillPath(record.skillPath);
  const contentHash = normalizeContentHash(record.contentHash);
  const upstreamHash = record.upstreamHash?.trim() || null;
  const immutableRef = record.immutableRef?.trim() || null;
  const upstreamName = record.upstreamName?.trim() || null;
  const upstreamDescription = record.upstreamDescription?.trim() || null;
  return {
    ...record,
    provider: record.provider.trim().toLowerCase(),
    sourceUrl,
    skillPath,
    contentHash,
    upstreamHash,
    immutableRef,
    upstreamName,
    upstreamDescription,
    license: record.license?.trim() || "unknown",
    compatibility: record.compatibility?.trim() || null,
    aliases: [...new Set(record.aliases.map((alias) => alias.trim()).filter(Boolean))],
    repository: record.repository
      ? {
          ...record.repository,
          provider: record.repository.provider.trim().toLowerCase(),
          url: normalizeSourceUrl(record.repository.url),
        }
      : null,
    canonicalKey: canonicalSkillKey(record.provider, sourceUrl, skillPath),
  };
}
