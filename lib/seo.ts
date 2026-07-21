import type { Metadata } from "next";

export const siteDescription =
  "Discover public Agent Skills, inspect their provenance and trust signals, and compose an installable stack.";

export const siteOrigin = new URL(
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
);

export const staticRoutes = [
  "/",
  "/skills",
  "/packages",
  "/categories",
  "/docs",
  "/docs/public-catalog-policy",
  "/safety",
  "/coverage",
  "/privacy",
] as const;

type PageMetadata = {
  title: string;
  description: string;
  path: (typeof staticRoutes)[number];
};

export function absoluteUrl(path: string) {
  return new URL(path, siteOrigin).toString();
}

export function createPageMetadata({ description, path, title }: PageMetadata): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: "Aisle",
      title,
      description,
      url: path,
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
  };
}
