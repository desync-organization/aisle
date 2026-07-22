"use client";

import { Check, Clock3, LockKeyhole, Plus, RefreshCw, TriangleAlert } from "lucide-react";
import { useId } from "react";

import { Button } from "@/components/ui/button";
import type { MarketplaceSkillSummary } from "@/lib/marketplace/catalog";
import {
  catalogSelectionGateCopy,
  catalogSelectionGateStatus,
  type CatalogSelectionGateStatus,
} from "@/lib/marketplace/selection-gates";
import { useSelection } from "@/lib/selection/react";

function GateStatusIcon({ kind }: { kind: CatalogSelectionGateStatus["kind"] }) {
  if (kind === "trust-blocked") return <LockKeyhole aria-hidden="true" size={16} />;
  if (kind === "needs-review") return <TriangleAlert aria-hidden="true" size={16} />;
  if (kind === "verification-pending") return <Clock3 aria-hidden="true" size={16} />;
  return <RefreshCw aria-hidden="true" size={16} />;
}

export function SkillSelectionButton({
  gateReasons,
  id,
  name,
  selectable,
}: {
  gateReasons: MarketplaceSkillSummary["gateReasons"];
  id: string;
  name: string;
  selectable: boolean;
}) {
  const { actions, state } = useSelection();
  const gateDescriptionId = useId();
  const selected = state.ids.some((candidate) => candidate === id);
  const gateStatus = catalogSelectionGateStatus(gateReasons);
  const gateActive = !selected && !selectable;
  const gateMessage = gateReasons.length > 0
    ? gateReasons.map((reason) => catalogSelectionGateCopy[reason]).join(" ")
    : "This record cannot be selected yet.";

  return (
    <>
      <Button
        aria-label={selected
          ? `Remove ${name} from your stack`
          : selectable
            ? `Add ${name} to your stack`
            : `${name}: ${gateStatus.label}`}
        aria-describedby={gateActive ? gateDescriptionId : undefined}
        aria-disabled={gateActive || undefined}
        aria-pressed={selected}
        className="skill-selection-button"
        data-gate-status={gateActive ? gateStatus.kind : undefined}
        onClick={() => {
          if (selected || selectable) actions.toggle(id);
        }}
        variant={selected ? "secondary" : "primary"}
      >
        {selected
          ? <Check aria-hidden="true" size={16} />
          : selectable
            ? <Plus aria-hidden="true" size={16} />
            : <GateStatusIcon kind={gateStatus.kind} />}
        {selected ? "In your stack" : selectable ? "Add to stack" : gateStatus.label}
      </Button>
      {gateActive ? (
        <span className="sr-only" id={gateDescriptionId}>{gateStatus.label}. {gateMessage}</span>
      ) : null}
    </>
  );
}
