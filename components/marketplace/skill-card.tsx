"use client";

import { Check, GitBranch, LockKeyhole, Plus, ShieldCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { MarketplaceSkillSummary } from "@/lib/marketplace/catalog";
import { catalogSelectionGateCopy } from "@/lib/marketplace/selection-gates";
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
  const gateMessage = skill.gateReasons.length > 0
    ? skill.gateReasons.map((reason) => catalogSelectionGateCopy[reason]).join(" ")
    : "This record cannot be selected yet.";

  function toggle() {
    if (!selected && !skill.selectable) {
      setFeedback(gateMessage);
      return;
    }
    const result = actions.toggle(skill.id);
    if (!result.ok) {
      setFeedback(`Your stack can contain up to ${meta.maxSelections} skills. Remove one before adding another.`);
      return;
    }
    setFeedback(result.snapshot.ids.some((id) => id === skill.id) ? `${skill.name} added.` : `${skill.name} removed.`);
  }

  return (
    <article className={`skill-card${compact ? " skill-card--compact" : ""}${selected ? " skill-card--selected" : ""}${skill.selectable ? "" : " skill-card--gated"}`}>
      <div className="skill-card__topline">
        <span className={`trust-pill trust-pill--${skill.trustState}`}>
          {skill.trustState === "pass" ? <ShieldCheck aria-hidden="true" size={13} /> : <TriangleAlert aria-hidden="true" size={13} />}
          {skill.trustState === "pass"
            ? "Trust checked"
            : skill.trustState === "blocked"
              ? "Trust blocked"
              : skill.trustState === "unreviewed"
                ? "Review pending"
                : "Review warning"}
        </span>
        {skill.officialProvenance ? <span className="skill-card__official">Official source</span> : null}
      </div>
      <div className="skill-card__identity">
        <span className="skill-card__monogram" aria-hidden="true">{skill.name.slice(0, 2).toUpperCase()}</span>
        <div>
          <h3><Link href={`/skills/${encodeURIComponent(skill.id)}`}>{skill.name}</Link></h3>
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
        <div><dt>Revision</dt><dd>{skill.immutableRef?.slice(0, 8) || "Pending"}</dd></div>
        <div><dt>Observed installs</dt><dd>{formatInstalls(skill.installs)}</dd></div>
      </dl>
      <Button
        aria-label={selected
          ? `Remove ${skill.name} from your stack`
          : skill.selectable
            ? `Add ${skill.name} to your stack`
            : `${skill.name} is not currently selectable`}
        aria-pressed={selected}
        className="skill-card__select"
        disabled={!selected && !skill.selectable}
        onClick={toggle}
        title={!selected && !skill.selectable ? gateMessage : undefined}
        variant={selected ? "secondary" : "primary"}
      >
        {selected
          ? <Check aria-hidden="true" size={15} />
          : skill.selectable
            ? <Plus aria-hidden="true" size={15} />
            : <LockKeyhole aria-hidden="true" size={15} />}
        {selected ? "Selected" : skill.selectable ? "Add to stack" : "Not selectable"}
      </Button>
      {!skill.selectable ? <p className="skill-card__gate">{gateMessage}</p> : null}
      <span aria-live="polite" className="sr-only">{feedback}</span>
    </article>
  );
}
