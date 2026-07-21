"use client";

import { Check, GitBranch, Plus, ShieldCheck, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { MarketplaceSkillSummary } from "@/lib/marketplace/catalog";
import { useSelection } from "@/lib/selection/react";

function sourceName(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl);
    const repository = url.pathname.split("/").filter(Boolean).slice(0, 2).join("/");
    return repository || url.hostname;
  } catch {
    return "Public upstream";
  }
}

function formatInstalls(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function SkillCard({ compact = false, skill }: { compact?: boolean; skill: MarketplaceSkillSummary }) {
  const { actions, meta, state } = useSelection();
  const [feedback, setFeedback] = useState("");
  const selected = state.ids.some((id) => id === skill.id);
  const source = sourceName(skill.sourceUrl);

  function toggle() {
    const result = actions.toggle(skill.id);
    if (!result.ok) {
      setFeedback(`Your stack can contain up to ${meta.maxSelections} skills. Remove one before adding another.`);
      return;
    }
    setFeedback(result.snapshot.ids.some((id) => id === skill.id) ? `${skill.name} added.` : `${skill.name} removed.`);
  }

  return (
    <article className={`skill-card${compact ? " skill-card--compact" : ""}${selected ? " skill-card--selected" : ""}`}>
      <div className="skill-card__topline">
        <span className={`trust-pill trust-pill--${skill.trustState}`}>
          {skill.trustState === "warn" ? <TriangleAlert aria-hidden="true" size={13} /> : <ShieldCheck aria-hidden="true" size={13} />}
          {skill.trustState === "pass" ? "Trust checked" : skill.trustState}
        </span>
        {skill.officialProvenance ? <span className="skill-card__official">Official source</span> : null}
      </div>
      <div className="skill-card__identity">
        <span className="skill-card__monogram" aria-hidden="true">{skill.name.slice(0, 2).toUpperCase()}</span>
        <div>
          <h3>{skill.name}</h3>
          <a href={skill.sourceUrl} rel="noreferrer" target="_blank">
            <GitBranch aria-hidden="true" size={13} /> {source}
          </a>
        </div>
      </div>
      <p className="skill-card__description">
        {skill.description || "The upstream publisher did not provide a catalog description."}
      </p>
      <dl className="skill-card__facts">
        <div><dt>License</dt><dd>{skill.license}</dd></div>
        <div><dt>Revision</dt><dd>{skill.immutableRef.slice(0, 8)}</dd></div>
        <div><dt>Observed installs</dt><dd>{formatInstalls(skill.installs)}</dd></div>
      </dl>
      <Button
        aria-label={selected ? `Remove ${skill.name} from your stack` : `Add ${skill.name} to your stack`}
        aria-pressed={selected}
        className="skill-card__select"
        onClick={toggle}
        variant={selected ? "secondary" : "primary"}
      >
        {selected ? <Check aria-hidden="true" size={15} /> : <Plus aria-hidden="true" size={15} />}
        {selected ? "Selected" : "Add to stack"}
      </Button>
      <span aria-live="polite" className="sr-only">{feedback}</span>
    </article>
  );
}
