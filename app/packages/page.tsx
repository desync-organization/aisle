import type { Metadata } from "next";

import { RoutePlaceholder } from "@/components/route-placeholder";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Packages",
  description: "Curated references to complementary public Agent Skills.",
  path: "/packages",
});

export default function PackagesPage() {
  return (
    <RoutePlaceholder
      description="Curated groups will bring complementary public skills together without copying or rewriting their contents."
      eyebrow="Packages"
      title="Complete workflows, assembled with receipts."
    />
  );
}
