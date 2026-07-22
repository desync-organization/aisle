"use client";

import { Check, LoaderCircle, Plus, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { Button } from "@/components/ui/button";
import {
  findOwnedCollection,
  saveOwnedCollection,
  type OwnedCollection,
} from "@/lib/collections/browser-ownership";
import { MAX_SELECTED_SKILLS } from "@/lib/selection/contracts";

type CatalogSearchSkill = Readonly<{
  id: string;
  name: string;
  description: string | null;
  selectable: boolean;
}>;

type SearchState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; skills: readonly CatalogSearchSkill[] }>
  | Readonly<{ status: "error"; message: string }>;

type Feedback = Readonly<{
  tone: "success" | "error";
  message: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function searchSkillsFrom(payload: unknown): CatalogSearchSkill[] {
  if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.items)) {
    throw new Error("Search returned an unexpected response.");
  }

  return payload.data.items.map((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      typeof candidate.name !== "string" ||
      !(candidate.description === null || typeof candidate.description === "string") ||
      !isRecord(candidate.selection) ||
      typeof candidate.selection.selectable !== "boolean"
    ) throw new Error("Search returned an unexpected response.");

    return {
      id: candidate.id,
      name: candidate.name,
      description: candidate.description,
      selectable: candidate.selection.selectable,
    };
  });
}

async function jsonFrom(response: Response, fallback: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(fallback);
  }
}

function apiErrorFrom(payload: unknown, fallback: string): Readonly<{ code: string | null; message: string }> {
  if (!isRecord(payload) || !isRecord(payload.error)) return { code: null, message: fallback };
  return {
    code: typeof payload.error.code === "string" ? payload.error.code : null,
    message: typeof payload.error.message === "string" ? payload.error.message : fallback,
  };
}

function updatedCollectionFrom(payload: unknown): Readonly<{ skillIds: string[] }> | null {
  if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.data.collection)) return null;
  const skills = payload.data.collection.skills;
  if (!Array.isArray(skills)) return null;
  const skillIds = skills.flatMap((skill) => (
    isRecord(skill) && typeof skill.id === "string" ? [skill.id] : []
  ));
  return skillIds.length === skills.length ? { skillIds } : null;
}

