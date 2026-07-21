import { ArrowUpRight, Grid2X2, Layers3 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { CategoryIcon } from "@/components/marketplace/category-icon";
import { ExploreRail } from "@/components/marketplace/explore-rail";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { marketplaceCategories } from "@/lib/marketplace/categories";
import { loadMarketplaceCatalog } from "@/lib/marketplace/catalog";
import { launchPackageBlueprints } from "@/lib/packages";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Categories",
  description: "Explore public Agent Skills by the work they help accomplish.",
  path: "/categories",
});

export default async function CategoriesPage() {
  const catalog = await loadMarketplaceCatalog({ limit: 1 });
  const liveCounts = new Map(catalog.categories.map((facet) => [facet.key, facet.count]));
  const packages = new Map(launchPackageBlueprints.map((blueprint) => [blueprint.editorial.category, blueprint]));

  return (
    <div className="site-frame">
      <SiteHeader />
      <main className="marketplace-shell shell">
        <ExploreRail active="categories" />
        <div className="marketplace-main">
          <header className="marketplace-hero marketplace-hero--categories">
            <div>
              <Badge tone="iris"><Grid2X2 aria-hidden="true" size={12} /> Outcome-led discovery</Badge>
              <h1>Start with the work, not the tool.</h1>
              <p>
                Eight durable categories cut across publishers and registries. Each one keeps package curation separate from live, catalog-eligible skills.
              </p>
            </div>
            <dl className="marketplace-hero__ledger">
              <div><dt>Categories</dt><dd>{marketplaceCategories.length}</dd></div>
              <div><dt>Curated workflows</dt><dd>{launchPackageBlueprints.length}</dd></div>
              <div><dt>Taxonomy</dt><dd>v1</dd></div>
            </dl>
          </header>

          <section aria-labelledby="category-grid-title" className="market-section category-index">
            <div className="market-section__heading">
              <div>
                <span>Browse / Outcome map</span>
                <h2 id="category-grid-title">Find your aisle.</h2>
              </div>
              <p>Catalog counts appear only when this environment has a provisioned source sync. Package member counts come from reviewed public-upstream manifests.</p>
            </div>
            <div className="category-grid">
              {marketplaceCategories.map((category, index) => {
                const blueprint = packages.get(category.slug);
                const liveCount = liveCounts.get(category.slug);
                return (
                  <article data-color={category.colorToken} key={category.slug}>
                    <div className="category-card__topline">
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <span className="category-card__icon"><CategoryIcon token={category.iconToken} /></span>
                    </div>
                    <h2><Link href={`/categories/${category.slug}`}>{category.name}</Link></h2>
                    <p>{category.description}</p>
                    <dl>
                      <div><dt>Catalog ready</dt><dd>{liveCount ?? "—"}</dd></div>
                      <div><dt>Curated refs</dt><dd>{blueprint?.members.length ?? "—"}</dd></div>
                    </dl>
                    <Link className="category-card__link" href={`/categories/${category.slug}`}>
                      Explore category <ArrowUpRight aria-hidden="true" size={15} />
                    </Link>
                  </article>
                );
              })}
            </div>
          </section>

          <div className="category-index__note">
            <Layers3 aria-hidden="true" size={18} />
            <div>
              <strong>One skill can support more than one job.</strong>
              <p>Categories are discovery context. The upstream name, source, and revision remain the skill’s identity.</p>
            </div>
            <Link href="/docs/public-catalog-policy">Read the policy <ArrowUpRight aria-hidden="true" size={15} /></Link>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
