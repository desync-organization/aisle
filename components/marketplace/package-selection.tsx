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
      skillIds.forEach((id) => actions.remove(id));
      setFeedback(`${memberCount} package skills removed from your stack.`);
      return;
    }

    const result = actions.addPackage(assertion);
    setFeedback(
      result.ok
        ? `${memberCount} package skills and their immutable package receipt were added to your stack.`
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
