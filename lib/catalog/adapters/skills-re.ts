import type {
  CatalogSourceConnector,
  ConnectorContext,
  ConnectorPage,
  DiscoveredSkillRecord,
} from "../source-contract";
import {
  SkillsReClient,
  type SkillsReClientOptions,
  type SkillsReSkill,
} from "./skills-re-client";
import { skillsReSourceDescriptor } from "./wider-public-sources";

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 20;
export const SKILLS_RE_MAX_COVERAGE_RECORDS = 1_000;

const SOURCE_RECORD_PREFIX = "skills-re:";
const SOURCE_OBSERVATION_URL = "https://api.skills.re/skills/search";
const MAX_STORED_DESCRIPTION_LENGTH = 4_096;
const MAX_STORED_CATEGORY_LENGTH = 128;
const MAX_STORED_TAGS = 32;
const MAX_STORED_TAG_LENGTH = 128;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export interface SkillsReConnectorOptions {
  enabled: boolean;
  client?: SkillsReClient;
  clientOptions?: SkillsReClientOptions;
  fetch?: typeof fetch;
  pageSize?: number;
  maxPages?: number;
  maxRecords?: number;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const chosen = value ?? fallback;
  if (!Number.isSafeInteger(chosen) || chosen < 1 || chosen > maximum) {
    throw new RangeError(`${label} must be an integer from 1 through ${maximum}`);
  }
  return chosen;
}

function stableSourceRecordId(providerRecordId: string): string {
  const trimmed = providerRecordId.trim();
  if (
    !trimmed ||
    trimmed !== providerRecordId ||
    trimmed.length > 512 ||
    CONTROL_CHARACTER_PATTERN.test(trimmed)
  ) {
    throw new Error("Skills.re returned an invalid provider record identifier");
  }
  return `${SOURCE_RECORD_PREFIX}${trimmed}`;
}

function storedTags(tags: readonly string[]): string[] {
  return [
    ...new Set(
      tags
        .slice(0, MAX_STORED_TAGS)
        .map((value) => value.trim().slice(0, MAX_STORED_TAG_LENGTH))
        .filter(Boolean),
    ),
  ];
}

function categoryHints(
  category: string | null,
  tags: readonly string[],
): NonNullable<DiscoveredSkillRecord["categoryHints"]> | undefined {
  const categories = category ? [category] : [];
  const boundedTags = tags.map((tag) => tag.slice(0, 64));
  return categories.length || boundedTags.length
    ? { categories, tags: boundedTags }
    : undefined;
}

function coverageRecord(
  skill: SkillsReSkill,
  sourceRecordId: string,
): DiscoveredSkillRecord {
  const description = skill.description.slice(0, MAX_STORED_DESCRIPTION_LENGTH);
  const normalizedCategory = skill.primaryCategory?.trim() || null;
  const primaryCategory = normalizedCategory?.slice(0, MAX_STORED_CATEGORY_LENGTH) ?? null;
  const tags = storedTags(skill.tags);
  const hints = categoryHints(primaryCategory, tags);

  return {
    sourceRecordId,
    provider: "skills-re",
    sourceType: "skills-re-public-search-observation",
    sourceUrl: SOURCE_OBSERVATION_URL,
    skillPath: ".",
    upstreamName: null,
    upstreamDescription: null,
    ...(hints ? { categoryHints: hints } : {}),
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
      kind: "skills-re-observation",
      schemaVersion: 1,
      observationKind: "coverage-only",
      providerRecordId: skill.providerRecordId,
      slug: skill.slug,
      title: skill.title,
      description,
      primaryCategory,
      tags,
      metadataBounds: {
        descriptionTruncated: description.length !== skill.description.length,
        categoryTruncated:
          normalizedCategory !== null && normalizedCategory.length > MAX_STORED_CATEGORY_LENGTH,
        tagsTruncated:
          tags.length !== skill.tags.length ||
          skill.tags.some((tag) => tag.length > MAX_STORED_TAG_LENGTH),
      },
      discovery: {
        endpoint: "POST https://api.skills.re/skills/search",
        mutableCursor: true,
        sourceWideComplete: false,
      },
      resolution: {
        repository: "unresolved",
        skillPath: "unresolved",
        license: "unresolved",
        immutableArtifact: "unresolved",
        selectable: false,
      },
    },
  };
}

