import { ArrowRight, Boxes, Fingerprint, GitFork, ScanSearch } from "lucide-react";

import { AisleRail } from "@/components/aisle-rail";
import { CatalogPlaceholder } from "@/components/catalog-placeholder";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { CommandBlock } from "@/components/ui/command-block";

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
    title: "Install what you chose",
    body: "The final manifest pins exact revisions so one command still shows its receipts.",
  },
] as const;

export default function HomePage() {
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
              Discover existing Agent Skills, compare their source and trust signals, then bring your entire selection onboard with one command.
            </p>
            <div className="hero__actions">
              <ButtonLink href="/skills">
                Browse public skills <ArrowRight aria-hidden="true" size={17} />
              </ButtonLink>
              <ButtonLink href="/packages" variant="secondary">
                Explore packages
              </ButtonLink>
            </div>
            <CommandBlock command="npx --yes @useaisle/cli@1 install <selection-id>" />
          </div>
          <AisleRail />
        </section>

        <section aria-label="Aisle catalog guarantees" className="signal-strip">
          <div className="shell signal-strip__inner">
            <p>
              <GitFork aria-hidden="true" size={16} /> Original source stays visible
            </p>
            <p><span>Immutable</span> revision manifests</p>
            <p><span>Zero</span> house-made skills</p>
            <p><span>One</span> composed install</p>
          </div>
        </section>

        <section aria-labelledby="principles-heading" className="principles shell">
          <div className="section-kicker">
            <span>THE AISLE STANDARD</span>
            <span>DISCOVERY / PROVENANCE / COMPOSITION</span>
          </div>
          <div className="principles__intro">
            <h2 id="principles-heading">A calmer way through a crowded ecosystem.</h2>
            <p>
              Aisle separates marketplace context from upstream content, so curation adds clarity without blurring ownership.
            </p>
          </div>
          <div className="principle-grid">
            {principles.map(({ body, icon: Icon, number, title }) => (
              <article className="principle-card" key={number}>
                <div className="principle-card__topline">
                  <span>{number}</span>
                  <Icon aria-hidden="true" size={19} />
                </div>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <CatalogPlaceholder />
      </main>
      <SiteFooter />
    </div>
  );
}
