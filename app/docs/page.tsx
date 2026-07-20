import { ArrowUpRight, BookOpenCheck, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";

import { RoutePlaceholder } from "@/components/route-placeholder";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Documentation",
  description: "How Aisle discovers, presents, and installs public Agent Skills.",
  path: "/docs",
});

export default function DocsPage() {
  return (
    <RoutePlaceholder
      description="The marketplace is being built around explicit coverage, provenance, licensing, and trust boundaries."
      eyebrow="Documentation"
      title="Know exactly what the marketplace promises."
    >
      <div className="doc-links">
        <a href="/docs/public-catalog-policy">
          <ShieldCheck aria-hidden="true" size={18} />
          <span>
            <strong>Public catalog policy</strong>
            <small>Coverage, provenance, licensing, lifecycle, and quarantine</small>
          </span>
          <ArrowUpRight aria-hidden="true" size={16} />
        </a>
        <a href="https://agentskills.io/specification" rel="noreferrer" target="_blank">
          <BookOpenCheck aria-hidden="true" size={18} />
          <span>
            <strong>Agent Skills specification</strong>
            <small>The upstream format Aisle validates</small>
          </span>
          <ArrowUpRight aria-hidden="true" size={16} />
        </a>
      </div>
    </RoutePlaceholder>
  );
}