/**
 * Skills.re search does not guarantee an authoritative repository-relative
 * skill path. Until it does, observations cannot enter the shared GitHub
 * hydrator and remain coverage-only by construction.
 */
export class SkillsReConnector implements CatalogSourceConnector {
  readonly descriptor;
  private readonly client: SkillsReClient | null;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly maxRecords: number;

  constructor(options: SkillsReConnectorOptions) {
    const configured = options.enabled;
    const configurationExclusions = configured
      ? []
      : [
          "Skills.re synchronization is disabled until AISLE_SKILLS_RE_ENABLED=true is explicitly configured.",
        ];
    this.descriptor = {
      ...skillsReSourceDescriptor,
      enabled: configured,
      initialCoverageState: configured ? "not-synced" : "not-configured",
      knownExclusions: [
        ...(skillsReSourceDescriptor.knownExclusions ?? []),
        ...configurationExclusions,
      ],
    };
    this.pageSize = boundedPositiveInteger(options.pageSize, DEFAULT_PAGE_SIZE, 100, "Page size");
    this.maxPages = boundedPositiveInteger(options.maxPages, DEFAULT_MAX_PAGES, 100, "Page limit");
    this.maxRecords = boundedPositiveInteger(
      options.maxRecords,
      SKILLS_RE_MAX_COVERAGE_RECORDS,
      10_000,
      "Coverage record limit",
    );
    if (!configured) {
      this.client = null;
      return;
    }
    this.client =
      options.client ??
      new SkillsReClient({
        ...(options.clientOptions ?? {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
  }

  async *enumerate(context: ConnectorContext): AsyncIterable<ConnectorPage> {
    if (!this.client) {
      throw new Error("Disabled Skills.re connectors must not be enumerated");
    }
    if (context.cursor !== null) {
      throw new Error("Skills.re mutable search sweeps cannot resume an earlier cursor");
    }

    const seenSourceRecordIds = new Set<string>();
    let cursor: string | null = null;
    let pageCount = 0;
    let providerRecordCount = 0;

    while (pageCount < this.maxPages && providerRecordCount < this.maxRecords) {
      const page = await this.client.search({
        limit: Math.min(this.pageSize, this.maxRecords - providerRecordCount),
        sort: "updated",
        ...(cursor === null ? {} : { cursor }),
      });
      pageCount += 1;
      providerRecordCount += page.skills.length;

      const records: DiscoveredSkillRecord[] = [];
      const exclusions: string[] = [];
      for (const skill of page.skills) {
        let sourceRecordId: string;
        try {
          sourceRecordId = stableSourceRecordId(skill.providerRecordId);
        } catch {
          exclusions.push("One Skills.re row had an invalid provider ID and was excluded.");
          continue;
        }
        if (seenSourceRecordIds.has(sourceRecordId)) {
          exclusions.push("A repeated Skills.re provider record was deduplicated.");
          continue;
        }
        seenSourceRecordIds.add(sourceRecordId);
        records.push(coverageRecord(skill, sourceRecordId));
      }

      const providerCapReached =
        providerRecordCount >= this.maxRecords && !page.pagination.isDone;
      const pageCapReached = pageCount >= this.maxPages && !page.pagination.isDone;
      if (providerCapReached) {
        exclusions.push(
          `Skills.re coverage stopped at the ${this.maxRecords}-record observation limit.`,
        );
      }
      if (pageCapReached) {
        exclusions.push(`Skills.re coverage stopped at the ${this.maxPages}-page limit.`);
      }

      const stop = page.pagination.isDone || providerCapReached || pageCapReached;
      yield {
        records,
        nextCursor: stop ? null : page.pagination.nextCursor,
        hasMore: !stop,
        reportedTotal: null,
        completeSnapshot: false,
        degraded: true,
        exclusions,
      };
      if (stop) return;

      if (page.pagination.nextCursor === null) {
        throw new Error("Skills.re pagination ended without a terminal isDone response");
      }
      cursor = page.pagination.nextCursor;
    }
  }
}
