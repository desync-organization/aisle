import { z } from "zod";

import {
  catalogSkillIdListSchema,
  MAX_SELECTED_SKILLS,
  type CatalogSkillId,
} from "@/lib/selection/contracts";

export const COLLECTION_NAME_MAX_LENGTH = 64;

export const collectionNameSchema = z
  .string()
  .trim()
  .min(1, "Give this collection a name.")
  .max(COLLECTION_NAME_MAX_LENGTH, `Use ${COLLECTION_NAME_MAX_LENGTH} characters or fewer.`)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
    message: "Collection names cannot contain control characters.",
  });

export const collectionSlugSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

export const createCollectionBodySchema = z.strictObject({
  name: collectionNameSchema,
  skillIds: catalogSkillIdListSchema
    .min(1, "Select at least one skill before creating a collection.")
    .max(MAX_SELECTED_SKILLS)
    .superRefine((ids, context) => {
      const seen = new Set<string>();
      ids.forEach((id, index) => {
        if (seen.has(id)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "A collection cannot contain the same skill twice.",
          });
        }
        seen.add(id);
      });
    }),
});

export type CreateCollectionInput = Readonly<{
  name: string;
  skillIds: readonly CatalogSkillId[];
}>;

export type CollectionSkill = Readonly<{
  id: CatalogSkillId;
  name: string;
  description: string | null;
  sourceUrl: string;
  position: number;
}>;

export type PublicCollection = Readonly<{
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  skills: readonly CollectionSkill[];
}>;

