import type { Metadata } from "next";

import { RoutePlaceholder } from "@/components/route-placeholder";

export const metadata: Metadata = {
  title: "Skills",
  description: "Browse public Agent Skills with clear upstream provenance.",
};

export default function SkillsPage() {
  return (
    <RoutePlaceholder
      description="Search and multi-select will appear here after every result can be resolved to a real public upstream revision."
      eyebrow="Skills"
      title="Pick capabilities without losing the source."
    />
  );
}
