import { ArrowLeft, ArrowRight, Box, CircleCheck, Layers3 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CategoryIcon } from "@/components/marketplace/category-icon";
import { ExploreRail } from "@/components/marketplace/explore-rail";
import { PackageCard } from "@/components/marketplace/package-card";
import { SkillShelf } from "@/components/marketplace/skill-shelf";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { getMarketplaceCategory, marketplaceCategories } from "@/lib/marketplace/categories";
import { loadMarketplaceCatalog } from "@/lib/marketplace/catalog";
import { launchPackageBlueprints } from "@/lib/packages";
import { createPageMetadata } from "@/lib/seo";

type CategoryPageProps = Readonly<{ params: Promise<{ slug: string }> }>;

export function generateStaticParams() {
  return marketplaceCategories.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: CategoryPageProps): Promise<Metadata> {
  const { slug } = await params;
  const category = getMarketplaceCategory(slug);
  if (!category) return {};
  return createPageMetadata({
    title: category.name,
    description: category.description,
    path: `/categories/${slug}`,
  });
}

export default async function CategoryPage({ params }: CategoryPageProps) {
  const { slug } = await params;
  const category = getMarketplaceCategory(slug);
  if (!category) notFound();

  const blueprint = launchPackageBlueprints.find((candidate) => candidate.editorial.category === category.slug);
  const catalog = await loadMarketplaceCatalog({ category: category.slug, limit: 6 });

  return (
    <div className="site-frame">
      <SiteHeader />
      <main className="marketplace-shell shell">
        <ExploreRail active="categories" />
        <div className="marketplace-main">
          <Link className="market-back-link" href="/categories"><ArrowLeft aria-hidden="true" size={15} /> All categories</Link>
          <header className="category-detail-hero" data-color={category.colorToken}>
            <div className="category-detail-hero__index">{String(marketplaceCategories.findIndex((item) => item.slug === category.slug) + 1).padStart(2, "0")}</div>
            <div className="category-detail-hero__icon"><CategoryIcon size={31} token={category.iconToken} /></div>
            <div>
              <Badge tone="iris">Marketplace category</Badge>
              <h1>{category.name}</h1>
              <p>{category.description}</p>
            </div>
            <blockquote>{category.prompt}</blockquote>
          </header>

          <section aria-labelledby="category-live-skills" className="market-section category-live-section">
            <div className="market-section__heading">
              <div>
                <span>01 / Catalog-ready</span>
                <h2 id="category-live-skills">Eligible skills in this aisle.</h2>
              </div>
              <div className="category-live-section__action">
                <p>Only current records that passed the catalog’s selectable boundary appear here.</p>
                <ButtonLink href={`/skills?category=${category.slug}`} variant="secondary">
                  Open full explorer <ArrowRight aria-hidden="true" size={15} />
                </ButtonLink>
              </div>
            </div>
            <SkillShelf availability={catalog.availability} skills={catalog.skills} />
          </section>

          {blueprint ? (
            <section aria-labelledby="category-package" className="market-section market-section--rule">
              <div className="market-section__heading">
                <div>
                  <span>02 / Curated workflow</span>
                  <h2 id="category-package">Take the complete route.</h2>
                </div>
                <p>This editorial manifest references {blueprint.members.length} real public upstream skills. Inspect it before adding anything.</p>
              </div>
              <div className="category-package-feature">
                <PackageCard blueprint={blueprint} priority />
                <div className="category-package-feature__notes">
                  <span><Box aria-hidden="true" size={16} /> {blueprint.members.length} upstream references</span>
                  <span><CircleCheck aria-hidden="true" size={16} /> {blueprint.editorial.audience.length} audience profiles</span>
                  <span><Layers3 aria-hidden="true" size={16} /> One reviewed outcome</span>
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
