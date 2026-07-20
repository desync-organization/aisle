import { z } from "zod";

export const SELECTION_STORAGE_VERSION = 1 as const;
export const SELECTION_STORAGE_KEY = "aisle.selection.v1" as const;
export const SELECTION_QUERY_PARAMETER = "skills" as const;
export const MAX_SELECTED_SKILLS = 64;
export const MAX_CATALOG_SKILL_ID_LENGTH = 128;

const unsafeSchemePattern = /^(?:https?|javascript|data|file|vbscript):/i;

/**
 * An opaque identifier issued by Aisle's catalog.
 *
 * It is deliberately not a URL, path, source locator, flag, or command. The
 * browser may carry these IDs, but the install API must resolve them again
 * against durable catalog state before treating a selection as installable.
 */
export const catalogSkillIdSchema = z
  .string()
  .min(1)
  .max(MAX_CATALOG_SKILL_ID_LENGTH)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "must be an opaque ASCII catalog skill ID",
  )
  .refine((value) => !unsafeSchemePattern.test(value), {
    message: "must not be a URL or executable scheme",
  })
  .brand<"CatalogSkillId">();

export const catalogSkillIdListSchema = z
  .array(catalogSkillIdSchema)
  .max(MAX_SELECTED_SKILLS);

export const persistedSelectionEnvelopeSchema = z.strictObject({
  version: z.literal(SELECTION_STORAGE_VERSION),
  ids: catalogSkillIdListSchema,
});

export type CatalogSkillId = z.infer<typeof catalogSkillIdSchema>;
export type PersistedSelectionEnvelope = z.infer<
  typeof persistedSelectionEnvelopeSchema
>;

export function sortAndDedupeCatalogSkillIds(
  ids: readonly CatalogSkillId[],
): readonly CatalogSkillId[] {
  return [...new Set(ids)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}
