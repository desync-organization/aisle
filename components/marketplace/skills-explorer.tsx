"use client";

import { CircleDashed, Search, SlidersHorizontal, Sparkles, Trash2 } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";

import { SkillCard } from "@/components/marketplace/skill-card";
import { Button } from "@/components/ui/button";
import type { CatalogAvailability, MarketplaceSkillSummary } from "@/lib/marketplace/catalog";
import { useSelection } from "@/lib/selection/react";

type TrustFilter = "all" | "pass" | "warn";
type ProvenanceFilter = "all" | "official" | "community";
type SortMode = "popular" | "name" | "trust";

const availabilityCopy: Record<CatalogAvailability, { title: string; body: string }> = {
  ready: {
    title: "No skills match these filters",
    body: "Clear a filter or search for another upstream name, description, or source.",
  },
  empty: {
    title: "No eligible skills in this view yet",
    body: "Aisle only exposes records after public provenance, immutable revision, install shape, and trust checks resolve.",
  },
  "not-configured": {
    title: "The catalog has not been provisioned here",
    body: "No sample listings are standing in for missing data. Once a source sync is connected, eligible public skills will appear here.",
  },
  unavailable: {
    title: "The catalog could not be read",
    body: "The marketplace shell is available, but skill records are temporarily unavailable. Nothing synthetic has been substituted.",
  },
};

export function SkillsExplorer({
  availability,
  initialQuery = "",
  skills,
}: {
  availability: CatalogAvailability;
  initialQuery?: string;
  skills: ReadonlyArray<MarketplaceSkillSummary>;
}) {
  const { actions, meta, state } = useSelection();
  const [query, setQuery] = useState(initialQuery);
  const [trust, setTrust] = useState<TrustFilter>("all");
  const [provenance, setProvenance] = useState<ProvenanceFilter>("all");
  const [sort, setSort] = useState<SortMode>("popular");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());

  const visibleSkills = useMemo(() => {
    const next = skills.filter((skill) => {
      const matchesQuery = !deferredQuery || [skill.name, skill.description ?? "", skill.sourceUrl]
        .some((value) => value.toLowerCase().includes(deferredQuery));
      const matchesTrust = trust === "all" || skill.trustState === trust;
      const matchesProvenance = provenance === "all" ||
        (provenance === "official" ? skill.officialProvenance : !skill.officialProvenance);
      return matchesQuery && matchesTrust && matchesProvenance;
    });

    return next.toSorted((left, right) => {
      if (sort === "name") return left.name.localeCompare(right.name);
      if (sort === "trust") {
        const rank = { pass: 0, warn: 1, unreviewed: 2 } as const;
        return rank[left.trustState] - rank[right.trustState] || left.name.localeCompare(right.name);
      }
      return right.installs - left.installs || left.name.localeCompare(right.name);
    });
  }, [deferredQuery, provenance, skills, sort, trust]);

  const emptyCopy = availabilityCopy[availability];

  return (
    <div className="skills-explorer">
      <section aria-label="Catalog controls" className="skills-toolbar">
        <label className="skills-search">
          <span className="sr-only">Search loaded skills</span>
          <Search aria-hidden="true" size={18} />
          <input
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search skills or public sources…"
            type="search"
            value={query}
          />
          {query ? <button onClick={() => setQuery("")} type="button">Clear</button> : <kbd>/</kbd>}
        </label>
        <div className="skills-toolbar__selects">
          <label>
            <span>Trust</span>
            <select onChange={(event) => setTrust(event.target.value as TrustFilter)} value={trust}>
              <option value="all">All eligible</option>
              <option value="pass">Trust checked</option>
              <option value="warn">Review warnings</option>
            </select>
          </label>
          <label>
            <span>Source</span>
            <select onChange={(event) => setProvenance(event.target.value as ProvenanceFilter)} value={provenance}>
              <option value="all">All publishers</option>
              <option value="official">Official sources</option>
              <option value="community">Community sources</option>
            </select>
          </label>
          <label>
            <span>Sort</span>
            <select onChange={(event) => setSort(event.target.value as SortMode)} value={sort}>
              <option value="popular">Observed installs</option>
              <option value="name">Name A–Z</option>
              <option value="trust">Trust state</option>
            </select>
          </label>
        </div>
      </section>

      <div className="skills-result-bar">
        <span><SlidersHorizontal aria-hidden="true" size={14} /> {visibleSkills.length} shown</span>
        <span>{skills.length} eligible records loaded</span>
      </div>

      {visibleSkills.length > 0 ? (
        <div className="skill-grid">
          {visibleSkills.map((skill) => <SkillCard key={skill.id} skill={skill} />)}
        </div>
      ) : (
        <div className="market-empty-state">
          <span><CircleDashed aria-hidden="true" size={24} /></span>
          <div>
            <p className="eyebrow">Truthful empty state</p>
            <h2>{emptyCopy.title}</h2>
            <p>{emptyCopy.body}</p>
          </div>
          {skills.length > 0 ? (
            <Button onClick={() => { setQuery(""); setTrust("all"); setProvenance("all"); }} variant="secondary">
              Reset filters
            </Button>
          ) : null}
        </div>
      )}

      <aside className="selection-dock" id="selected-stack">
        <span className="selection-dock__icon"><Sparkles aria-hidden="true" size={18} /></span>
        <div>
          <strong>{state.count === 0 ? "Your stack is ready for a first skill" : `${state.count} skill${state.count === 1 ? "" : "s"} in your stack`}</strong>
          <p>
            {state.count === 0
              ? "Select from any catalog view. Your choices stay on this device."
              : `You can select up to ${meta.maxSelections}. Install planning revalidates every chosen ID.`}
          </p>
        </div>
        <span className="selection-dock__meter">{state.count}/{meta.maxSelections}</span>
        {state.count > 0 ? (
          <Button onClick={() => actions.clear()} variant="quiet">
            <Trash2 aria-hidden="true" size={15} /> Clear
          </Button>
        ) : null}
      </aside>
    </div>
  );
}
