import type {
  CatalogSourceConnector,
  ConnectorContext,
  ConnectorPage,
  DiscoveredSkillRecord,
} from "../source-contract";
import {
  GetSkillaryClient,
  type GetSkillaryClientOptions,
  type GetSkillarySkill,
} from "./getskillary-client";
import { getSkillarySourceDescriptor } from "./wider-public-sources";

export const GETSKILLARY_MAX_COVERAGE_RECORDS = 5_000;

const SOURCE_RECORD_PREFIX = "getskillary:";
const MAX_STORED_SUMMARY_LENGTH = 4_096;
const MAX_STORED_TAGS = 32;
const MAX_COVERAGE_BOUNDARY_LENGTH = 512;

export interface GetSkillaryConnectorOptions {
  enabled: boolean;
  client?: GetSkillaryClient;
  clientOptions?: GetSkillaryClientOptions;
  fetch?: typeof fetch;
  maxRecords?: number;
}

function boundedRecordLimit(value: number | undefined): number {
  const chosen = Math.min(
    value ?? GETSKILLARY_MAX_COVERAGE_RECORDS,
    GETSKILLARY_MAX_COVERAGE_RECORDS,
  );
  if (!Number.isSafeInteger(chosen) || chosen <= 0) {
    throw new RangeError("GetSkillary coverage record limit must be a positive integer");
  }
  return chosen;
}

function stableSourceRecordId(providerRecordId: string): string {
  const trimmed = providerRecordId.trim();
  if (
    !trimmed ||
    trimmed !== providerRecordId ||
    trimmed.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    throw new Error("GetSkillary returned an invalid provider record identifier");
  }
  return `${SOURCE_RECORD_PREFIX}${trimmed}`;
}

function boundedTags(tags: readonly string[]): string[] {
  return tags
    .slice(0, MAX_STORED_TAGS)
    .map((tag) => tag.trim().slice(0, 128))
    .filter(Boolean);
}

function categoryHints(skill: GetSkillarySkill): NonNullable<DiscoveredSkillRecord["categoryHints"]> {
  const category = skill.category.trim().slice(0, 128);
  const tags = [...new Set(boundedTags(skill.tags).map((tag) => tag.slice(0, 64)))];
  return {
    categories: category ? [category] : [],
    tags,
  };
}

function coverageRecord(
  skill: GetSkillarySkill,
  snapshot: {
    generatedAt: string;
    publicBoundary: string;
  },
): DiscoveredSkillRecord {
  const summary = skill.summary.slice(0, MAX_STORED_SUMMARY_LENGTH);
  const tags = boundedTags(skill.tags);
  const publicBoundary = snapshot.publicBoundary.slice(0, MAX_COVERAGE_BOUNDARY_LENGTH);

  return {
    sourceRecordId: stableSourceRecordId(skill.providerRecordId),
    provider: "getskillary",
    sourceType: "getskillary-selected-public-observation",
    sourceUrl: skill.canonicalUrl,
    skillPath: ".",
    upstreamName: null,
    upstreamDescription: null,
    categoryHints: categoryHints(skill),
    compatibility: null,
    license: null,
    installUrl: null,
    installSpec: null,
    immutableRef: null,
    contentHash: null,
    upstreamHash: null,
    public: true,
    internal: false,
    aliases: [],
    repository: null,
    repositoryLicenseEvidence: null,
    artifact: null,
    raw: {
      schemaVersion: 1,
      observationKind: "coverage-only",
      providerRecordId: skill.providerRecordId,
      slug: skill.slug,
      title: skill.title,
      summary,
      category: skill.category,
      tags,
      canonicalUrl: skill.canonicalUrl,
      snapshot: {
        generatedAt: snapshot.generatedAt,
        declaredPublicBoundary: publicBoundary,
        boundaryTruncated: publicBoundary.length !== snapshot.publicBoundary.length,
      },
      metadataBounds: {
        summaryTruncated: summary.length !== skill.summary.length,
        tagsTruncated: tags.length !== skill.tags.length,
      },
      providerArchiveObservation: {
        kind: "provider-declared-zip-metadata",
        sizeBytes: skill.providerPackageObservation.sizeBytes,
        archiveSha256: skill.providerPackageObservation.archiveSha256,
        installEvidence: false,
        downloadUrlPersisted: false,
      },
      resolution: {
        repository: "unresolved",
        license: "unresolved",
        immutableArtifact: "unresolved",
        selectable: false,
      },
    },
  };
}

export class GetSkillaryConnector implements CatalogSourceConnector {
  readonly descriptor;
  private readonly client: GetSkillaryClient | null;
  private readonly maxRecords: number;

  constructor(options: GetSkillaryConnectorOptions) {
    const configured = options.enabled;
    const configurationExclusions = configured
      ? []
      : [
          "GetSkillary synchronization is disabled until AISLE_GETSKILLARY_ENABLED=true is explicitly configured.",
        ];
    this.descriptor = {
      ...getSkillarySourceDescriptor,
      enabled: configured,
      initialCoverageState: configured ? "not-synced" : "not-configured",
      knownExclusions: [
        ...(getSkillarySourceDescriptor.knownExclusions ?? []),
        ...configurationExclusions,
      ],
    };
    this.maxRecords = boundedRecordLimit(options.maxRecords);
    if (!configured) {
      this.client = null;
      return;
    }
    this.client =
      options.client ??
      new GetSkillaryClient({
        ...(options.clientOptions ?? {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
  }

  async *enumerate(context: ConnectorContext): AsyncIterable<ConnectorPage> {
    if (!this.client) {
      throw new Error("Disabled GetSkillary connectors must not be enumerated");
    }
    if (context.cursor !== null) {
      throw new Error("GetSkillary snapshots are one-shot and cannot resume from a cursor");
    }

    const snapshot = await this.client.snapshot();
    if (snapshot.recordCount > this.maxRecords) {
      throw new Error(
        `GetSkillary declared ${snapshot.recordCount} records, exceeding the configured ${this.maxRecords}-record coverage limit`,
      );
    }

    const records = snapshot.skills.map((skill) =>
      coverageRecord(skill, {
        generatedAt: snapshot.generatedAt,
        publicBoundary: snapshot.publicBoundary,
      }),
    );
    const truncatedMetadataCount = records.filter((record) => {
      const bounds = record.raw.metadataBounds as
        | { summaryTruncated?: boolean; tagsTruncated?: boolean }
        | undefined;
      return bounds?.summaryTruncated === true || bounds?.tagsTruncated === true;
    }).length;
    const exclusions = [
      `GetSkillary declared ${snapshot.recordCount} records in its selected-public snapshot generated at ${snapshot.generatedAt}; this count is source-relative, not a count of every GetSkillary or public Agent Skill.`,
      `GetSkillary's declared boundary was retained for coverage display up to ${MAX_COVERAGE_BOUNDARY_LENGTH} characters: ${snapshot.publicBoundary.slice(0, MAX_COVERAGE_BOUNDARY_LENGTH)}`,
      ...(truncatedMetadataCount
        ? [
            `${truncatedMetadataCount} GetSkillary observation(s) exceeded Aisle's stored summary or tag bounds; their coverage identities remain unresolved and non-installable.`,
          ]
        : []),
    ];

    yield {
      records,
      nextCursor: null,
      hasMore: false,
      reportedTotal: snapshot.recordCount,
      completeSnapshot: snapshot.scope.completeWithinDeclaredBoundary,
      exclusions,
    };
  }
}
