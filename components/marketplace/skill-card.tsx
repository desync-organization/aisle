"use client";

import {
  Check,
  Clock3,
  GitBranch,
  LockKeyhole,
  Plus,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import type { MarketplaceSkillSummary } from "@/lib/marketplace/catalog";
import {
  catalogSelectionGateCopy,
  catalogSelectionGateStatus,
  type CatalogSelectionGateStatus,
} from "@/lib/marketplace/selection-gates";
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

function GateStatusIcon({ kind }: { kind: CatalogSelectionGateStatus["kind"] }) {
  if (kind === "trust-blocked") return <LockKeyhole aria-hidden="true" size={15} />;
  if (kind === "needs-review") return <TriangleAlert aria-hidden="true" size={15} />;
  if (kind === "verification-pending") return <Clock3 aria-hidden="true" size={15} />;
  return <RefreshCw aria-hidden="true" size={15} />;
}

export function SkillCard({ compact = false, skill }: { compact?: boolean; skill: MarketplaceSkillSummary }) {
  const { actions, meta, state } = useSelection();
  const gateDescriptionId = useId();
  const [feedback, setFeedback] = useState("");
  const selected = state.ids.some((id) => id === skill.id);
  const source = sourceName(skill.sourceUrl);
  const gateStatus = catalogSelectionGateStatus(skill.gateReasons);
  const gateActive = !selected && !skill.selectable;
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
    <article
      className={`skill-card${compact ? " skill-card--compact" : ""}${selected ? " skill-card--selected" : ""}${skill.selectable ? "" : " skill-card--gated"}`}
      data-gate-status={skill.selectable ? undefined : gateStatus.kind}
    >
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
        <div><dt>Observed installs</dt><dd>{formatInstalls(skill.installs)}</dd></div>
      </dl>
      <Button
        aria-label={selected
          ? `Remove ${skill.name} from your stack`
          : skill.selectable
            ? `Add ${skill.name} to your stack`
            : `${skill.name}: ${gateStatus.label}`}
        aria-describedby={gateActive ? gateDescriptionId : undefined}
        aria-disabled={gateActive || undefined}
        aria-pressed={selected}
        className="skill-card__select"
        data-gate-status={gateActive ? gateStatus.kind : undefined}
        onClick={toggle}
        variant={selected ? "secondary" : "primary"}
      >
        {selected
          ? <Check aria-hidden="true" size={15} />
          : skill.selectable
            ? <Plus aria-hidden="true" size={15} />
            : <GateStatusIcon kind={gateStatus.kind} />}
        {selected ? "Selected" : skill.selectable ? "Add to stack" : gateStatus.label}
      </Button>
      {!skill.selectable ? (
        <>
          <span className="sr-only" id={gateDescriptionId}>{gateStatus.label}. {gateMessage}</span>
          <p aria-hidden="true" className="skill-card__gate">{gateMessage}</p>
        </>
      ) : null}
      <span aria-live="polite" className="sr-only">{feedback}</span>
    </article>
  );
}
