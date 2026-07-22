import { ArrowLeft, ArrowRight, Box, CircleCheck, Layers3 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CategoryIcon } from "@/components/marketplace/category-icon";
import { ExploreRail } from "@/components/marketplace/explore-rail";
import { PackageGrid } from "@/components/marketplace/package-grid";
import { SkillShelf } from "@/components/marketplace/skill-shelf";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import {
  catalogCategories,
  getCatalogCategory,
  packageBelongsToCatalogCategory,
} from "@/lib/marketplace/categories";
import { loadMarketplaceCatalog } from "@/lib/marketplace/catalog";
import { launchPackageBlueprints } from "@/lib/packages";
import { createPageMetadata } from "@/lib/seo";

type CategoryPageProps = Readonly<{ params: Promise<{ slug: string }> }>;

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: CategoryPageProps): Promise<Metadata> {
  const { slug } = await params;
  const category = getCatalogCategory(slug);
  if (!category) return {};
  return createPageMetadata({
    title: category.name,
    description: category.description,
    path: `/categories/${slug}`,
  });
}

export default async function CategoryPage({ params }: CategoryPageProps) {
  const { slug } = await params;
  const category = getCatalogCategory(slug);
  if (!category) notFound();

  const blueprints = launchPackageBlueprints.filter((blueprint) =>
    packageBelongsToCatalogCategory(blueprint, category.slug));
  const curatedReferenceCount = blueprints.reduce((total, blueprint) => total + blueprint.members.length, 0);
  const catalog = await loadMarketplaceCatalog({ category: category.slug, limit: 6 });

  return (
    <div className="site-frame">
      <SiteHeader />
      <main className="marketplace-shell shell">
        <ExploreRail active="categories" />
        <div className="marketplace-main">
          <Link className="market-back-link" href="/categories"><ArrowLeft aria-hidden="true" size={15} /> All categories</Link>
          <header className="category-detail-hero" data-color={category.colorToken}>
            <div className="category-detail-hero__index">{String(catalogCategories.findIndex((item) => item.slug === category.slug) + 1).padStart(2, "0")}</div>
            <div className="category-detail-hero__icon"><CategoryIcon size={31} token={category.iconToken} /></div>
            <div>
              <Badge tone="iris">Category</Badge>
              <h1>{category.name}</h1>
              <p>{category.description}</p>
            </div>
          </header>

          <section aria-labelledby="category-live-skills" className="market-section category-live-section">
            <div className="market-section__heading">
              <div>
                <span>01 / Skills</span>
                <h2 id="category-live-skills">Skills in this category.</h2>
              </div>
              <div className="category-live-section__action">
                <p>Some skills may be unavailable until their source is checked.</p>
                <ButtonLink href={`/skills?category=${category.slug}`} variant="secondary">
                  Open full explorer <ArrowRight aria-hidden="true" size={15} />
                </ButtonLink>
              </div>
            </div>
            <SkillShelf availability={catalog.availability} skills={catalog.skills} />
          </section>

          {blueprints.length > 0 ? (
            <section aria-labelledby="category-package" className="market-section market-section--rule">
              <div className="market-section__heading">
                <div>
                  <span>02 / Packages</span>
                  <h2 id="category-package">Start with a package.</h2>
                </div>
                <p>These packages combine {curatedReferenceCount} public skills from this category.</p>
              </div>
              <div className="category-package-feature">
                <PackageGrid packages={blueprints} priorityCount={1} />
                <div className="category-package-feature__notes">
                  <span><Box aria-hidden="true" size={16} /> {curatedReferenceCount} public skills</span>
                  <span><CircleCheck aria-hidden="true" size={16} /> {blueprints.length} {blueprints.length === 1 ? "package" : "packages"}</span>
                  <span><Layers3 aria-hidden="true" size={16} /> Ready to add</span>
                </div>
              </div>
            </section>
          ) : null}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
