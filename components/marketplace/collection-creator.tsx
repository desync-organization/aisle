"use client";

import { ArrowRight, Check, Copy, FolderPlus, Link2, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { COLLECTION_NAME_MAX_LENGTH } from "@/lib/collections/contracts";
import { useSelection } from "@/lib/selection/react";

const COLLECTION_OWNERS_STORAGE_KEY = "aisle.collection-owners.v1";

type OwnedCollection = Readonly<{
  id: string;
  name: string;
  sharePath: string;
  skillCount: number;
  ownerToken: string;
  createdAt: string;
}>;

type CreateState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "success"; collection: OwnedCollection; copied: boolean }>
  | Readonly<{ status: "error"; message: string }>;

function decodeOwnedCollections(raw: string | null): OwnedCollection[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.flatMap((candidate) => {
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        !("id" in candidate) ||
        !("name" in candidate) ||
        !("sharePath" in candidate) ||
        !("skillCount" in candidate) ||
        !("ownerToken" in candidate) ||
        !("createdAt" in candidate) ||
        typeof candidate.id !== "string" ||
        typeof candidate.name !== "string" ||
        typeof candidate.sharePath !== "string" ||
        !candidate.sharePath.startsWith("/collections/") ||
        typeof candidate.skillCount !== "number" ||
        typeof candidate.ownerToken !== "string" ||
        typeof candidate.createdAt !== "string"
      ) return [];
      return [{
        id: candidate.id,
        name: candidate.name,
        sharePath: candidate.sharePath,
        skillCount: candidate.skillCount,
        ownerToken: candidate.ownerToken,
        createdAt: candidate.createdAt,
      }];
    });
  } catch {
    return [];
  }
}

function saveOwnedCollection(collection: OwnedCollection): OwnedCollection[] {
  const current = decodeOwnedCollections(window.localStorage.getItem(COLLECTION_OWNERS_STORAGE_KEY));
  const next = [collection, ...current.filter((item) => item.id !== collection.id)];
  window.localStorage.setItem(COLLECTION_OWNERS_STORAGE_KEY, JSON.stringify(next));
  return next;
}

function shareUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

