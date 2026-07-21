import {
  ArrowRight,
  Boxes,
  Fingerprint,
  GitFork,
  Layers3,
  ScanSearch,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import Link from "next/link";

import { AisleRail } from "@/components/aisle-rail";
import { CategoryIcon } from "@/components/marketplace/category-icon";
import { PackageGrid } from "@/components/marketplace/package-grid";
import { SkillShelf } from "@/components/marketplace/skill-shelf";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { marketplaceCategories } from "@/lib/marketplace/categories";
import { loadMarketplaceCatalog } from "@/lib/marketplace/catalog";
import { launchPackageBlueprints } from "@/lib/packages";

const principles = [
  {
    icon: ScanSearch,
    number: "01",
    title: "Trace before trust",
    body: "Every listing keeps its original source, revision, license, and review state attached.",
  },
  {
    icon: Boxes,
    number: "02",
    title: "Compose, don’t copy",
    body: "Packages remain references to public upstream work—never rewritten skills under a new label.",
  },
  {
    icon: Fingerprint,
    number: "03",
    title: "Select canonical IDs",
    body: "Your browser stores opaque catalog IDs. Install planning resolves and revalidates the source again.",
  },
] as const;

export default async function HomePage() {
  const catalog = await loadMarketplaceCatalog({ limit: 6 });
  const featuredPackages = launchPackageBlueprints.filter((blueprint) => blueprint.editorial.featured).slice(0, 4);

  return (
    <div className="site-frame">
      <SiteHeader />
      <main>
        <section className="hero shell">
          <div className="hero__copy">
            <Badge tone="iris">
              <span className="badge__pulse" /> Public skills · provenance preserved
            </Badge>
            <h1>
              Build your agent stack,
              <span>one aisle at a time.</span>
            </h1>
            <p className="hero__lede">
              Discover public Agent Skills, inspect the source and trust signals, then select a complete stack without losing where anything came from.
            </p>
            <div className="hero__actions">
              <ButtonLink href="/skills">
                Browse public skills <ArrowRight aria-hidden="true" size={17} />
              </ButtonLink>
              <ButtonLink href="/packages" variant="secondary">
                Explore packages
              </ButtonLink>
            </div>
            <div className="hero-proofline">
              <span><Sparkles aria-hidden="true" size={14} /> {launchPackageBlueprints.length} reviewed package manifests</span>
              <span><ShieldCheck aria-hidden="true" size={14} /> No Aisle-authored skills</span>
            </div>
          </div>
          <AisleRail />
        </section>

        <section aria-label="Aisle catalog guarantees" className="signal-strip">
          <div className="shell signal-strip__inner">
            <p><GitFork aria-hidden="true" size={16} /> Original source stays visible</p>
            <p><span>Exact</span> revision evidence</p>
            <p><span>Zero</span> house-made skills</p>
            <p><span>One</span> selected stack</p>
          </div>
        </section>

        <section aria-labelledby="featured-home-packages" className="home-market-section shell">
          <div className="market-section__heading">
            <div>
              <span>Featured packages / Public upstream</span>
              <h2 id="featured-home-packages">Skip the tab hunt. Start with a workflow.</h2>
            </div>
            <div className="market-heading-action">
              <p>Editorial packages connect complementary skills for frontend, motion, deployment, mobile, agents, and more.</p>
              <Link href="/packages">View all packages <ArrowRight aria-hidden="true" size={15} /></Link>
            </div>
          </div>
          <PackageGrid packages={featuredPackages} priorityCount={2} />
        </section>

        <section aria-labelledby="live-catalog-heading" className="home-market-section home-market-section--catalog shell">
          <div className="market-section__heading">
            <div>
              <span>Live catalog / Eligibility filtered</span>
              <h2 id="live-catalog-heading">Pick only what belongs in your stack.</h2>
            </div>
            <div className="market-heading-action">
              <p>These records come from the provisioned catalog, ordered by observed installs. Missing data stays visibly missing.</p>
              <Link href="/skills">Open explorer <ArrowRight aria-hidden="true" size={15} /></Link>
            </div>
          </div>
          <SkillShelf availability={catalog.availability} skills={catalog.skills} />
        </section>

        <section aria-labelledby="home-categories-heading" className="home-category-section">
          <div className="shell">
            <div className="market-section__heading">
              <div>
                <span>Browse by outcome</span>
                <h2 id="home-categories-heading">There is an aisle for the work.</h2>
              </div>
              <p>Move across domains without turning publisher names into the taxonomy.</p>
            </div>
            <div className="home-category-rail">
              {marketplaceCategories.map((category, index) => (
                <Link data-color={category.colorToken} href={`/categories/${category.slug}`} key={category.slug}>
                  <span className="home-category-rail__index">{String(index + 1).padStart(2, "0")}</span>
                  <span className="home-category-rail__icon"><CategoryIcon token={category.iconToken} /></span>
                  <strong>{category.shortName}</strong>
                  <ArrowRight aria-hidden="true" size={15} />
                </Link>
              ))}
            </div>
          </div>
        </section>

        <section aria-labelledby="principles-heading" className="principles shell">
          <div className="section-kicker">
            <span>THE AISLE STANDARD</span>
            <span>DISCOVERY / PROVENANCE / COMPOSITION</span>
          </div>
          <div className="principles__intro">
            <h2 id="principles-heading">A calmer way through a crowded ecosystem.</h2>
            <p>Aisle separates marketplace context from upstream content, so curation adds clarity without blurring ownership.</p>
          </div>
          <div className="principle-grid">
            {principles.map(({ body, icon: Icon, number, title }) => (
              <article className="principle-card" key={number}>
                <div className="principle-card__topline"><span>{number}</span><Icon aria-hidden="true" size={19} /></div>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="home-closing shell">
          <div className="home-closing__mark"><Layers3 aria-hidden="true" size={25} /></div>
          <div>
            <span>Ready when you are</span>
            <h2>Build a stack you can inspect.</h2>
            <p>Select individual public skills or begin with a curated workflow. Every choice keeps its source receipt.</p>
          </div>
          <ButtonLink href="/skills">Start selecting <ArrowRight aria-hidden="true" size={16} /></ButtonLink>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
