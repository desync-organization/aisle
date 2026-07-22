import { FolderHeart, Link2, ShieldCheck, UserRound } from "lucide-react";
import type { Metadata } from "next";

import { CollectionCreator } from "@/components/marketplace/collection-creator";
import { ExploreRail } from "@/components/marketplace/explore-rail";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Collections",
  description: "Name a personal collection of public Agent Skills and share it with one permanent link.",
  path: "/collections",
});

export default function CollectionsPage() {
  return (
    <div className="site-frame">
      <SiteHeader />
      <main className="marketplace-shell shell">
        <ExploreRail active="collections" />
        <div className="marketplace-main collections-page">
          <header className="marketplace-hero collections-hero">
            <div>
              <Badge tone="iris"><FolderHeart aria-hidden="true" size={12} /> Community collections</Badge>
              <h1>Keep the stack. Share the thinking.</h1>
              <p>Select public skills, give the set a useful name, and create one permanent page anyone can open and add to their own stack.</p>
            </div>
            <dl className="marketplace-hero__ledger">
              <div><dt>Visibility</dt><dd>Public</dd></div>
              <div><dt>Share format</dt><dd>One link</dd></div>
              <div><dt>Ownership</dt><dd>Device → account</dd></div>
            </dl>
          </header>

          <section className="market-section collections-create-section">
            <div className="market-section__heading">
              <div>
                <span>01 / Create</span>
                <h2>Turn your current selection into a collection.</h2>
              </div>
              <p>The public page stores catalog skill references, not copied skill content. If a skill changes upstream, Aisle still rechecks it before installation.</p>
            </div>
            <CollectionCreator />
          </section>

          <section className="collection-future-auth" aria-labelledby="collection-ownership-heading">
            <div><ShieldCheck aria-hidden="true" size={20} /></div>
            <div>
              <span>Ownership boundary</span>
              <h2 id="collection-ownership-heading">Ready for accounts without rebuilding collections.</h2>
              <p>Anonymous ownership is represented by a private token held on this device. A future sign-in flow can attach the same database record and public URL to an account.</p>
            </div>
            <ol>
              <li><Link2 aria-hidden="true" size={16} /><span><strong>Now</strong>Public links work without sign-in.</span></li>
              <li><UserRound aria-hidden="true" size={16} /><span><strong>Later</strong>Claim, rename, and manage from an account.</span></li>
            </ol>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

