import { GitBranch, Layers3, LockKeyhole, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";

import { StackBuilder } from "@/components/marketplace/stack-builder";
import { CollectionCreator } from "@/components/marketplace/collection-creator";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Your stack",
  description: "Review selected public Agent Skills and request one server-validated install command.",
  path: "/stack",
});

export default function StackPage() {
  return (
    <div className="site-frame">
      <SiteHeader />
      <main className="stack-page shell">
        <header className="stack-page__hero">
          <div>
            <Badge tone="iris"><Layers3 aria-hidden="true" size={12} /> Device-local selection</Badge>
            <h1>Review the whole stack before one command.</h1>
            <p>Choose your agents and install shape. Aisle sends only canonical selection IDs to the server, then refuses a command unless every skill resolves again.</p>
          </div>
          <div className="stack-page__flow" aria-label="Stack resolution flow">
            <span><Layers3 aria-hidden="true" size={16} /> Selected IDs</span>
            <i />
            <span><ShieldCheck aria-hidden="true" size={16} /> Server preflight</span>
            <i />
            <span><GitBranch aria-hidden="true" size={16} /> Scoped sources</span>
            <i />
            <span><LockKeyhole aria-hidden="true" size={16} /> One command</span>
          </div>
        </header>
        <StackBuilder />
        <CollectionCreator compact />
      </main>
      <SiteFooter />
    </div>
  );
}
