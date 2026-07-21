import type { CatalogRepository } from "./repository";

export const taxonomySeed = [
  ["frontend", "Frontend", "UI engineering, browser experiences, and frontend frameworks."],
  ["backend", "Backend", "APIs, services, databases, and server-side engineering."],
  ["mobile", "Mobile", "Native and cross-platform mobile application development."],
  ["ai-agents", "AI & Agents", "Agent workflows, model integration, and AI application engineering."],
  ["data", "Data", "Data engineering, analytics, databases, and visualization."],
  ["devops", "DevOps", "Delivery, infrastructure, observability, and reliability."],
  ["deployment", "Deployment", "Hosting platforms, releases, and production operations."],
  ["security", "Cybersecurity", "Security review, defense, forensics, and authorized testing."],
  ["testing", "Testing", "Automated testing, quality assurance, and verification."],
  ["productivity", "Productivity", "Documentation, collaboration, and development workflow."],
] as const;

export const sourceDescriptorSeed = [
  {
    id: "skills-sh",
    name: "skills.sh",
    baseUrl: "https://skills.sh/api/v1",
    mode: "full" as const,
    upstreamIdentifier: "skills.sh API v1",
    termsUrl: "https://skills.sh",
  },
  {
    id: "github-public",
    name: "Public GitHub repositories",
    baseUrl: "https://api.github.com",
    mode: "federated" as const,
    upstreamIdentifier: "GitHub public repository API",
    termsUrl: "https://docs.github.com/en/site-policy/github-terms/github-terms-of-service",
  },
  {
    id: "well-known-skills",
    name: "Public well-known skill indexes",
    baseUrl: "https://{host}/.well-known/agent-skills/index.json",
    mode: "on-demand" as const,
    upstreamIdentifier: "/.well-known/agent-skills/index.json (legacy fallback: /.well-known/skills/index.json)",
    termsUrl: null,
    enabled: false,
    initialCoverageState: "not-configured",
    knownExclusions: [
      "Disabled until hostname fetches are IP-pinned or egress-contained against DNS rebinding.",
    ],
  },
  {
    id: "skillmd",
    name: "SkillMD",
    baseUrl: "https://api.skillmd.com/v1/skills",
    mode: "federated" as const,
    upstreamIdentifier: "SkillMD public v1 skills API",
    termsUrl: "https://skillmd.com",
    enabled: true,
    initialCoverageState: "not-synced",
    knownExclusions: [
      "Entries without an immutable public GitHub source are indexed as unresolved and cannot be installed.",
      "Exact source artifacts that exceed bounded static-scan limits remain unresolved.",
      "SkillMD offset pages have no snapshot token; sweeps remain non-retiring partial coverage.",
    ],
  },
  {
    id: "skillsmp",
    name: "SkillsMP",
    baseUrl: "https://skillsmp.com/api/v1/skills/search",
    mode: "federated" as const,
    upstreamIdentifier: "SkillsMP documented search API",
    termsUrl: "https://skillsmp.com/docs/api",
    enabled: false,
    initialCoverageState: "not-configured",
    knownExclusions: [
      "The documented API requires a search query and rejects wildcard enumeration, so only future labeled federated searches are eligible.",
    ],
  },
  {
    id: "clawhub",
    name: "ClawHub",
    baseUrl: "https://clawhub.ai/api/v1/skills",
    mode: "full" as const,
    freshnessPolicy: "latest-completed-observation" as const,
    upstreamIdentifier: "ClawHub public skills HTTP API",
    termsUrl: "https://docs.openclaw.ai/clawhub/http-api",
    enabled: true,
    initialCoverageState: "not-synced",
    knownExclusions: [
      "ClawHub withholds private, hidden, and moderation-blocked skills from the public API.",
    ],
  },
] as const;

export async function seedCatalog(repository: CatalogRepository): Promise<void> {
  for (const [slug, name, description] of taxonomySeed) {
    await repository.upsertCategory({ slug, name, description });
  }

  for (const descriptor of sourceDescriptorSeed) {
    await repository.upsertSource({ ...descriptor });
  }
}
