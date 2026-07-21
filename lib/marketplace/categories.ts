import { taxonomySeed } from "@/lib/db/seed";
import { packageCategories, type PackageBlueprint } from "@/lib/packages";

export type CatalogCategorySlug = (typeof taxonomySeed)[number][0];
export type EditorialPackageCategory = (typeof packageCategories)[number];

type CategoryDesign = Readonly<{
  shortName: string;
  prompt: string;
  iconToken:
    | "brackets"
    | "orbit"
    | "rocket"
    | "shield"
    | "device-mobile"
    | "database"
    | "network"
    | "check-circle";
  colorToken: "iris" | "magenta" | "amber" | "emerald" | "coral" | "blue" | "cyan" | "lime";
}>;

export type CatalogCategory = CategoryDesign & Readonly<{
  slug: CatalogCategorySlug;
  name: string;
  description: string;
}>;

const categoryDesign = {
  frontend: {
    shortName: "Frontend",
    prompt: "Build browser experiences that stay coherent as the product and team grow.",
    iconToken: "brackets",
    colorToken: "iris",
  },
  backend: {
    shortName: "Backend",
    prompt: "Shape dependable APIs, services, and server-side application boundaries.",
    iconToken: "network",
    colorToken: "cyan",
  },
  mobile: {
    shortName: "Mobile",
    prompt: "Build for touch, platform conventions, and a durable release cycle.",
    iconToken: "device-mobile",
    colorToken: "coral",
  },
  "ai-agents": {
    shortName: "AI & Agents",
    prompt: "Turn model capability into a system with explicit tools, state, and safety boundaries.",
    iconToken: "orbit",
    colorToken: "magenta",
  },
  data: {
    shortName: "Data",
    prompt: "Give application and model workflows dependable data foundations.",
    iconToken: "database",
    colorToken: "blue",
  },
  devops: {
    shortName: "DevOps",
    prompt: "Operate delivery, infrastructure, observability, and reliability as one system.",
    iconToken: "rocket",
    colorToken: "lime",
  },
  deployment: {
    shortName: "Deployment",
    prompt: "Carry a working application through the last mile to production.",
    iconToken: "rocket",
    colorToken: "amber",
  },
  security: {
    shortName: "Security",
    prompt: "Inspect the trust boundary before an attacker does.",
    iconToken: "shield",
    colorToken: "emerald",
  },
  testing: {
    shortName: "Testing",
    prompt: "Close the gap between code that exists and work that is proven.",
    iconToken: "check-circle",
    colorToken: "lime",
  },
  productivity: {
    shortName: "Productivity",
    prompt: "Make documentation, collaboration, and developer workflows easier to repeat.",
    iconToken: "check-circle",
    colorToken: "iris",
  },
} as const satisfies Record<CatalogCategorySlug, CategoryDesign>;

export const catalogCategories: ReadonlyArray<CatalogCategory> = taxonomySeed.map(
  ([slug, name, description]) => ({ slug, name, description, ...categoryDesign[slug] }),
);

export const editorialPackageCategoryToCatalogCategory = {
  frontend: "frontend",
  "motion-3d": "frontend",
  deployment: "deployment",
  cybersecurity: "security",
  mobile: "mobile",
  "data-ai": "data",
  "agent-engineering": "ai-agents",
  "testing-quality": "testing",
} as const satisfies Record<EditorialPackageCategory, CatalogCategorySlug>;

export function getCatalogCategory(slug: string): CatalogCategory | undefined {
  return catalogCategories.find((category) => category.slug === slug);
}

export function getCatalogCategoryForEditorial(
  category: EditorialPackageCategory,
): CatalogCategory {
  const slug = editorialPackageCategoryToCatalogCategory[category];
  const match = getCatalogCategory(slug);
  if (!match) throw new Error(`Missing seeded catalog category: ${slug}`);
  return match;
}

export function packageBelongsToCatalogCategory(
  blueprint: PackageBlueprint,
  catalogCategory: CatalogCategorySlug,
): boolean {
  return editorialPackageCategoryToCatalogCategory[blueprint.editorial.category] === catalogCategory;
}
