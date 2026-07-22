import type { Metadata } from "next";

export const siteDescription =
  "Discover public Agent Skills, inspect their provenance and trust signals, and compose an installable stack.";

function nonEmptyEnvironmentValue(value: string | undefined): string | null {
  const candidate = value?.trim();
  return candidate ? candidate : null;
}

function originFromEnvironment(value: string, assumeHttps: boolean): URL {
  const candidate = assumeHttps && !/^https?:\/\//iu.test(value)
    ? `https://${value}`
    : value;
  const parsed = new URL(candidate);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("The public site URL must be an HTTP(S) origin without credentials.");
  }
  return new URL(parsed.origin);
}

const configuredSiteUrl = nonEmptyEnvironmentValue(process.env.NEXT_PUBLIC_SITE_URL);
const vercelDeploymentUrl = nonEmptyEnvironmentValue(
  process.env.VERCEL_PROJECT_PRODUCTION_URL,
) ?? nonEmptyEnvironmentValue(process.env.VERCEL_URL);

export const siteOrigin = configuredSiteUrl
  ? originFromEnvironment(configuredSiteUrl, false)
  : vercelDeploymentUrl
    ? originFromEnvironment(vercelDeploymentUrl, true)
    : new URL("http://localhost:3000");

export const siteSocialImage = {
  url: "/aisle-social.png",
  width: 1733,
  height: 909,
  alt: "Aisle public Agent Skills marketplace",
} as const;

export type SiteRelativePath = "/" | `/${string}`;

export const sitemapRoutes = [
  "/",
  "/skills",
  "/packages",
  "/collections",
  "/categories",
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
      images: [siteSocialImage],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [siteSocialImage.url],
    },
  };
}
