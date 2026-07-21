"use client";

import { Check, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useSelection } from "@/lib/selection/react";

export function SkillSelectionButton({ id, name }: { id: string; name: string }) {
  const { actions, state } = useSelection();
  const selected = state.ids.some((candidate) => candidate === id);

  return (
    <Button
      aria-label={selected ? `Remove ${name} from your stack` : `Add ${name} to your stack`}
      aria-pressed={selected}
      onClick={() => actions.toggle(id)}
      variant={selected ? "secondary" : "primary"}
    >
      {selected ? <Check aria-hidden="true" size={16} /> : <Plus aria-hidden="true" size={16} />}
      {selected ? "In your stack" : "Add to stack"}
    </Button>
  );
}
