import { createHash, randomBytes } from "node:crypto";

import { and, asc, eq, inArray } from "drizzle-orm";

import { ApiError } from "@/lib/api/errors";
import type { CatalogDatabase } from "@/lib/db/client";
import { collectionMembers, collections, skills } from "@/lib/db/schema";
import type { CatalogSkillId } from "@/lib/selection/contracts";

import type { CreateCollectionInput, PublicCollection } from "./contracts";

function collectionId(): string {
  return `collection_${randomBytes(12).toString("hex")}`;
}

function ownerToken(): string {
  return randomBytes(32).toString("base64url");
}

function tokenHash(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

function slugBase(name: string): string {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 54)
    .replace(/-+$/u, "");
  return base || "skill-collection";
}

function collectionSlug(name: string): string {
  return `${slugBase(name)}-${randomBytes(5).toString("hex")}`;
}

export async function createAnonymousCollection(
  db: CatalogDatabase,
  input: CreateCollectionInput,
): Promise<Readonly<{ collection: PublicCollection; ownerToken: string }>> {
  const rows = await db
    .select({
      id: skills.id,
      name: skills.upstreamName,
      description: skills.upstreamDescription,
      sourceUrl: skills.sourceUrl,
    })
    .from(skills)
    .where(and(
      inArray(skills.id, [...input.skillIds]),
      eq(skills.public, true),
      eq(skills.internal, false),
      inArray(skills.lifecycle, ["current", "stale"]),
    ));

  const rowById = new Map(rows.map((row) => [row.id, row]));
  const missingIds = input.skillIds.filter((id) => !rowById.has(id));
  if (missingIds.length > 0) {
    throw new ApiError(
      409,
      "COLLECTION_SKILLS_UNAVAILABLE",
      "One or more selected skills are no longer available in the public catalog.",
      missingIds.map((id, index) => ({ path: `skillIds.${index}`, message: `${id} is unavailable.` })),
    );
  }

  const id = collectionId();
  const slug = collectionSlug(input.name);
  const token = ownerToken();
  const now = new Date();

  await db.transaction(async (transaction) => {
    await transaction.insert(collections).values({
      id,
      slug,
      name: input.name,
      ownerKind: "anonymous",
      ownerAccountId: null,
      ownerTokenHash: tokenHash(token),
      public: true,
      createdAt: now,
      updatedAt: now,
    });
    await transaction.insert(collectionMembers).values(input.skillIds.map((skillId, index) => ({
      collectionId: id,
      skillId,
      position: index + 1,
      addedAt: now,
    })));
  });

  return {
    ownerToken: token,
    collection: {
      id,
      slug,
      name: input.name,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      skills: input.skillIds.map((skillId, index) => {
        const row = rowById.get(skillId)!;
        return {
          id: skillId,
          name: row.name,
          description: row.description,
          sourceUrl: row.sourceUrl,
          position: index + 1,
        };
      }),
    },
  };
}

export async function findPublicCollection(
  db: CatalogDatabase,
  slug: string,
): Promise<PublicCollection | null> {
  const [header] = await db
    .select({
      id: collections.id,
      slug: collections.slug,
      name: collections.name,
      createdAt: collections.createdAt,
      updatedAt: collections.updatedAt,
    })
    .from(collections)
    .where(and(eq(collections.slug, slug), eq(collections.public, true)))
    .limit(1);

  if (!header) return null;

  const members = await db
    .select({
      id: skills.id,
      name: skills.upstreamName,
      description: skills.upstreamDescription,
      sourceUrl: skills.sourceUrl,
      position: collectionMembers.position,
    })
    .from(collectionMembers)
    .innerJoin(skills, eq(collectionMembers.skillId, skills.id))
    .where(eq(collectionMembers.collectionId, header.id))
    .orderBy(asc(collectionMembers.position));

  return {
    id: header.id,
    slug: header.slug,
    name: header.name,
    createdAt: header.createdAt.toISOString(),
    updatedAt: header.updatedAt.toISOString(),
    skills: members.map((member) => ({
      ...member,
      id: member.id as CatalogSkillId,
    })),
  };
}

