import type { Metadata } from "next";

export const siteDescription =
  "Discover public Agent Skills, inspect their provenance and trust signals, and compose an installable stack.";

export const siteOrigin = new URL(
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
);

export type SiteRelativePath = "/" | `/${string}`;

export const sitemapRoutes = [
  "/",
  "/skills",
  "/packages",
  "/categories",
  "/stack",
  "/docs",
  "/docs/public-catalog-policy",
  "/safety",
  "/coverage",
  "/privacy",
] as const satisfies ReadonlyArray<SiteRelativePath>;

type PageMetadata = {
  title: string;
  description: string;
  path: SiteRelativePath;
};

export function siteRelativePath(value: string): SiteRelativePath {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("Metadata paths must be safe site-relative paths without query or fragment data.");
  }
  return value as SiteRelativePath;
}

export function absoluteUrl(path: SiteRelativePath) {
  return new URL(path, siteOrigin).toString();
}

export function createPageMetadata({ description, path, title }: PageMetadata): Metadata {
  const safePath = siteRelativePath(path);
  return {
    title,
    description,
    alternates: { canonical: safePath },
    openGraph: {
      type: "website",
      siteName: "Aisle",
      title,
      description,
      url: safePath,
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
  };
}
