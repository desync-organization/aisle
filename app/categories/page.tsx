import type { Metadata } from "next";

import { RoutePlaceholder } from "@/components/route-placeholder";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Categories",
  description: "Explore public Agent Skills by the work they help accomplish.",
  path: "/categories",
});

export default function CategoriesPage() {
  return (
    <RoutePlaceholder
      description="A stable taxonomy will make broad discovery useful while preserving each skill’s original identity."
      eyebrow="Categories"
      title="Start with the job, then inspect the tools."
    />
  );
}
