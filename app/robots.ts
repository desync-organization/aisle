import type { MetadataRoute } from "next";

import { absoluteUrl, siteOrigin } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/stack"],
    },
    host: siteOrigin.origin,
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
