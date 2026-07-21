"use client";

import { Check, Layers3, LockKeyhole, Plus } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { useSelection } from "@/lib/selection/react";

export function PackageSelection({
  availability,
  memberCount,
  skillIds,
}: {
  availability: "resolved" | "pending" | "not-configured" | "unavailable";
  memberCount: number;
  skillIds: ReadonlyArray<string>;
}) {
  const { actions, meta, state } = useSelection();
  const [feedback, setFeedback] = useState("");
  const selected = useMemo(() => new Set<string>(state.ids), [state.ids]);
  const isComplete = availability === "resolved" && skillIds.length === memberCount;
  const allSelected = isComplete && skillIds.every((id) => selected.has(id));

  function togglePackage() {
    if (!isComplete) return;

    if (allSelected) {
      skillIds.forEach((id) => actions.remove(id));
      setFeedback(`${memberCount} package skills removed from your stack.`);
      return;
    }

    const result = actions.addMany(skillIds);
    setFeedback(
      result.ok
        ? `${memberCount} package skills added to your stack.`
        : `This package would exceed the ${meta.maxSelections}-skill stack limit. Remove a few skills and try again.`,
    );
  }

  if (!isComplete) {
    return (
      <div className="package-resolution package-resolution--pending">
        <LockKeyhole aria-hidden="true" size={18} />
        <div>
          <strong>Selection unlocks after catalog resolution</strong>
          <p>
            The editorial members are real public upstream skills, but Aisle will not create selection IDs until every exact revision passes its catalog gates.
          </p>
        </div>
        <Button aria-disabled="true" disabled variant="secondary">
          Add package
        </Button>
      </div>
    );
  }

  return (
    <div className="package-resolution package-resolution--ready">
      <Check aria-hidden="true" size={18} />
      <div>
        <strong>{memberCount} catalog-ready skills</strong>
        <p>Every package member resolved to an eligible canonical record at this revision.</p>
      </div>
      <Button aria-pressed={allSelected} onClick={togglePackage} variant={allSelected ? "secondary" : "primary"}>
        {allSelected ? <Check aria-hidden="true" size={16} /> : <Plus aria-hidden="true" size={16} />}
        {allSelected ? "In your stack" : `Add all ${memberCount}`}
      </Button>
      <span aria-live="polite" className="sr-only">{feedback}</span>
      <span className="package-resolution__count">
        <Layers3 aria-hidden="true" size={14} /> {state.count} selected
      </span>
    </div>
  );
}
