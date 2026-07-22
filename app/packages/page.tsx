import { ArrowRight, Boxes, GitBranch, Layers3, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { ExploreRail } from "@/components/marketplace/explore-rail";
import { PackageGrid } from "@/components/marketplace/package-grid";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { loadResolvedPackages } from "@/lib/marketplace/catalog";
import { launchPackageBlueprints } from "@/lib/packages";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Packages",
  description: "Browse ready-made sets of public Agent Skills and add a complete set to your stack.",
  path: "/packages",
});

export const revalidate = 300;

export default async function PackagesPage() {
  const resolvedPackages = await loadResolvedPackages(launchPackageBlueprints);
  const packageStates = launchPackageBlueprints.map((blueprint, index) => ({
    blueprint,
    state: resolvedPackages[index]!,
  }));
  const publishedPackages = packageStates
    .filter(({ state }) => state.binding !== null)
    .map(({ blueprint }) => blueprint);
  const featured = publishedPackages.filter((blueprint) => blueprint.editorial.featured);
  const totalMembers = publishedPackages.reduce((total, blueprint) => total + blueprint.members.length, 0);

  return (
    <div className="site-frame">
      <SiteHeader />
      <main className="marketplace-shell shell">
        <ExploreRail active="packages" />
        <div className="marketplace-main">
          <header className="marketplace-hero marketplace-hero--packages">
            <div>
              <Badge tone="iris"><Sparkles aria-hidden="true" size={12} /> Ready-made sets</Badge>
              <h1>Start with a package.</h1>
              <p>
                Each package groups public skills for one kind of work. Review the list, then add everything to your stack.
              </p>
            </div>
            <dl className="marketplace-hero__ledger">
              <div><dt>Published packages</dt><dd>{publishedPackages.length}</dd></div>
              <div><dt>Featured workflows</dt><dd>{featured.length}</dd></div>
              <div><dt>Upstream references</dt><dd>{totalMembers}</dd></div>
            </dl>
          </header>

          <section aria-labelledby="featured-packages" className="market-section">
            <div className="market-section__heading">
              <div>
                <span>01 / Featured</span>
                <h2 id="featured-packages">Popular packages</h2>
              </div>
              <p>Pick a set and adjust it later.</p>
            </div>
            <PackageGrid packages={featured} priorityCount={2} />
          </section>

          <section aria-labelledby="all-packages" className="market-section market-section--rule">
            <div className="market-section__heading">
              <div>
                <span>02 / Full collection</span>
                <h2 id="all-packages">All packages</h2>
              </div>
              <p>Open any package to see every included skill and its original source.</p>
            </div>
            <PackageGrid packages={publishedPackages} />
          </section>

          <section className="package-method">
            <div className="package-method__icon"><Boxes aria-hidden="true" size={21} /></div>
            <div>
              <span>How packages work</span>
              <h2>Choose a set, check the skills, and add them together.</h2>
            </div>
            <ol>
              <li><GitBranch aria-hidden="true" size={16} /><span><strong>Source</strong>We link to the original public skills.</span></li>
              <li><Layers3 aria-hidden="true" size={16} /><span><strong>Check</strong>We confirm each skill is still available.</span></li>
              <li><Sparkles aria-hidden="true" size={16} /><span><strong>Add</strong>Add the full set to your stack.</span></li>
            </ol>
            <Link href="/docs/public-catalog-policy">Read the catalog policy <ArrowRight aria-hidden="true" size={15} /></Link>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
