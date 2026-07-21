export const CANONICAL_CATEGORY_SLUGS = [
  "frontend",
  "backend",
  "mobile",
  "ai-agents",
  "data",
  "devops",
  "deployment",
  "security",
  "testing",
  "productivity",
] as const;

export type CanonicalCategorySlug = (typeof CANONICAL_CATEGORY_SLUGS)[number];
export const SOURCE_CATEGORY_ATTRIBUTION = "aisle:source-metadata-v1";

export interface SourceCategoryHints {
  categories: readonly string[];
  tags: readonly string[];
}

export interface SkillCategoryEvidence {
  upstreamName: string | null;
  upstreamDescription: string | null;
  skillPath: string;
  categoryHints?: SourceCategoryHints;
}

function normalizeSignal(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("&", " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Public-provider vocabulary mapped onto Aisle's fixed taxonomy. Keys are
 * normalized with `normalizeSignal`; consumers should call `mapCategoryHint`.
 */
export const CATEGORY_HINT_ALIASES: Readonly<
  Record<string, readonly CanonicalCategorySlug[]>
> = {
  frontend: ["frontend"],
  "front end": ["frontend"],
  "web frontend": ["frontend"],
  react: ["frontend"],
  nextjs: ["frontend"],
  "next js": ["frontend"],
  vue: ["frontend"],
  svelte: ["frontend"],
  angular: ["frontend"],
  tailwind: ["frontend"],
  gsap: ["frontend"],
  webgl: ["frontend"],
  threejs: ["frontend"],
  "three js": ["frontend"],
  "motion 3d": ["frontend"],
  "motion and 3d": ["frontend"],
  backend: ["backend"],
  "back end": ["backend"],
  api: ["backend"],
  graphql: ["backend"],
  mobile: ["mobile"],
  ios: ["mobile"],
  android: ["mobile"],
  expo: ["mobile"],
  flutter: ["mobile"],
  "react native": ["mobile"],
  "ai agents": ["ai-agents"],
  "ai agent": ["ai-agents"],
  agentic: ["ai-agents"],
  "agent engineering": ["ai-agents"],
  "artificial intelligence": ["ai-agents"],
  llm: ["ai-agents"],
  rag: ["ai-agents"],
  mcp: ["ai-agents"],
  data: ["data"],
  analytics: ["data"],
  database: ["data"],
  "data engineering": ["data"],
  "data ai": ["data", "ai-agents"],
  "data and ai": ["data", "ai-agents"],
  devops: ["devops"],
  sre: ["devops"],
  observability: ["devops"],
  kubernetes: ["devops"],
  docker: ["devops"],
  terraform: ["devops"],
  deployment: ["deployment"],
  deployments: ["deployment"],
  hosting: ["deployment"],
  vercel: ["deployment"],
  netlify: ["deployment"],
  cybersecurity: ["security"],
  "cyber security": ["security"],
  security: ["security"],
  pentesting: ["security"],
  "penetration testing": ["security"],
  testing: ["testing"],
  quality: ["testing"],
  "quality assurance": ["testing"],
  "testing quality": ["testing"],
  "testing and quality": ["testing"],
  qa: ["testing"],
  productivity: ["productivity"],
  documentation: ["productivity"],
  collaboration: ["productivity"],
  "developer productivity": ["productivity"],
  "full stack": ["frontend", "backend"],
  fullstack: ["frontend", "backend"],
  "frontend and backend": ["frontend", "backend"],
};

export function mapCategoryHint(value: string): CanonicalCategorySlug[] {
  const normalized = normalizeSignal(value.slice(0, 128));
  if (!normalized) return [];
  const exact = CATEGORY_HINT_ALIASES[normalized];
  if (exact) {
    return CANONICAL_CATEGORY_SLUGS.filter((category) => exact.includes(category));
  }

  const categories = new Set<CanonicalCategorySlug>();
  for (const segment of value.split(/[,/|]+/).slice(0, 8)) {
    const mapped = CATEGORY_HINT_ALIASES[normalizeSignal(segment.slice(0, 128))];
    for (const category of mapped ?? []) categories.add(category);
  }
  return CANONICAL_CATEGORY_SLUGS.filter((category) => categories.has(category));
}

const TEXT_SIGNALS: Readonly<Record<CanonicalCategorySlug, readonly string[]>> = {
  frontend: [
    "frontend", "front end", "react", "nextjs", "next js", "vue", "svelte",
    "angular", "tailwind", "css", "design system", "web ui", "user interface",
    "gsap", "webgl", "three js", "motion design", "3d web",
  ],
  backend: [
    "backend", "back end", "server side", "api", "apis", "rest api", "graphql",
    "webhook", "authentication service", "microservice",
  ],
  mobile: [
    "mobile", "ios", "android", "react native", "expo", "flutter", "swiftui",
    "kotlin multiplatform",
  ],
  "ai-agents": [
    "ai agent", "ai agents", "agentic", "agent engineering", "multi agent", "llm",
    "large language model", "prompt engineering", "model context protocol", "mcp server",
    "retrieval augmented generation", "rag",
  ],
  data: [
    "data engineering", "data pipeline", "analytics", "database", "sql", "postgres",
    "postgresql", "mysql", "mongodb", "warehouse", "etl", "dbt", "apache spark",
    "data visualization",
  ],
  devops: [
    "devops", "ci cd", "continuous integration", "github actions", "observability",
    "site reliability", "sre", "kubernetes", "docker", "terraform",
    "infrastructure as code", "monitoring",
  ],
  deployment: [
    "deployment", "deploy", "hosting", "vercel", "netlify", "cloudflare pages",
    "release automation", "serverless deployment",
  ],
  security: [
    "cybersecurity", "cyber security", "security", "vulnerability", "threat model",
    "owasp", "penetration testing", "pentest", "malware", "forensics", "cryptography",
    "secret scanning",
  ],
  testing: [
    "testing", "quality assurance", "test automation", "unit test", "integration test",
    "end to end test", "e2e test", "playwright", "vitest", "jest", "cypress", "tdd",
  ],
  productivity: [
    "productivity", "documentation", "knowledge base", "project management", "issue triage",
    "code review", "developer workflow", "collaboration", "notion", "slack workflow",
  ],
};

function containsSignal(haystack: string, signal: string): boolean {
  return ` ${haystack} `.includes(` ${normalizeSignal(signal)} `);
}

/**
 * Classifies only bounded public metadata. The function intentionally cannot
 * accept artifact contents, so SKILL.md instruction bodies never influence it.
 */
export function classifySkillCategories(
  evidence: SkillCategoryEvidence,
): CanonicalCategorySlug[] {
  const categories = new Set<CanonicalCategorySlug>();
  const hints = evidence.categoryHints;
  for (const hint of [...(hints?.categories ?? []), ...(hints?.tags ?? [])]) {
    for (const category of mapCategoryHint(hint)) categories.add(category);
  }

  const searchable = normalizeSignal([
    evidence.upstreamName?.slice(0, 256) ?? "",
    evidence.upstreamDescription?.slice(0, 4_096) ?? "",
    evidence.skillPath.slice(0, 4_096),
  ].join(" "));
  for (const category of CANONICAL_CATEGORY_SLUGS) {
    if (TEXT_SIGNALS[category].some((signal) => containsSignal(searchable, signal))) {
      categories.add(category);
    }
  }
  return CANONICAL_CATEGORY_SLUGS.filter((category) => categories.has(category));
}
