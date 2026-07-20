import { normalizeDiscoveredSkill } from "./normalization";
import {
  discoveredSkillRecordSchema,
  type DiscoveredSkillRecord,
} from "./source-contract";
import type { CatalogRepository } from "../db/repository";

export interface PersistedDiscovery {
  listingId: string;
  skillId: string | null;
  revisionId: string | null;
  resolved: boolean;
}

export interface ValidatedSkillMetadata {
  name: string;
  description: string;
  compatibility: string | null;
  license: string;
  licenseEvidence?: { path: string; sha256: string; source: string } | null;
}

export interface TrustFindingInput {
  code: string;
  severity: "info" | "warning" | "critical";
  path: string | null;
  message: string;
  evidence: string | null;
}

export interface DiscoveryValidationResult {
  valid: boolean;
  metadata: ValidatedSkillMetadata | null;
  reason?: string;
  trustAssessment?: {
    scanner: string;
    scannerVersion: string;
    state: "unreviewed" | "pass" | "warn" | "fail" | "quarantined";
    quarantineReason: string | null;
    findings: TrustFindingInput[];
  };
  upstreamAudits?: Array<{
    provider: string;
    providerSlug: string;
    status: "pass" | "warn" | "fail";
    summary: string;
    scannerVersion: string | null;
    raw: Record<string, unknown>;
  }>;
}

export type DiscoveryRecordValidator = (
  record: DiscoveredSkillRecord,
) => Promise<DiscoveryValidationResult>;

export type OfficialPublisherPolicy = (
  record: DiscoveredSkillRecord,
) => boolean | Promise<boolean>;

export class CatalogIngestionService {
  constructor(
    private readonly repository: CatalogRepository,
    private readonly validateRecord: DiscoveryRecordValidator,
    private readonly officialPublisherPolicy: OfficialPublisherPolicy = () => false,
  ) {}

  async persist(
    sourceId: string,
    runId: string,
    candidate: unknown,
    options: { installs?: number } = {},
  ): Promise<PersistedDiscovery> {
    const parsed = discoveredSkillRecordSchema.safeParse(candidate);
    if (!parsed.success) {
      const identity =
        candidate &&
        typeof candidate === "object" &&
        "sourceRecordId" in candidate &&
        typeof candidate.sourceRecordId === "string"
          ? candidate.sourceRecordId
          : null;
      if (identity) await this.repository.markSourceRecordUnresolved(sourceId, identity, null);
      throw parsed.error;
    }
    const decoded = parsed.data;
    let normalized: ReturnType<typeof normalizeDiscoveredSkill>;
    try {
      normalized = normalizeDiscoveredSkill(decoded);
    } catch (error) {
      await this.repository.markSourceRecordUnresolved(
        sourceId,
        decoded.sourceRecordId,
        decoded.contentHash,
      );
      throw error;
    }
    const validation = await this.validateRecord(decoded);
    const listing = await this.repository.upsertSourceListing({
      sourceId,
      runId,
      upstreamId: normalized.sourceRecordId,
      sourceType: normalized.sourceType,
      installUrl: normalized.installUrl,
      sourceHash: normalized.contentHash,
      installs: options.installs ?? 0,
      preserveSourceHash: false,
      raw: normalized.raw,
    });

    if (
      !validation.valid ||
      !validation.metadata ||
      !normalized.immutableRef ||
      !normalized.contentHash ||
      !normalized.installUrl ||
      !normalized.installSpec
    ) {
      await this.repository.markListingUnresolved(listing.id, normalized.contentHash);
      return {
        listingId: listing.id,
        skillId: null,
        revisionId: null,
        resolved: false,
      };
    }

    const persisted = await this.repository.upsertCanonicalSkill({
      canonicalKey: normalized.canonicalKey,
      provider: normalized.provider,
      sourceUrl: normalized.sourceUrl,
      skillPath: normalized.skillPath,
      upstreamName: validation.metadata.name,
      upstreamDescription: validation.metadata.description,
      compatibility: validation.metadata.compatibility,
      license: validation.metadata.license,
      revisionMetadata: validation.metadata.licenseEvidence
        ? { licenseEvidence: validation.metadata.licenseEvidence }
        : {},
      officialProvenance: await this.officialPublisherPolicy(decoded),
      installUrl: normalized.installUrl,
      installSpec: normalized.installSpec,
      immutableRef: normalized.immutableRef,
      contentHash: normalized.contentHash,
      aliases: normalized.aliases,
      listingId: listing.id,
      repository: normalized.repository,
      trustAssessment: validation.trustAssessment,
      upstreamAudits: validation.upstreamAudits,
    });
    return {
      listingId: listing.id,
      skillId: persisted.skillId,
      revisionId: persisted.revisionId,
      resolved: true,
    };
  }
}
