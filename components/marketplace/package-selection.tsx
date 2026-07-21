"use client";

import { Check, Layers3, LockKeyhole, Plus } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  packageBindingIssueCopy,
  type PackageBindingIssue,
  type PublishedPackageBinding,
} from "@/lib/marketplace/package-binding";
import { useSelection } from "@/lib/selection/react";

export function PackageSelection({
  availability,
  binding,
  expectedBlueprintDigest,
  expectedBlueprintSchemaVersion,
  memberCount,
  mismatchReasons,
  skillIds,
}: {
  availability: "resolved" | "pending" | "binding-mismatch" | "not-configured" | "unavailable";
  binding: PublishedPackageBinding | null;
  expectedBlueprintDigest: string;
  expectedBlueprintSchemaVersion: number;
  memberCount: number;
  mismatchReasons: ReadonlyArray<PackageBindingIssue>;
  skillIds: ReadonlyArray<string>;
}) {
  const { actions, meta, state } = useSelection();
  const [feedback, setFeedback] = useState("");
  const selected = useMemo(() => new Set<string>(state.ids), [state.ids]);
  const isComplete = availability === "resolved" &&
    binding !== null &&
    binding.version > 0 &&
    binding.blueprintSchemaVersion === expectedBlueprintSchemaVersion &&
    binding.blueprintDigest === expectedBlueprintDigest &&
    skillIds.length === memberCount &&
    new Set(skillIds).size === memberCount;
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

  if (availability === "binding-mismatch") {
    return (
      <div className="package-resolution package-resolution--mismatch">
        <LockKeyhole aria-hidden="true" size={18} />
        <div>
          <strong>Displayed blueprint does not match the published receipt</strong>
          <p>Add all is locked until the stored version, editorial payload, members, and revisions reproduce this exact digest.</p>
          <ul className="package-resolution__issues">
            {mismatchReasons.map((reason) => <li key={reason}>{packageBindingIssueCopy[reason]}</li>)}
          </ul>
          <dl className="package-resolution__receipt">
            <div><dt>Expected</dt><dd>{expectedBlueprintDigest}</dd></div>
            <div><dt>Published</dt><dd>{binding?.blueprintDigest || "Missing"}</dd></div>
          </dl>
        </div>
        <Button aria-disabled="true" disabled variant="secondary">Add package</Button>
      </div>
    );
  }

  if (!isComplete || !binding) {
    const pendingCopy = availability === "not-configured"
      ? "The catalog is not provisioned in this environment, so no package IDs are available."
      : availability === "unavailable"
        ? "The published package receipt could not be read. No selection IDs were substituted."
        : "The editorial package has not resolved to one complete, published, revision-bound version yet.";
    return (
      <div className="package-resolution package-resolution--pending">
        <LockKeyhole aria-hidden="true" size={18} />
        <div>
          <strong>Selection unlocks after catalog resolution</strong>
          <p>{pendingCopy}</p>
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
        <strong>{memberCount} exact skills · package v{binding.version}</strong>
        <p>Digest {binding.blueprintDigest} binds this editorial payload and every member locator to the displayed revision.</p>
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
