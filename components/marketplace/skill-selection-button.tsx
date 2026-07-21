"use client";

import { Check, LockKeyhole, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { MarketplaceSkillSummary } from "@/lib/marketplace/catalog";
import { catalogSelectionGateCopy } from "@/lib/marketplace/selection-gates";
import { useSelection } from "@/lib/selection/react";

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
  const selected = state.ids.some((candidate) => candidate === id);
  const gateMessage = gateReasons.length > 0
    ? gateReasons.map((reason) => catalogSelectionGateCopy[reason]).join(" ")
    : "This record cannot be selected yet.";

  return (
    <Button
      aria-label={selected
        ? `Remove ${name} from your stack`
        : selectable
          ? `Add ${name} to your stack`
          : `${name} is not currently selectable`}
      aria-pressed={selected}
      disabled={!selected && !selectable}
      onClick={() => {
        if (selected || selectable) actions.toggle(id);
      }}
      title={!selected && !selectable ? gateMessage : undefined}
      variant={selected ? "secondary" : "primary"}
    >
      {selected
        ? <Check aria-hidden="true" size={16} />
        : selectable
          ? <Plus aria-hidden="true" size={16} />
          : <LockKeyhole aria-hidden="true" size={16} />}
      {selected ? "In your stack" : selectable ? "Add to stack" : "Not selectable"}
    </Button>
  );
}
