import { z } from "zod";

import {
  BoundedHttpTransport,
  type BoundedHttpTransportOptions,
  RegistryContractError,
} from "./http-transport";

export const GETSKILLARY_MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

const packageSchema = z
  .object({
    size_bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f\d]{64}$/i, "Package SHA-256 must contain 64 hexadecimal characters"),
  })
  .passthrough();

const providerSkillSchema = z
  .object({
    skill_id: z.string().min(1).max(512),
    slug: z.string().regex(/^[a-z\d]+(?:-[a-z\d]+)*$/).max(256),
    title: z.string().min(1).max(512),
    summary: z.string().min(1).max(20_000),
    category: z.string().min(1).max(256),
    tags: z.array(z.string().min(1).max(128)).max(100),
    canonical_url: z.string().min(1).max(4_096),
    download_url: z.string().min(1).max(4_096),
    package: packageSchema,
  })
  .passthrough();

const snapshotSchema = z
  .object({
    generated_at: z.iso.datetime(),
    record_count: z.number().int().nonnegative(),
    public_boundary: z.string().min(1).max(5_000),
    skills: z.array(providerSkillSchema),
  })
  .passthrough();

export interface GetSkillarySkill {
  providerRecordId: string;
  slug: string;
  title: string;
  summary: string;
  category: string;
  tags: readonly string[];
  canonicalUrl: string;
  downloadUrlObservation: string;
  providerPackageObservation: {
    sizeBytes: number;
    archiveSha256: string;
  };
  upstreamRepository: null;
  upstreamLicense: null;
}

export interface GetSkillarySnapshot {
  generatedAt: string;
  recordCount: number;
  publicBoundary: string;
  scope: {
    kind: "declared_selected_public_boundary";
    completeWithinDeclaredBoundary: true;
    sourceWideComplete: false;
  };
  skills: GetSkillarySkill[];
}

export interface GetSkillaryClientOptions
  extends Omit<BoundedHttpTransportOptions, "baseUrl" | "maxJsonBytes"> {
  baseUrl?: string;
  maxSnapshotBytes?: number;
}

function httpsUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new RegistryContractError(`GetSkillary ${label} is not a valid URL`, error);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new RegistryContractError(`GetSkillary ${label} must be an HTTPS URL without credentials`);
  }
  return parsed;
}

function canonicalUrl(value: string, slug: string): string {
  const parsed = httpsUrl(value, "canonical URL");
  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  if (
    parsed.hostname.toLowerCase() !== "getskillary.com" ||
    parsed.search ||
    parsed.hash ||
    normalizedPath !== `/skills/${slug}`
  ) {
    throw new RegistryContractError("GetSkillary canonical URL conflicts with its skill slug");
  }
  return parsed.toString();
}

function downloadUrl(value: string): string {
  const parsed = httpsUrl(value, "download URL");
  if (parsed.search || parsed.hash || !parsed.pathname.toLowerCase().endsWith(".zip")) {
    throw new RegistryContractError("GetSkillary download URL must identify an HTTPS ZIP package");
  }
  return parsed.toString();
}

function normalizeSkill(skill: z.infer<typeof providerSkillSchema>): GetSkillarySkill {
  return {
    providerRecordId: skill.skill_id,
    slug: skill.slug,
    title: skill.title.trim(),
    summary: skill.summary.trim(),
    category: skill.category.trim(),
    tags: [...skill.tags],
    canonicalUrl: canonicalUrl(skill.canonical_url, skill.slug),
    downloadUrlObservation: downloadUrl(skill.download_url),
    providerPackageObservation: {
      sizeBytes: skill.package.size_bytes,
      archiveSha256: skill.package.sha256.toLowerCase(),
    },
    upstreamRepository: null,
    upstreamLicense: null,
  };
}

function boundedSnapshotBytes(value: number | undefined): number {
  const chosen = Math.min(value ?? GETSKILLARY_MAX_SNAPSHOT_BYTES, GETSKILLARY_MAX_SNAPSHOT_BYTES);
  if (!Number.isSafeInteger(chosen) || chosen <= 0) {
    throw new RangeError("GetSkillary snapshot byte limit must be a positive integer");
  }
  return chosen;
}

export class GetSkillaryClient {
  private readonly transport: BoundedHttpTransport;
  private readonly maxSnapshotBytes: number;

  constructor(options: GetSkillaryClientOptions = {}) {
    const { baseUrl, maxSnapshotBytes, ...transportOptions } = options;
    this.maxSnapshotBytes = boundedSnapshotBytes(maxSnapshotBytes);
    this.transport = new BoundedHttpTransport({
      ...transportOptions,
      baseUrl: baseUrl ?? "https://getskillary.com/",
      maxJsonBytes: this.maxSnapshotBytes,
    });
  }

  async snapshot(): Promise<GetSkillarySnapshot> {
    const response = await this.transport.getJson(
      "skills.json",
      snapshotSchema,
      this.maxSnapshotBytes,
    );
    if (response.record_count !== response.skills.length) {
      throw new RegistryContractError(
        `GetSkillary declared ${response.record_count} records but returned ${response.skills.length}`,
      );
    }

    const skills = response.skills.map(normalizeSkill);
    const ids = new Set<string>();
    const slugs = new Set<string>();
    for (const skill of skills) {
      if (ids.has(skill.providerRecordId) || slugs.has(skill.slug)) {
        throw new RegistryContractError("GetSkillary snapshot contains duplicate IDs or slugs");
      }
      ids.add(skill.providerRecordId);
      slugs.add(skill.slug);
    }

    return {
      generatedAt: response.generated_at,
      recordCount: response.record_count,
      publicBoundary: response.public_boundary,
      scope: {
        kind: "declared_selected_public_boundary",
        completeWithinDeclaredBoundary: true,
        sourceWideComplete: false,
      },
      skills,
    };
  }
}
