import type { MetadataRoute } from "next";

import { absoluteUrl, staticRoutes } from "@/lib/seo";

const routePriority: Partial<Record<(typeof staticRoutes)[number], number>> = {
  "/": 1,
  "/skills": 0.9,
  "/packages": 0.8,
  "/docs": 0.8,
  "/safety": 0.7,
  "/coverage": 0.7,
};

export default function sitemap(): MetadataRoute.Sitemap {
  return staticRoutes.map((route) => ({
    url: absoluteUrl(route),
    changeFrequency: route === "/" ? "weekly" : "monthly",
    priority: routePriority[route] ?? 0.6,
  }));
}
