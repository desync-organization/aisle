import { describe, expect, it } from "vitest";

import { metadata as categoriesMetadata } from "@/app/categories/page";
import { metadata as docsMetadata } from "@/app/docs/page";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { metadata as skillsMetadata } from "@/app/skills/page";

describe("static discovery metadata", () => {
  it("publishes canonical URLs for indexable routes", () => {
    expect(skillsMetadata.alternates).toMatchObject({ canonical: "/skills" });
    expect(categoriesMetadata.alternates).toMatchObject({ canonical: "/categories" });
    expect(docsMetadata.alternates).toMatchObject({ canonical: "/docs" });
  });

  it("exposes a public robots policy and sitemap", () => {
    expect(robots()).toMatchObject({
      rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/stack"] },
      sitemap: "http://localhost:3000/sitemap.xml",
    });
  });

  it("lists only real static routes while catalog records are unavailable", () => {
    const urls = sitemap().map((entry) => entry.url);

    expect(urls).toContain("http://localhost:3000/docs");
    expect(urls).toContain("http://localhost:3000/coverage");
    expect(urls.some((url) => /\/skills\/[^/]+$/.test(url))).toBe(false);
    expect(urls.some((url) => /\/packages\/[^/]+$/.test(url))).toBe(false);
    expect(urls.some((url) => url.endsWith("/stack"))).toBe(false);
  });
});
