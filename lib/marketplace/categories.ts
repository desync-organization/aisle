import type { packageCategories } from "@/lib/packages";

export type MarketplaceCategorySlug = (typeof packageCategories)[number];

export type MarketplaceCategory = Readonly<{
  slug: MarketplaceCategorySlug;
  name: string;
  shortName: string;
  description: string;
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

export const marketplaceCategories: ReadonlyArray<MarketplaceCategory> = [
  {
    slug: "frontend",
    name: "Frontend engineering",
    shortName: "Frontend",
    description: "React architecture, component systems, interface craft, and performance-aware product work.",
    prompt: "Build interfaces that stay coherent as the product and team grow.",
    iconToken: "brackets",
    colorToken: "iris",
  },
  {
    slug: "motion-3d",
    name: "Motion & 3D",
    shortName: "Motion & 3D",
    description: "Animation choreography, WebGL, Three.js, React 3D, and cinematic interaction systems.",
    prompt: "Move from static screens to expressive, performant scenes.",
    iconToken: "orbit",
    colorToken: "magenta",
  },
  {
    slug: "deployment",
    name: "Deployment",
    shortName: "Deployment",
    description: "Cloud platforms, release workflows, infrastructure tooling, and app-store delivery.",
    prompt: "Carry a working application through the last mile to production.",
    iconToken: "rocket",
    colorToken: "amber",
  },
  {
    slug: "cybersecurity",
    name: "Cybersecurity",
    shortName: "Security",
    description: "Application review, identity boundaries, compliance, policy, and abuse prevention.",
    prompt: "Inspect the trust boundary before an attacker does.",
    iconToken: "shield",
    colorToken: "emerald",
  },
  {
    slug: "mobile",
    name: "Mobile development",
    shortName: "Mobile",
    description: "Expo, React Native, native-feeling UI, routing, data, styling, and release maintenance.",
    prompt: "Build for touch, platform conventions, and a durable release cycle.",
    iconToken: "device-mobile",
    colorToken: "coral",
  },
  {
    slug: "data-ai",
    name: "Data & AI",
    shortName: "Data & AI",
    description: "Databases, datasets, model workflows, application data layers, and AI-enabled products.",
    prompt: "Give intelligent products dependable data foundations.",
    iconToken: "database",
    colorToken: "blue",
  },
  {
    slug: "agent-engineering",
    name: "Agent engineering",
    shortName: "Agents",
    description: "Skills, tool protocols, state, sandboxing, orchestration, and browser-capable agents.",
    prompt: "Turn model capability into a system with explicit boundaries.",
    iconToken: "network",
    colorToken: "cyan",
  },
  {
    slug: "testing-quality",
    name: "Testing & quality",
    shortName: "Quality",
    description: "Browser testing, debugging, code review, verification, and measured web performance.",
    prompt: "Close the gap between code that exists and work that is proven.",
    iconToken: "check-circle",
    colorToken: "lime",
  },
] as const;

export function getMarketplaceCategory(slug: string): MarketplaceCategory | undefined {
  return marketplaceCategories.find((category) => category.slug === slug);
}
