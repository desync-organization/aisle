import { ArrowRight, Boxes, GitBranch, Layers3, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { ExploreRail } from "@/components/marketplace/explore-rail";
import { PackageGrid } from "@/components/marketplace/package-grid";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { loadResolvedPackage } from "@/lib/marketplace/catalog";
import { launchPackageBlueprints } from "@/lib/packages";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Packages",
  description: "Curated workflows composed from real public Agent Skills, with every upstream source kept visible.",
  path: "/packages",
});

export const dynamic = "force-dynamic";

export default async function PackagesPage() {
  const packageStates = await Promise.all(
    launchPackageBlueprints.map(async (blueprint) => ({
      blueprint,
      state: await loadResolvedPackage(blueprint),
    })),
  );
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
              <Badge tone="iris"><Sparkles aria-hidden="true" size={12} /> Editorial collections</Badge>
              <h1>Start with a complete workflow.</h1>
              <p>
                Packages group complementary public upstream skills around an outcome. Aisle adds the curation layer—not replacement content or hidden forks.
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
                <h2 id="featured-packages">Built to get a real job done.</h2>
              </div>
              <p>Each manifest is reviewed as a whole so the tools reinforce one another instead of becoming a random bookmark folder.</p>
            </div>
            <PackageGrid packages={featured} priorityCount={2} />
          </section>

          <section aria-labelledby="all-packages" className="market-section market-section--rule">
            <div className="market-section__heading">
              <div>
                <span>02 / Full collection</span>
                <h2 id="all-packages">Every published package. Every source visible.</h2>
              </div>
              <p>Open any package to inspect every exact skill path, observed revision, license, and editorial reason for inclusion.</p>
            </div>
            <PackageGrid packages={publishedPackages} />
          </section>

          <section className="package-method">
            <div className="package-method__icon"><Boxes aria-hidden="true" size={21} /></div>
            <div>
              <span>How package publishing works</span>
              <h2>Curation can propose. The catalog still has to prove.</h2>
            </div>
            <ol>
              <li><GitBranch aria-hidden="true" size={16} /><span><strong>Reference</strong>Real public upstream paths are recorded.</span></li>
              <li><Layers3 aria-hidden="true" size={16} /><span><strong>Resolve</strong>Every member binds to an eligible catalog revision.</span></li>
              <li><Sparkles aria-hidden="true" size={16} /><span><strong>Select</strong>The complete resolved set can join your stack.</span></li>
            </ol>
            <Link href="/docs/public-catalog-policy">Read the catalog policy <ArrowRight aria-hidden="true" size={15} /></Link>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
