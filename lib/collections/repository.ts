import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { ApiError } from "@/lib/api/errors";
import type { CatalogDatabase } from "@/lib/db/client";
import { collectionMembers, collections, skills } from "@/lib/db/schema";
import { MAX_SELECTED_SKILLS, type CatalogSkillId } from "@/lib/selection/contracts";

import type {
  AddCollectionMemberInput,
  CreateCollectionInput,
  PublicCollection,
} from "./contracts";

function collectionId(): string {
  return `collection_${randomBytes(12).toString("hex")}`;
}

function ownerToken(): string {
  return randomBytes(32).toString("base64url");
}

function tokenHash(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

function ownerTokenMatches(expectedHash: string, token: string): boolean {
  const actual = Buffer.from(tokenHash(token), "utf8");
  const expected = Buffer.from(expectedHash, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
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

export async function addSkillToAnonymousCollection(
  db: CatalogDatabase,
  slug: string,
  token: string,
  input: AddCollectionMemberInput,
): Promise<Readonly<{ collection: PublicCollection; added: boolean }>> {
  let added = false;

  try {
    await db.transaction(async (transaction) => {
      const [header] = await transaction
        .select({
          id: collections.id,
          ownerKind: collections.ownerKind,
          ownerTokenHash: collections.ownerTokenHash,
          updatedAt: collections.updatedAt,
        })
        .from(collections)
        .where(and(eq(collections.slug, slug), eq(collections.public, true)))
        .limit(1);

      if (!header) {
        throw new ApiError(404, "COLLECTION_NOT_FOUND", "This collection could not be found.");
      }
      if (
        header.ownerKind !== "anonymous" ||
        !header.ownerTokenHash ||
        !ownerTokenMatches(header.ownerTokenHash, token)
      ) {
        throw new ApiError(403, "COLLECTION_OWNER_REQUIRED", "This browser cannot edit this collection.");
      }

      const [existingMember] = await transaction
        .select({ skillId: collectionMembers.skillId })
        .from(collectionMembers)
        .where(and(
          eq(collectionMembers.collectionId, header.id),
          eq(collectionMembers.skillId, input.skillId),
        ))
        .limit(1);
      if (existingMember) return;

      const nextUpdatedAt = new Date(Math.max(Date.now(), header.updatedAt.getTime() + 1));
      const claim = await transaction
        .update(collections)
        .set({ updatedAt: nextUpdatedAt })
        .where(and(
          eq(collections.id, header.id),
          eq(collections.updatedAt, header.updatedAt),
        ));
      if (claim.rowsAffected !== 1) {
        throw new ApiError(
          409,
          "COLLECTION_CHANGED",
          "This collection changed in another tab. Refresh it and try again.",
        );
      }

      const members = await transaction
        .select({ position: collectionMembers.position })
        .from(collectionMembers)
        .where(eq(collectionMembers.collectionId, header.id))
        .orderBy(desc(collectionMembers.position));
      if (members.length >= MAX_SELECTED_SKILLS) {
        throw new ApiError(
          409,
          "COLLECTION_FULL",
          `A collection can contain up to ${MAX_SELECTED_SKILLS} skills.`,
        );
      }

      const [availableSkill] = await transaction
        .select({ id: skills.id })
        .from(skills)
        .where(and(
          eq(skills.id, input.skillId),
          eq(skills.public, true),
          eq(skills.internal, false),
          inArray(skills.lifecycle, ["current", "stale"]),
        ))
        .limit(1);
      if (!availableSkill) {
        throw new ApiError(
          409,
          "COLLECTION_SKILL_UNAVAILABLE",
          "This skill is no longer available in the public catalog.",
          [{ path: "skillId", message: `${input.skillId} is unavailable.` }],
        );
      }

      await transaction.insert(collectionMembers).values({
        collectionId: header.id,
        skillId: input.skillId,
        position: (members[0]?.position ?? 0) + 1,
        addedAt: nextUpdatedAt,
      });
      added = true;
    });
  } catch (error) {
    if (!(error instanceof ApiError && error.code === "COLLECTION_CHANGED")) throw error;

    const [racedMember] = await db
      .select({ skillId: collectionMembers.skillId })
      .from(collectionMembers)
      .innerJoin(collections, eq(collections.id, collectionMembers.collectionId))
      .where(and(
        eq(collections.slug, slug),
        eq(collections.public, true),
        eq(collectionMembers.skillId, input.skillId),
      ))
      .limit(1);
    if (!racedMember) throw error;
  }

  const collection = await findPublicCollection(db, slug);
  if (!collection) {
    throw new ApiError(500, "COLLECTION_READ_FAILED", "The updated collection could not be loaded.");
  }
  return { collection, added };
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

