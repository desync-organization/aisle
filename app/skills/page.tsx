import { CircleCheck, DatabaseZap, GitBranch, Layers3 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { ExploreRail } from "@/components/marketplace/explore-rail";
import { SkillsExplorer } from "@/components/marketplace/skills-explorer";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { catalogCategories, getCatalogCategory } from "@/lib/marketplace/categories";
import { loadMarketplaceCatalog } from "@/lib/marketplace/catalog";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Skills",
  description: "Search, filter, compare, and select eligible public Agent Skills without losing upstream provenance.",
  path: "/skills",
});

export const dynamic = "force-dynamic";

type SkillsPageProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

function firstValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function SkillsPage({ searchParams }: SkillsPageProps) {
  const params = await searchParams;
  const query = firstValue(params.q).slice(0, 160);
  const requestedCategory = firstValue(params.category);
  const category = getCatalogCategory(requestedCategory);
  const catalog = await loadMarketplaceCatalog({ query, category: category?.slug, limit: 100 });
  const facetCounts = new Map(catalog.categories.map((facet) => [facet.key, facet.count]));

  return (
    <div className="site-frame">
      <SiteHeader />
      <main className="marketplace-shell shell">
        <ExploreRail active="skills" />
        <div className="marketplace-main">
          <header className="marketplace-hero marketplace-hero--skills">
            <div>
              <Badge tone="success"><CircleCheck aria-hidden="true" size={12} /> Eligibility filtered</Badge>
              <h1>Choose the exact skills you want.</h1>
              <p>
                Search public upstream records, compare trust and provenance, and keep a multi-skill stack without turning URLs into executable instructions.
              </p>
            </div>
            <dl className="marketplace-hero__ledger">
              <div><dt>Visible records</dt><dd>{catalog.skills.length}</dd></div>
              <div><dt>Connected sources</dt><dd>{catalog.connectedSources || "—"}</dd></div>
              <div><dt>Selection limit</dt><dd>64</dd></div>
            </dl>
          </header>

          <div className="catalog-contract-strip">
            <span><GitBranch aria-hidden="true" size={15} /> Public source required</span>
            <span><DatabaseZap aria-hidden="true" size={15} /> Canonical ID selected</span>
            <span><Layers3 aria-hidden="true" size={15} /> Revalidated before install</span>
          </div>

          <nav aria-label="Filter skills by category" className="category-filter-rail">
            <Link aria-current={!category ? "page" : undefined} href="/skills">All skills</Link>
            {catalogCategories.map((item) => {
              const count = facetCounts.get(item.slug);
              return (
                <Link
                  aria-current={category?.slug === item.slug ? "page" : undefined}
                  href={`/skills?category=${item.slug}`}
                  key={item.slug}
                >
                  {item.shortName}{count === undefined ? null : <span>{count}</span>}
                </Link>
              );
            })}
          </nav>

          {category ? (
            <div className="active-category-note">
              <span>Viewing</span>
              <strong>{category.name}</strong>
              <p>{category.description}</p>
              <Link href={`/categories/${category.slug}`}>Category overview</Link>
            </div>
          ) : null}

          <SkillsExplorer
            availability={catalog.availability}
            category={category?.slug}
            initialQuery={query}
            skills={catalog.skills}
          />
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
