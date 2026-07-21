"use client";

import { ArrowRight, CircleDashed } from "lucide-react";
import Link from "next/link";

import { SkillCard } from "@/components/marketplace/skill-card";
import type { CatalogAvailability, MarketplaceSkillSummary } from "@/lib/marketplace/catalog";

export function SkillShelf({
  availability,
  skills,
}: {
  availability: CatalogAvailability;
  skills: ReadonlyArray<MarketplaceSkillSummary>;
}) {
  if (skills.length === 0) {
    return (
      <div className="home-catalog-empty">
        <CircleDashed aria-hidden="true" size={25} />
        <div>
          <strong>{availability === "unavailable" ? "Catalog temporarily unavailable" : "No eligible catalog records yet"}</strong>
          <p>Public sources can be curated here only after their revisions and trust state resolve. Aisle does not ship placeholder skills.</p>
        </div>
        <Link href="/coverage">View coverage <ArrowRight aria-hidden="true" size={15} /></Link>
      </div>
    );
  }

  return (
    <div className="home-skill-grid">
      {skills.map((skill) => <SkillCard compact key={skill.id} skill={skill} />)}
    </div>
  );
}
