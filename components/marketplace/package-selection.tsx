"use client";

import { Check, Layers3, LockKeyhole, Plus } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  packageBindingIssueCopy,
  type PackageBindingIssue,
  type PublishedPackageBinding,
  type PublishedPackageMemberBinding,
} from "@/lib/marketplace/package-binding";
import { useSelection } from "@/lib/selection/react";
import {
  canonicalizePackageSelectionAssertions,
  type PackageSelectionAssertion,
} from "@/lib/selection/contracts";

export function PackageSelection({
  availability,
  binding,
  expectedBlueprintDigest,
  expectedBlueprintSchemaVersion,
  memberCount,
  members,
  mismatchReasons,
  packageSlug,
}: {
  availability: "resolved" | "pending" | "binding-mismatch" | "not-configured" | "unavailable";
  binding: PublishedPackageBinding | null;
  expectedBlueprintDigest: string;
  expectedBlueprintSchemaVersion: number;
  memberCount: number;
  members: ReadonlyArray<PublishedPackageMemberBinding>;
  mismatchReasons: ReadonlyArray<PackageBindingIssue>;
  packageSlug: string;
}) {
  const { actions, meta, state } = useSelection();
  const [feedback, setFeedback] = useState("");
  const selected = useMemo(() => new Set<string>(state.ids), [state.ids]);
  const skillIds = useMemo(() => members.map((member) => member.skillId), [members]);
  const isComplete = availability === "resolved" &&
    binding !== null &&
    binding.version > 0 &&
    binding.blueprintSchemaVersion === expectedBlueprintSchemaVersion &&
    binding.blueprintDigest === expectedBlueprintDigest &&
    skillIds.length === memberCount &&
    new Set(skillIds).size === memberCount &&
    new Set(members.map((member) => member.revisionId)).size === memberCount;
  const assertion: PackageSelectionAssertion | null = isComplete && binding
    ? {
        packageSlug,
        packageVersion: binding.version,
        blueprintDigest: binding.blueprintDigest,
        members: members.map((member) => ({
          selectionId: member.skillId as PackageSelectionAssertion["members"][number]["selectionId"],
          revisionId: member.revisionId,
        })),
      }
    : null;
  const activeAssertion = state.packageAssertions.find(
    (candidate) => candidate.packageSlug === packageSlug,
  );
  const assertionMatches = assertion !== null && activeAssertion !== undefined &&
    JSON.stringify(activeAssertion) ===
      JSON.stringify(canonicalizePackageSelectionAssertions([assertion])[0]);
  const allSelected = isComplete && assertionMatches &&
    skillIds.every((id) => selected.has(id));

  function togglePackage() {
    if (!isComplete || !assertion) return;

    if (allSelected) {
      actions.removePackage(packageSlug);
      setFeedback("Package removed. Skills added another way stay in your stack.");
      return;
    }

    const result = actions.addPackage(assertion);
    setFeedback(
      result.ok
        ? `${memberCount} skills were added to your stack.`
        : `This package would exceed the ${meta.maxSelections}-skill stack limit. Remove a few skills and try again.`,
    );
  }

  if (availability === "binding-mismatch") {
    return (
      <div className="package-resolution package-resolution--mismatch">
        <LockKeyhole aria-hidden="true" size={18} />
        <div>
          <strong>This package isn’t ready to add yet.</strong>
          <p>We couldn’t verify that every skill matches the package shown here.</p>
          <ul className="package-resolution__issues">
            {mismatchReasons.map((reason) => <li key={reason}>{packageBindingIssueCopy[reason]}</li>)}
          </ul>
        </div>
        <Button aria-disabled="true" disabled variant="secondary">Add package</Button>
      </div>
    );
  }

  if (!isComplete || !binding) {
    const pendingCopy = availability === "not-configured"
      ? "The catalog isn’t connected here yet."
      : availability === "unavailable"
        ? "The package couldn’t be checked right now."
        : "We haven’t verified every skill in this package yet.";
    return (
      <div className="package-resolution package-resolution--pending">
        <LockKeyhole aria-hidden="true" size={18} />
        <div>
          <strong>This package isn’t ready to add yet.</strong>
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
        <strong>{memberCount} skills, checked and ready to add.</strong>
        <p>Review the list below or add the full package now.</p>
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
