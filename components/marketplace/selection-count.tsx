"use client";

import { Layers3 } from "lucide-react";
import Link from "next/link";

import { useSelection } from "@/lib/selection/react";

export function SelectionCount() {
  const { state } = useSelection();

  return (
    <Link
      aria-label={`Your Stack, ${state.count} selected`}
      className="stack-link"
      href="/skills#selected-stack"
    >
      <Layers3 aria-hidden="true" size={16} />
      <span>Your Stack</span>
      <strong>{state.count}</strong>
    </Link>
  );
}
