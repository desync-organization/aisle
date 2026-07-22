"use client";

import { ArrowLeft, ArrowRight, CircleDashed, Search, SlidersHorizontal, Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDeferredValue, useMemo, useState, type FormEvent } from "react";

import { SkillCard } from "@/components/marketplace/skill-card";
import { Button } from "@/components/ui/button";
import type {
  CatalogAvailability,
  MarketplaceCatalogSnapshot,
  MarketplaceSkillSummary,
} from "@/lib/marketplace/catalog";
import { useSelection } from "@/lib/selection/react";

type TrustFilter = "all" | MarketplaceSkillSummary["trustState"];
type ProvenanceFilter = "all" | "official" | "community";
type SortMode = "popular" | "name" | "trust";

const availabilityCopy: Record<CatalogAvailability, { title: string; body: string }> = {
  ready: {
    title: "No skills found",
    body: "Try another search or clear a filter.",
  },
  empty: {
    title: "No skills here yet",
    body: "Skills will appear after the next source sync.",
  },
  "not-configured": {
    title: "The catalog isn’t connected",
    body: "Connect a source to show public skills here.",
  },
  unavailable: {
    title: "Skills aren’t loading right now",
    body: "Try again in a moment.",
  },
};

export function SkillsExplorer({
  availability,
  category,
  includeUnavailable = false,
  initialQuery = "",
  pagination,
  skills,
}: {
  availability: CatalogAvailability;
  category?: string;
  includeUnavailable?: boolean;
  initialQuery?: string;
  pagination: MarketplaceCatalogSnapshot["pagination"];
  skills: ReadonlyArray<MarketplaceSkillSummary>;
}) {
  const router = useRouter();
  const { actions, meta, state } = useSelection();
  const [query, setQuery] = useState(initialQuery);
  const [trust, setTrust] = useState<TrustFilter>("all");
  const [provenance, setProvenance] = useState<ProvenanceFilter>("all");
  const [sort, setSort] = useState<SortMode>("popular");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const appliedQuery = initialQuery.trim().toLowerCase();
  const localDraftQuery = deferredQuery === appliedQuery ? "" : deferredQuery;

  const visibleSkills = useMemo(() => {
    const next = skills.filter((skill) => {
      const matchesQuery = !localDraftQuery || [skill.name, skill.description ?? "", skill.sourceUrl]
        .some((value) => value.toLowerCase().includes(localDraftQuery));
      const matchesTrust = trust === "all" || skill.trustState === trust;
      const matchesProvenance = provenance === "all" ||
        (provenance === "official" ? skill.officialProvenance : !skill.officialProvenance);
      return matchesQuery && matchesTrust && matchesProvenance;
    });

    return next.toSorted((left, right) => {
      if (sort === "name") return left.name.localeCompare(right.name);
      if (sort === "trust") {
        const rank: Record<MarketplaceSkillSummary["trustState"], number> = {
          pass: 0,
          warn: 1,
          unreviewed: 2,
          blocked: 3,
        };
        return rank[left.trustState] - rank[right.trustState] || left.name.localeCompare(right.name);
      }
      return right.installs - left.installs || left.name.localeCompare(right.name);
    });
  }, [localDraftQuery, provenance, skills, sort, trust]);

  const emptyCopy = availabilityCopy[availability];

  function catalogUrl(
    nextQuery: string,
    nextPage = 1,
    showUnavailable = includeUnavailable,
  ): string {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (nextQuery) params.set("q", nextQuery);
    if (showUnavailable) params.set("status", "all");
    if (nextPage > 1) params.set("page", String(nextPage));
    const encoded = params.toString();
    return encoded ? `/skills?${encoded}` : "/skills";
  }

  function submitCatalogSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = query.trim();
    if (normalized === initialQuery.trim() && pagination.page === 1) return;
    router.push(catalogUrl(normalized));
  }

  function clearSearch() {
    setQuery("");
    if (initialQuery) router.push(catalogUrl(""));
  }

  return (
    <div className="skills-explorer">
      <section aria-label="Catalog controls" className="skills-toolbar">
        <form className="skills-search" onSubmit={submitCatalogSearch} role="search">
          <Search aria-hidden="true" size={18} />
          <label className="sr-only" htmlFor="skills-explorer-search">Search the public skills catalog</label>
          <input
            autoComplete="off"
            id="skills-explorer-search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search skills or public sources…"
            type="search"
            value={query}
          />
          <span className="skills-search__actions">
            {query ? <button onClick={clearSearch} type="button">Clear</button> : null}
            <button aria-label="Search the full catalog" className="skills-search__submit" type="submit">
              Search <ArrowRight aria-hidden="true" size={13} />
            </button>
          </span>
        </form>
        <nav aria-label="Skill availability" className="skills-availability-toggle">
          <Link
            aria-current={!includeUnavailable ? "page" : undefined}
            href={catalogUrl(initialQuery, 1, false)}
          >
            Ready to add
          </Link>
          <Link
            aria-current={includeUnavailable ? "page" : undefined}
            href={catalogUrl(initialQuery, 1, true)}
          >
            All records
          </Link>
        </nav>
        <div className="skills-toolbar__selects">
          <label>
            <span>Trust</span>
            <select onChange={(event) => setTrust(event.target.value as TrustFilter)} value={trust}>
              <option value="all">All records</option>
              <option value="pass">Trust checked</option>
              <option value="warn">Review warnings</option>
              <option value="unreviewed">Review pending</option>
              <option value="blocked">Trust blocked</option>
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
        <span>
          <SlidersHorizontal aria-hidden="true" size={14} /> {visibleSkills.length} {includeUnavailable ? "records" : "ready skills"} shown
        </span>
        <span>
          {includeUnavailable
            ? "Pending and blocked records are included"
            : "Every result on this page can be added now"} · page {pagination.page}
        </span>
      </div>

      {visibleSkills.length > 0 ? (
        <div className="skill-grid">
          {visibleSkills.map((skill) => <SkillCard key={skill.id} skill={skill} />)}
        </div>
      ) : (
        <div className="market-empty-state">
          <span><CircleDashed aria-hidden="true" size={24} /></span>
          <div>
            <p className="eyebrow">No results</p>
            <h2>{emptyCopy.title}</h2>
            <p>{emptyCopy.body}</p>
          </div>
          {skills.length > 0 ? (
            <Button onClick={() => { clearSearch(); setTrust("all"); setProvenance("all"); }} variant="secondary">
              Reset filters
            </Button>
          ) : null}
        </div>
      )}

      {(pagination.hasPrevious || pagination.hasNext) ? (
        <nav aria-label="Skills catalog pages" className="catalog-pagination">
          {pagination.hasPrevious ? (
            <Link href={catalogUrl(initialQuery, pagination.page - 1)}>
              <ArrowLeft aria-hidden="true" size={15} /> Previous
            </Link>
          ) : <span aria-hidden="true" />}
          <span>Page {pagination.page}</span>
          {pagination.hasNext ? (
            <Link href={catalogUrl(initialQuery, pagination.page + 1)}>
              Next <ArrowRight aria-hidden="true" size={15} />
            </Link>
          ) : <span aria-hidden="true" />}
        </nav>
      ) : null}

      <aside className="selection-dock" id="selected-stack">
        <span className="selection-dock__icon"><Sparkles aria-hidden="true" size={18} /></span>
        <div>
          <strong>{state.count === 0 ? "Start your stack" : `${state.count} skill${state.count === 1 ? "" : "s"} in your stack`}</strong>
          <p>
            {state.count === 0
              ? "Choose any skill to add it here."
              : `You can add up to ${meta.maxSelections} skills. We check each one before install.`}
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