export function CollectionCreator({ compact = false }: { compact?: boolean }) {
  const { state } = useSelection();
  const [name, setName] = useState("");
  const [createState, setCreateState] = useState<CreateState>({ status: "idle" });
  const [ownedCollections, setOwnedCollections] = useState<readonly OwnedCollection[]>([]);
  const selectedCountLabel = `${state.count} ${state.count === 1 ? "skill" : "skills"}`;
  const canSubmit = state.hydrated && state.count > 0 && name.trim().length > 0 && createState.status !== "loading";

  useEffect(() => {
    try {
      setOwnedCollections(decodeOwnedCollections(window.localStorage.getItem(COLLECTION_OWNERS_STORAGE_KEY)));
    } catch {
      setOwnedCollections([]);
    }
  }, []);

  const visibleOwnedCollections = useMemo(
    () => compact ? ownedCollections.slice(0, 3) : ownedCollections,
    [compact, ownedCollections],
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setCreateState({ status: "loading" });

    try {
      const response = await fetch("/api/v1/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), skillIds: state.ids }),
      });
      const payload: unknown = await response.json();
      if (typeof payload !== "object" || payload === null) {
        throw new Error("Aisle could not create this collection.");
      }
      if (!response.ok) {
        const message = "error" in payload && typeof payload.error === "object" && payload.error !== null &&
          "message" in payload.error && typeof payload.error.message === "string"
          ? payload.error.message
          : "Aisle could not create this collection.";
        throw new Error(message);
      }
      if (!("data" in payload) || typeof payload.data !== "object" || payload.data === null) {
        throw new Error("Aisle could not create this collection.");
      }
      const data = payload.data as Record<string, unknown>;
      const collection = data.collection;
      const ownerToken = "ownerToken" in payload ? payload.ownerToken : null;
      if (
        typeof collection !== "object" ||
        collection === null ||
        !("id" in collection) ||
        !("name" in collection) ||
        !("createdAt" in collection) ||
        typeof collection.id !== "string" ||
        typeof collection.name !== "string" ||
        typeof collection.createdAt !== "string" ||
        typeof data.sharePath !== "string" ||
        !data.sharePath.startsWith("/collections/") ||
        typeof ownerToken !== "string"
      ) {
        throw new Error("Aisle couldn’t finish creating this collection.");
      }

      const owned: OwnedCollection = {
        id: collection.id,
        name: collection.name,
        sharePath: data.sharePath,
        skillCount: state.count,
        ownerToken,
        createdAt: collection.createdAt,
      };
      let nextOwned = [owned, ...ownedCollections];
      try {
        nextOwned = saveOwnedCollection(owned);
      } catch {
        // The public collection still exists even when this browser blocks local storage.
      }
      setOwnedCollections(nextOwned);
      setName("");
      setCreateState({ status: "success", collection: owned, copied: false });
    } catch (error) {
      setCreateState({
        status: "error",
        message: error instanceof Error ? error.message : "Aisle could not create this collection.",
      });
    }
  }

  async function copyCollectionLink(collection: OwnedCollection) {
    try {
      await navigator.clipboard.writeText(shareUrl(collection.sharePath));
      if (createState.status === "success" && createState.collection.id === collection.id) {
        setCreateState({ ...createState, copied: true });
      }
    } catch {
      if (createState.status === "success" && createState.collection.id === collection.id) {
        setCreateState({ status: "error", message: "Copy failed. Open the collection and copy its address instead." });
      }
    }
  }

  return (
    <section className={`collection-creator${compact ? " collection-creator--compact" : ""}`}>
      <div className="collection-creator__intro">
        <span><FolderPlus aria-hidden="true" size={18} /> Save and share</span>
        <h2>Create a collection.</h2>
        <p>Name your current stack and get a public link to share.</p>
      </div>

      <form className="collection-creator__form" onSubmit={submit}>
        <label htmlFor={compact ? "stack-collection-name" : "collection-name"}>Collection name</label>
        <div>
          <input
            autoComplete="off"
            id={compact ? "stack-collection-name" : "collection-name"}
            maxLength={COLLECTION_NAME_MAX_LENGTH}
            onChange={(event) => {
              setName(event.target.value);
              if (createState.status === "error") setCreateState({ status: "idle" });
            }}
            placeholder="Frontend launch kit"
            value={name}
          />
          <span>{selectedCountLabel}</span>
        </div>
        <Button disabled={!canSubmit} type="submit">
          {createState.status === "loading"
            ? <LoaderCircle aria-hidden="true" className="stack-spinner" size={16} />
            : <Link2 aria-hidden="true" size={16} />}
          {createState.status === "loading" ? "Creating collection…" : "Create collection"}
        </Button>
        {state.hydrated && state.count === 0 ? (
          <p className="collection-creator__empty">Select skills first. <Link href="/skills">Browse the catalog <ArrowRight aria-hidden="true" size={13} /></Link></p>
        ) : null}
        {createState.status === "error" ? <p className="collection-creator__error" role="alert">{createState.message}</p> : null}
      </form>

      {createState.status === "success" ? (
        <div className="collection-receipt" aria-live="polite">
          <span><Check aria-hidden="true" size={16} /> Ready to share</span>
          <strong>{createState.collection.name}</strong>
          <code>{shareUrl(createState.collection.sharePath)}</code>
          <div>
            <Button onClick={() => copyCollectionLink(createState.collection)} variant="secondary">
              {createState.copied ? <Check aria-hidden="true" size={15} /> : <Copy aria-hidden="true" size={15} />}
              {createState.copied ? "Copied" : "Copy link"}
            </Button>
            <Link className="button button--primary" href={createState.collection.sharePath}>Open collection <ArrowRight aria-hidden="true" size={15} /></Link>
          </div>
        </div>
      ) : null}

      {visibleOwnedCollections.length > 0 ? (
        <div className="device-collections">
          <span>Your collections</span>
          <ul>
            {visibleOwnedCollections.map((collection) => (
              <li key={collection.id}>
                <Link href={collection.sharePath}>
                  <strong>{collection.name}</strong>
                  <span>{collection.skillCount} {collection.skillCount === 1 ? "skill" : "skills"}</span>
                </Link>
                <Button aria-label={`Copy link to ${collection.name}`} onClick={() => copyCollectionLink(collection)} variant="quiet">
                  <Copy aria-hidden="true" size={14} />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : !compact ? (
        <div className="device-collections device-collections--empty">
          <span>Your collections</span>
          <p>No collections yet. Select a few skills, then save them here.</p>
        </div>
      ) : null}
    </section>
  );
}