export function CollectionSkillEditor({
  collectionId,
  collectionSlug,
  initialSkillIds,
}: Readonly<{
  collectionId: string;
  collectionSlug: string;
  initialSkillIds: readonly string[];
}>) {
  const router = useRouter();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [owner, setOwner] = useState<OwnedCollection | null>();
  const [query, setQuery] = useState("");
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [searchState, setSearchState] = useState<SearchState>({ status: "idle" });
  const [savingId, setSavingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [memberIds, setMemberIds] = useState<ReadonlySet<string>>(
    () => new Set(initialSkillIds),
  );
  const sharePath = `/collections/${collectionSlug}`;

  useEffect(() => {
    try {
      setOwner(findOwnedCollection(collectionId, sharePath));
    } catch {
      setOwner(null);
    }
  }, [collectionId, sharePath]);

  useEffect(() => {
    setMemberIds(new Set(initialSkillIds));
  }, [initialSkillIds]);

  const normalizedQuery = query.trim();
  const collectionIsFull = memberIds.size >= MAX_SELECTED_SKILLS;

  useEffect(() => {
    if (!owner || normalizedQuery.length < 2 || collectionIsFull) {
      setSearchState({ status: "idle" });
      return;
    }

    const controller = new AbortController();
    setSearchState({ status: "loading" });
    const timeout = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          q: normalizedQuery,
          sort: "name",
          limit: "8",
        });
        const response = await fetch(`/api/v1/skills?${params.toString()}`, {
          signal: controller.signal,
        });
        const payload = await jsonFrom(response, "Search is unavailable right now.");
        if (!response.ok) {
          throw new Error(apiErrorFrom(payload, "Search is unavailable right now.").message);
        }
        setSearchState({ status: "ready", skills: searchSkillsFrom(payload) });
      } catch (error) {
        if (controller.signal.aborted) return;
        setSearchState({
          status: "error",
          message: error instanceof Error ? error.message : "Search is unavailable right now.",
        });
      }
    }, 280);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [collectionIsFull, normalizedQuery, owner, searchAttempt]);

  const statusText = useMemo(() => {
    if (collectionIsFull) return `This collection has reached its ${MAX_SELECTED_SKILLS}-skill limit.`;
    if (normalizedQuery.length === 0) return "Search the catalog and add a skill here.";
    if (normalizedQuery.length < 2) return "Type one more character to search.";
    if (searchState.status === "loading") return "Searching…";
    if (searchState.status === "error") return searchState.message;
    if (searchState.status === "ready") {
      if (searchState.skills.length === 0) return "No skills match that search.";
      return `${searchState.skills.length} ${searchState.skills.length === 1 ? "result" : "results"}`;
    }
    return "";
  }, [collectionIsFull, normalizedQuery.length, searchState]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (normalizedQuery.length >= 2) setSearchAttempt((attempt) => attempt + 1);
  }

  async function addSkill(skill: CatalogSearchSkill) {
    if (!owner || savingId || memberIds.has(skill.id) || !skill.selectable || collectionIsFull) return;
    setSavingId(skill.id);
    setFeedback(null);

    try {
      const response = await fetch(`/api/v1/collections/${encodeURIComponent(collectionSlug)}/members`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${owner.ownerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ skillId: skill.id }),
      });
      const payload = await jsonFrom(response, "This skill could not be added.");
      if (!response.ok) {
        const apiError = apiErrorFrom(payload, "This skill could not be added.");
        if (apiError.code === "COLLECTION_CHANGED" || apiError.code === "COLLECTION_FULL") {
          router.refresh();
        }
        throw new Error(apiError.message);
      }

      const updated = updatedCollectionFrom(payload);
      if (!updated) {
        router.refresh();
        throw new Error("The collection was updated, but its new list could not be loaded.");
      }
      const nextIds = new Set(updated.skillIds);
      setMemberIds(nextIds);

      let savedLocally = true;
      try {
        saveOwnedCollection({ ...owner, skillCount: nextIds.size });
      } catch {
        savedLocally = false;
      }

      setFeedback({
        tone: "success",
        message: savedLocally
          ? `${skill.name} was added.`
          : `${skill.name} was added, but this browser could not update the count on your profile.`,
      });
      searchInputRef.current?.focus();
      router.refresh();
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "This skill could not be added.",
      });
    } finally {
      setSavingId(null);
    }
  }

  if (owner === undefined || owner === null) return null;

  return (
    <div className="collection-skill-editor">
      <div className="collection-skill-editor__heading">
        <div>
          <span>Add to this collection</span>
          <strong>Find another skill</strong>
        </div>
        <span>{memberIds.size}/{MAX_SELECTED_SKILLS}</span>
      </div>

      <form className="collection-skill-search" onSubmit={submitSearch} role="search">
        <Search aria-hidden="true" size={18} />
        <label className="sr-only" htmlFor={`collection-skill-search-${collectionId}`}>
          Search for a skill to add to this collection
        </label>
        <input
          aria-controls={`collection-skill-results-${collectionId}`}
          autoComplete="off"
          disabled={collectionIsFull}
          id={`collection-skill-search-${collectionId}`}
          maxLength={120}
          onChange={(event) => {
            setQuery(event.target.value);
            setFeedback(null);
          }}
          placeholder="Search by skill name or description…"
          ref={searchInputRef}
          type="search"
          value={query}
        />
        {searchState.status === "loading" ? (
          <LoaderCircle aria-hidden="true" className="stack-spinner" size={17} />
        ) : query ? (
          <button
            aria-label="Clear collection skill search"
            className="collection-skill-search__clear"
            onClick={() => {
              setQuery("");
              setFeedback(null);
            }}
            type="button"
          >
            <X aria-hidden="true" size={16} />
          </button>
        ) : null}
      </form>

      <div className="collection-skill-editor__status">
        <p aria-live="polite">{statusText}</p>
        {searchState.status === "error" ? (
          <button onClick={() => setSearchAttempt((attempt) => attempt + 1)} type="button">
            Retry
          </button>
        ) : null}
      </div>

      {feedback ? (
        <p
          className={`collection-skill-editor__feedback collection-skill-editor__feedback--${feedback.tone}`}
          role={feedback.tone === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </p>
      ) : null}

      {searchState.status === "ready" && searchState.skills.length > 0 ? (
        <ul className="collection-skill-results" id={`collection-skill-results-${collectionId}`}>
          {searchState.skills.map((skill) => {
            const included = memberIds.has(skill.id);
            const saving = savingId === skill.id;
            return (
              <li key={skill.id}>
                <div>
                  <strong>{skill.name}</strong>
                  <p>{skill.description || "No description provided."}</p>
                </div>
                {included ? (
                  <span className="collection-skill-results__included">
                    <Check aria-hidden="true" size={14} /> Included
                  </span>
                ) : skill.selectable ? (
                  <Button
                    aria-label={`Add ${skill.name} to this collection`}
                    disabled={savingId !== null}
                    onClick={() => addSkill(skill)}
                    variant="secondary"
                  >
                    {saving ? (
                      <LoaderCircle aria-hidden="true" className="stack-spinner" size={14} />
                    ) : (
                      <Plus aria-hidden="true" size={14} />
                    )}
                    {saving ? "Adding…" : "Add"}
                  </Button>
                ) : (
                  <span className="collection-skill-results__unavailable">Unavailable</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
