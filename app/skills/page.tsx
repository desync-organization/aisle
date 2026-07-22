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
  description: "Browse public Agent Skills and add any combination to your stack.",
  path: "/skills",
});

export const revalidate = 60;

type SkillsPageProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

function firstValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function catalogPage(value: string | string[] | undefined): number {
  const candidate = firstValue(value);
  if (!/^\d+$/.test(candidate)) return 1;
  return Math.min(Math.max(Number(candidate), 1), 2_000);
}

export default async function SkillsPage({ searchParams }: SkillsPageProps) {
  const params = await searchParams;
  const query = firstValue(params.q).slice(0, 160);
  const page = catalogPage(params.page);
  const includeUnavailable = firstValue(params.status) === "all";
  const requestedCategory = firstValue(params.category);
  const category = getCatalogCategory(requestedCategory);
  const catalog = await loadMarketplaceCatalog({
    query,
    category: category?.slug,
    includeUnavailable,
    page,
    pageSize: 48,
  });
  const facetCounts = new Map(catalog.categories.map((facet) => [facet.key, facet.count]));

  return (
    <div className="site-frame">
      <SiteHeader />
      <main className="marketplace-shell shell">
        <ExploreRail active="skills" />
        <div className="marketplace-main">
          <header className="marketplace-hero marketplace-hero--skills">
            <div>
              <Badge tone="success"><CircleCheck aria-hidden="true" size={12} /> Public skill catalog</Badge>
              <h1>Choose the exact skills you want.</h1>
              <p>
                Search by name, category, or publisher. Add any combination to your stack.
              </p>
            </div>
            <dl className="marketplace-hero__ledger">
              <div><dt>This page</dt><dd>{catalog.skills.length}</dd></div>
              <div><dt>Connected sources</dt><dd>{catalog.connectedSources || "—"}</dd></div>
              <div><dt>Selection limit</dt><dd>64</dd></div>
            </dl>
          </header>

          <div className="catalog-contract-strip">
            <span><GitBranch aria-hidden="true" size={15} /> Public source</span>
            <span><DatabaseZap aria-hidden="true" size={15} /> Checked before install</span>
            <span><Layers3 aria-hidden="true" size={15} /> Up to 64 skills</span>
          </div>

          <nav aria-label="Filter skills by category" className="category-filter-rail">
            <Link aria-current={!category ? "page" : undefined} href="/skills" prefetch={false}>All skills</Link>
            {catalogCategories.map((item) => {
              const count = facetCounts.get(item.slug);
              return (
                <Link
                  aria-current={category?.slug === item.slug ? "page" : undefined}
                  href={`/skills?category=${item.slug}`}
                  key={item.slug}
                  prefetch={false}
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
            includeUnavailable={includeUnavailable}
            initialQuery={query}
            key={`${category?.slug ?? "all"}:${query}:${includeUnavailable ? "all" : "ready"}`}
            pagination={catalog.pagination}
            skills={catalog.skills}
          />
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
