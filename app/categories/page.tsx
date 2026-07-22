import { ArrowUpRight, Grid2X2, Layers3 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { CategoryIcon } from "@/components/marketplace/category-icon";
import { ExploreRail } from "@/components/marketplace/explore-rail";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import {
  catalogCategories,
  packageBelongsToCatalogCategory,
} from "@/lib/marketplace/categories";
import { loadMarketplaceCatalog } from "@/lib/marketplace/catalog";
import { launchPackageBlueprints } from "@/lib/packages";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Categories",
  description: "Browse public Agent Skills by category.",
  path: "/categories",
});

export const dynamic = "force-dynamic";

export default async function CategoriesPage() {
  const catalog = await loadMarketplaceCatalog({ limit: 1 });
  const liveCounts = new Map(catalog.categories.map((facet) => [facet.key, facet.count]));

  return (
    <div className="site-frame">
      <SiteHeader />
      <main className="marketplace-shell shell">
        <ExploreRail active="categories" />
        <div className="marketplace-main">
          <header className="marketplace-hero marketplace-hero--categories">
            <div>
              <Badge tone="iris"><Grid2X2 aria-hidden="true" size={12} /> {catalogCategories.length} categories</Badge>
              <h1>Browse by category.</h1>
              <p>
                Find skills for frontend, backend, deployment, security, testing, and more.
              </p>
            </div>
            <dl className="marketplace-hero__ledger">
              <div><dt>Categories</dt><dd>{catalogCategories.length}</dd></div>
              <div><dt>Packages</dt><dd>{launchPackageBlueprints.length}</dd></div>
              <div><dt>Catalog</dt><dd>Public skills</dd></div>
            </dl>
          </header>

          <section aria-labelledby="category-grid-title" className="market-section category-index">
            <div className="market-section__heading">
              <div>
                <span>Browse</span>
                <h2 id="category-grid-title">Choose a category.</h2>
              </div>
              <p>Counts update as public sources are indexed.</p>
            </div>
            <div className="category-grid">
              {catalogCategories.map((category, index) => {
                const blueprints = launchPackageBlueprints.filter((blueprint) =>
                  packageBelongsToCatalogCategory(blueprint, category.slug));
                const curatedReferences = blueprints.reduce((total, blueprint) => total + blueprint.members.length, 0);
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
                      <div><dt>Skills</dt><dd>{liveCount ?? "—"}</dd></div>
                      <div><dt>Package skills</dt><dd>{curatedReferences || "—"}</dd></div>
                    </dl>
                    <Link className="category-card__link" href={`/categories/${category.slug}`}>
                      View category <ArrowUpRight aria-hidden="true" size={15} />
                    </Link>
                  </article>
                );
              })}
            </div>
          </section>

          <div className="category-index__note">
            <Layers3 aria-hidden="true" size={18} />
            <div>
              <strong>A skill can appear in more than one category.</strong>
              <p>Its name and original source never change.</p>
            </div>
            <Link href="/docs/public-catalog-policy">Read the policy <ArrowUpRight aria-hidden="true" size={15} /></Link>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
