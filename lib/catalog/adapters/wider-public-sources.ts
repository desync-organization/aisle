import type { CatalogSourceDescriptor } from "../source-contract";

export const agentSkillsInSourceDescriptor = {
  id: "agentskills-in",
  name: "AgentSkills.in",
  baseUrl: "https://www.agentskills.in/api/skills",
  mode: "full",
  freshnessPolicy: "retain",
  upstreamIdentifier: "AgentSkills.in public skills API",
  termsUrl: "https://www.agentskills.in",
  enabled: false,
  resumePartialRuns: false,
  initialCoverageState: "not-configured",
  knownExclusions: [
    "Synchronization is an explicit opt-in and requires a public-only GitHub API token for exact repository hydration.",
    "Offset pages are mutable and have no snapshot token, so one sweep cannot prove a current source-wide snapshot or retire absent records.",
    "Every provider identity is rebound to its observed exact public GitHub repository and SKILL.md path; hydration failures are excluded.",
    "Provider names, descriptions, categories, totals, ranking, and content-availability flags are discovery observations, not Aisle trust or completeness evidence.",
  ],
} satisfies CatalogSourceDescriptor;

export const askSkillSourceDescriptor = {
  id: "askskill",
  name: "AskSkill",
  baseUrl: "https://askill.sh/api/v1/skills",
  mode: "federated",
  freshnessPolicy: "retain",
  upstreamIdentifier: "AskSkill public v1 skills API",
  termsUrl: "https://askill.sh",
  enabled: false,
  resumePartialRuns: false,
  initialCoverageState: "not-configured",
  knownExclusions: [
    "Synchronization is an explicit opt-in and requires a public-only GitHub API token for exact repository hydration.",
    "Page numbers, totals, and reachable windows are mutable, so every sweep is partial, non-retiring federated coverage and cannot safely resume an earlier run.",
    "Every provider identity is rebound to its observed exact public GitHub repository and SKILL.md path; hydration failures are excluded.",
    "Provider names, descriptions, badges, rankings, AI scores, raw instructions, and totals are not persisted as Aisle trust or completeness evidence.",
  ],
} satisfies CatalogSourceDescriptor;

export const getSkillarySourceDescriptor = {
  id: "getskillary",
  name: "GetSkillary",
  baseUrl: "https://getskillary.com/skills.json",
  mode: "full",
  upstreamIdentifier: "GetSkillary declared selected-public JSON snapshot",
  termsUrl: "https://getskillary.com",
  enabled: false,
  initialCoverageState: "not-configured",
  knownExclusions: [
    "The client contract is implemented, but catalog hydration and synchronization are not connected; no records are claimed.",
    "Completeness applies only to GetSkillary's declared selected-public boundary, not every skill on GetSkillary or the public internet.",
    "A provider ZIP hash is an observation, not upstream repository, immutable revision, or license evidence; records lacking those proofs remain non-installable.",
  ],
} satisfies CatalogSourceDescriptor;

export const githubCodeSearchSourceDescriptor = {
  id: "github-code-search",
  name: "GitHub Code Search",
  baseUrl: "https://api.github.com/search/code",
  mode: "federated",
  upstreamIdentifier: "GitHub REST Code Search API",
  termsUrl: "https://docs.github.com/en/site-policy/github-terms/github-terms-of-service",
  enabled: false,
  initialCoverageState: "not-configured",
  knownExclusions: [
    "Code Search is query-only and cannot enumerate every public repository or skill.",
    "Each query exposes at most 1,000 results, may report incomplete results, and remains partial even when every reachable page is fetched.",
    "Search result SHA values identify blobs, not installable revisions; origin identity and an exact public commit-to-tree-to-SKILL.md binding must be verified before ingestion.",
    "Server-side GitHub credentials are required, and oversized, truncated, missing, private, or identity-conflicting origins fail closed.",
  ],
} satisfies CatalogSourceDescriptor;

export const widerPublicSourceDescriptors: CatalogSourceDescriptor[] = [
  agentSkillsInSourceDescriptor,
  askSkillSourceDescriptor,
  getSkillarySourceDescriptor,
  githubCodeSearchSourceDescriptor,
];
