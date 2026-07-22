import { ArrowRight, Check, Search } from "lucide-react";
import Link from "next/link";

import { CategoryIcon } from "@/components/marketplace/category-icon";
import { PackageGrid } from "@/components/marketplace/package-grid";
import { SkillShelf } from "@/components/marketplace/skill-shelf";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { catalogCategories } from "@/lib/marketplace/categories";
import { loadMarketplaceCatalog, loadResolvedPackage } from "@/lib/marketplace/catalog";
import { launchPackageBlueprints } from "@/lib/packages";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [catalog, packageStates] = await Promise.all([
    loadMarketplaceCatalog({ limit: 8 }),
    Promise.all(
      launchPackageBlueprints.map(async (blueprint) => ({
        blueprint,
        state: await loadResolvedPackage(blueprint),
      })),
    ),
  ]);
  const publishedPackages = packageStates
    .filter(({ state }) => state.availability === "resolved")
    .map(({ blueprint }) => blueprint);
  const featuredPackages = publishedPackages
    .filter((blueprint) => blueprint.editorial.featured)
    .slice(0, 4);

  return (
    <div className="site-frame monochrome-home">
      <SiteHeader />
      <main>
        <section className="directory-hero shell">
          <div className="directory-hero__masthead">
            <div>
              <div aria-label="Aisle" className="directory-wordmark">AISLE</div>
              <p>THE PUBLIC AGENT SKILLS MARKETPLACE</p>
            </div>
            <div className="directory-hero__intro">
              <p>
                Discover public Agent Skills, combine exactly what you need,
                and install the complete stack with one reviewed command.
              </p>
              <div>
                <Link href="/skills">Browse skills <ArrowRight aria-hidden="true" size={15} /></Link>
                <Link href="/packages">View packages</Link>
              </div>
            </div>
          </div>

          <div className="directory-hero__utility">
            <div className="install-demo">
              <span>TRY IT NOW</span>
              <Link href="/stack">
                <code><b>$</b> npx skills add &lt;owner/repo&gt; --skill &lt;name&gt;</code>
                <ArrowRight aria-hidden="true" size={15} />
              </Link>
            </div>
            <dl className="directory-stats">
              <div><dt>Connected sources</dt><dd>{catalog.connectedSources || "—"}</dd></div>
              <div><dt>Published packages</dt><dd>{publishedPackages.length}</dd></div>
              <div><dt>Aisle-authored skills</dt><dd>0</dd></div>
            </dl>
          </div>
        </section>

        <section className="home-directory">
          <div className="shell">
            <header className="directory-titlebar">
              <h1>Marketplace</h1>
              <nav aria-label="Marketplace views">
                <Link aria-current="page" href="/">Featured</Link>
                <Link href="/packages">Packages</Link>
                <Link href="/skills">All skills</Link>
              </nav>
            </header>

            <div className="directory-layout">
              <aside className="directory-sidebar">
                <div className="directory-sidebar__group">
                  <span>Browse</span>
                  <Link aria-current="page" href="/"><Check aria-hidden="true" size={14} /> Featured</Link>
                  <Link href="/packages">Packages</Link>
                  <Link href="/skills">All skills</Link>
                  <Link href="/coverage">Source coverage</Link>
                </div>
                <div className="directory-sidebar__group">
                  <span>Categories</span>
                  {catalogCategories.slice(0, 10).map((category) => (
                    <Link href={`/categories/${category.slug}`} key={category.slug}>
                      <CategoryIcon size={14} token={category.iconToken} />
                      {category.shortName}
                    </Link>
                  ))}
                  <Link className="directory-sidebar__more" href="/categories">All categories →</Link>
                </div>
              </aside>

              <div className="directory-content">
                <Link className="directory-search" href="/skills">
                  <Search aria-hidden="true" size={17} />
                  <span>Search skills and public sources…</span>
                  <kbd>/</kbd>
                </Link>

                <section aria-labelledby="featured-packages-home" className="directory-section">
                  <div className="directory-section__heading">
                    <div>
                      <h2 id="featured-packages-home">Featured packages</h2>
                      <p>Curated groups of compatible public skills.</p>
                    </div>
                    <Link href="/packages">View all <ArrowRight aria-hidden="true" size={14} /></Link>
                  </div>
                  <PackageGrid packages={featuredPackages} />
                </section>

                <section aria-labelledby="popular-skills-home" className="directory-section directory-section--skills">
                  <div className="directory-section__heading">
                    <div>
                      <h2 id="popular-skills-home">Skills index</h2>
                      <p>Public records ordered by observed installs.</p>
                    </div>
                    <Link href="/skills">Open explorer <ArrowRight aria-hidden="true" size={14} /></Link>
                  </div>
                  <SkillShelf availability={catalog.availability} skills={catalog.skills} />
                </section>
              </div>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
