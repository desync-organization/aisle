"use client";

import { Check, Copy, Layers3 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { CatalogSkillId } from "@/lib/selection/contracts";
import { useSelection } from "@/lib/selection/react";

export function CollectionActions({
  collectionName,
  skillIds,
}: {
  collectionName: string;
  skillIds: readonly CatalogSkillId[];
}) {
  const { actions } = useSelection();
  const [state, setState] = useState<"idle" | "added" | "copied" | "error">("idle");

  function addCollection() {
    const result = actions.addMany(skillIds);
    setState(result.ok ? "added" : "error");
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setState("copied");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="collection-actions">
      <Button onClick={addCollection}>
        {state === "added" ? <Check aria-hidden="true" size={16} /> : <Layers3 aria-hidden="true" size={16} />}
        {state === "added" ? "Added to your stack" : `Add all ${skillIds.length} skills`}
      </Button>
      {state === "added" ? <Link className="button button--secondary" href="/stack">Review stack</Link> : null}
      <Button onClick={copyLink} variant="secondary">
        {state === "copied" ? <Check aria-hidden="true" size={15} /> : <Copy aria-hidden="true" size={15} />}
        {state === "copied" ? "Link copied" : "Copy share link"}
      </Button>
      {state === "error" ? <p className="collection-actions__error">This action could not be completed. Your stack may already be at its 64-skill limit.</p> : null}
      <span aria-live="polite" className="sr-only">
        {state === "added" ? `${collectionName} was added to your stack.` : state === "copied" ? "Collection link copied." : state === "error" ? "The action could not be completed." : ""}
      </span>
    </div>
  );
}
