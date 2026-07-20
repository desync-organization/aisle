import { ArrowLeft, ArrowRight, CheckCircle2 } from "lucide-react";
import type { Metadata } from "next";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Public catalog policy",
  description: "Aisle’s public-source, provenance, licensing, lifecycle, and trust commitments.",
  path: "/docs/public-catalog-policy",
});

const decisions = [
  {
    title: "Public upstream only",
    body: "Every installable record must resolve to an existing public Agent Skill and immutable upstream revision.",
  },
  {
    title: "References, never rewrites",
    body: "Aisle packages are ordered references. Aisle does not generate, synthesize, translate, or improve skill contents.",
  },
  {
    title: "Truthful coverage",
    body: "Coverage is reported per configured source and last successful sync, including gaps, lag, and discovery mode.",
  },
  {
    title: "Public is not safe",
    body: "Trust findings belong to an exact revision. Unreviewed stays visible but not selectable; Warning requires acknowledgement; Failed and Quarantined remain blocked.",
  },
  {
    title: "Licenses stay attached",
    body: "Public availability does not grant redistribution rights, so installation resolves from the original source.",
  },
] as const;

export default function PublicCatalogPolicyPage() {
  return (
    <div className="site-frame">
      <SiteHeader />
      <main className="policy-page shell">
        <div className="policy-page__intro">
          <Badge tone="iris">Architecture decision · Accepted</Badge>
          <h1>Public catalog policy</h1>
          <p>
            The short version of the invariant that governs discovery, curation, and installation across Aisle.
          </p>
        </div>
        <div className="policy-list">
          {decisions.map((decision, index) => (
            <article key={decision.title}>
              <span>0{index + 1}</span>
              <CheckCircle2 aria-hidden="true" size={18} />
              <div>
                <h2>{decision.title}</h2>
                <p>{decision.body}</p>
              </div>
            </article>
          ))}
        </div>
        <aside className="policy-page__coverage">
          <strong>A precise coverage promise</strong>
          <p>
            Aisle will report all eligible entries discoverable from each configured enumerable source at its displayed last-successful-sync time, plus clearly labeled federated or on-demand results. It will never claim to contain every skill on the internet.
          </p>
        </aside>
        <section aria-labelledby="attribution-heading" className="policy-attribution">
          <div>
            <span className="eyebrow">Source attribution</span>
            <h2 id="attribution-heading">Three kinds of context, never blended.</h2>
          </div>
          <div className="policy-attribution__grid">
            <article>
              <span>UPSTREAM</span>
              <h3>Publisher material</h3>
              <p>Name, description, files, revision, and license stay linked to the original public source.</p>
            </article>
            <article>
              <span>AISLE / EDITORIAL</span>
              <h3>Marketplace structure</h3>
              <p>Categories, package copy, ordering, and duplicate relationships are labeled as Aisle context.</p>
            </article>
            <article>
              <span>AISLE / FINDING</span>
              <h3>Revision review</h3>
              <p>Trust labels and scanner findings identify who produced them and the exact revision reviewed.</p>
            </article>
          </div>
        </section>
        <aside className="policy-license-note">
          <strong>Unknown means unknown.</strong>
          <p>
            A missing license is displayed as unknown, never inferred to be permissive. Public access alone does not grant redistribution rights or permission to modify upstream work.
          </p>
        </aside>
        <div className="policy-page__actions">
          <ButtonLink href="/docs" variant="secondary">
            <ArrowLeft aria-hidden="true" size={16} /> Back to documentation
          </ButtonLink>
          <ButtonLink href="/coverage">
            See the coverage contract <ArrowRight aria-hidden="true" size={16} />
          </ButtonLink>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
