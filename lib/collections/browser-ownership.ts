import { MAX_SELECTED_SKILLS } from "@/lib/selection/contracts";

export const COLLECTION_OWNERS_STORAGE_KEY = "aisle.collection-owners.v1";

export type OwnedCollection = Readonly<{
  id: string;
  name: string;
  sharePath: string;
  skillCount: number;
  ownerToken: string;
  createdAt: string;
}>;

export function decodeOwnedCollections(raw: string | null): OwnedCollection[] {
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
        !Number.isInteger(candidate.skillCount) ||
        candidate.skillCount < 0 ||
        candidate.skillCount > MAX_SELECTED_SKILLS ||
        typeof candidate.ownerToken !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(candidate.ownerToken) ||
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

export function readOwnedCollections(): OwnedCollection[] {
  return decodeOwnedCollections(window.localStorage.getItem(COLLECTION_OWNERS_STORAGE_KEY));
}

export function findOwnedCollection(id: string, sharePath: string): OwnedCollection | null {
  return readOwnedCollections().find(
    (collection) => collection.id === id && collection.sharePath === sharePath,
  ) ?? null;
}

export function saveOwnedCollection(collection: OwnedCollection): OwnedCollection[] {
  const current = readOwnedCollections();
  const next = [collection, ...current.filter((item) => item.id !== collection.id)];
  window.localStorage.setItem(COLLECTION_OWNERS_STORAGE_KEY, JSON.stringify(next));
  return next;
}
