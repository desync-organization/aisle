import { ArrowLeft, ArrowRight, CheckCircle2 } from "lucide-react";
import type { Metadata } from "next";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Public catalog policy",
  description: "The rules Aisle follows when it lists and installs public skills.",
  path: "/docs/public-catalog-policy",
});

const decisions = [
  {
    title: "A public source is required",
    body: "Every installable skill must link to an existing public Agent Skill at an immutable revision.",
  },
  {
    title: "Aisle does not rewrite skills",
    body: "Packages contain ordered links to public skills. Aisle does not generate, synthesize, translate, copy, or change their contents.",
  },
  {
    title: "Coverage is reported by source",
    body: "Each configured source shows its last successful sync, gaps, lag, and discovery mode.",
  },
  {
    title: "Public does not mean safe",
    body: "Trust findings belong to an exact revision. Unreviewed stays visible but not selectable; Warning requires acknowledgement; Failed and Quarantined remain blocked.",
  },
  {
    title: "The original license stays attached",
    body: "Public availability does not grant redistribution rights, so installation resolves from the original source.",
  },
] as const;

export default function PublicCatalogPolicyPage() {
  return (
    <div className="site-frame">
      <SiteHeader />
      <main className="policy-page shell">
        <div className="policy-page__intro">
          <Badge tone="iris">Policy · Public catalog</Badge>
          <h1>Public catalog policy</h1>
          <p>
            The rules Aisle follows when it finds, lists, and installs public skills.
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
          <strong>Coverage limits</strong>
          <p>
            Aisle reports entries found in each configured source and separates unresolved, blocked, and installable records. Federated and on-demand results are labeled separately. Aisle does not claim to contain every skill on the internet.
          </p>
        </aside>
        <section aria-labelledby="attribution-heading" className="policy-attribution">
          <div>
            <span className="eyebrow">Source attribution</span>
            <h2 id="attribution-heading">Where catalog information comes from</h2>
          </div>
          <div className="policy-attribution__grid">
            <article>
              <span>FROM THE PUBLISHER</span>
              <h3>Publisher material</h3>
              <p>Name, description, files, revision, and license stay linked to the original public source.</p>
            </article>
            <article>
              <span>FROM AISLE</span>
              <h3>Marketplace structure</h3>
              <p>Categories, package copy, ordering, and duplicate relationships are labeled as Aisle context.</p>
            </article>
            <article>
              <span>FROM AISLE REVIEW</span>
              <h3>Revision review</h3>
              <p>Trust labels and scanner findings identify who produced them and the exact revision reviewed.</p>
            </article>
          </div>
        </section>
        <aside className="policy-license-note">
          <strong>A missing license stays unknown.</strong>
          <p>
            A missing license is displayed as unknown, never inferred to be permissive. Public access alone does not grant redistribution rights or permission to modify upstream work.
          </p>
        </aside>
        <div className="policy-page__actions">
          <ButtonLink href="/docs" variant="secondary">
            <ArrowLeft aria-hidden="true" size={16} /> Back to documentation
          </ButtonLink>
          <ButtonLink href="/coverage">
            See coverage details <ArrowRight aria-hidden="true" size={16} />
          </ButtonLink>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
