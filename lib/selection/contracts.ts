import { z } from "zod";

export const SELECTION_STORAGE_VERSION = 2 as const;
export const SELECTION_STORAGE_KEY = "aisle.selection.v2" as const;
export const LEGACY_SELECTION_STORAGE_KEY = "aisle.selection.v1" as const;
export const SELECTION_QUERY_PARAMETER = "skills" as const;
export const MAX_SELECTED_SKILLS = 64;
export const MAX_CATALOG_SKILL_ID_LENGTH = 128;
export const MAX_PACKAGE_SELECTION_ASSERTIONS = 16;
export const MAX_PACKAGE_ASSERTION_MEMBER_REFERENCES = 128;
export const MAX_PACKAGE_SLUG_LENGTH = 100;

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

export const packageSelectionMemberAssertionSchema = z.strictObject({
  selectionId: catalogSkillIdSchema,
  revisionId: z.string().regex(/^revision_[a-f0-9]{24}$/),
});

export const packageSelectionAssertionSchema = z.strictObject({
  packageSlug: z
    .string()
    .min(1)
    .max(MAX_PACKAGE_SLUG_LENGTH)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  packageVersion: z.number().int().positive().max(2_147_483_647),
  blueprintDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  members: z
    .array(packageSelectionMemberAssertionSchema)
    .min(1)
    .max(MAX_SELECTED_SKILLS)
    .superRefine((members, context) => {
      const seen = new Set<string>();
      members.forEach((member, index) => {
        if (seen.has(member.selectionId)) {
          context.addIssue({
            code: "custom",
            path: [index, "selectionId"],
            message: "Package member selection IDs must be unique.",
          });
        }
        seen.add(member.selectionId);
      });
    }),
});

export const packageSelectionAssertionListSchema = z
  .array(packageSelectionAssertionSchema)
  .max(MAX_PACKAGE_SELECTION_ASSERTIONS)
  .superRefine((assertions, context) => {
    const seen = new Set<string>();
    let memberReferences = 0;
    assertions.forEach((assertion, index) => {
      memberReferences += assertion.members.length;
      if (seen.has(assertion.packageSlug)) {
        context.addIssue({
          code: "custom",
          path: [index, "packageSlug"],
          message: "A package can have only one selected version assertion.",
        });
      }
      seen.add(assertion.packageSlug);
    });
    if (memberReferences > MAX_PACKAGE_ASSERTION_MEMBER_REFERENCES) {
      context.addIssue({
        code: "custom",
        message: `Package assertions can contain at most ${MAX_PACKAGE_ASSERTION_MEMBER_REFERENCES} member references.`,
      });
    }
  });

export const persistedSelectionEnvelopeSchema = z
  .strictObject({
    version: z.literal(SELECTION_STORAGE_VERSION),
    ids: catalogSkillIdListSchema,
    packageAssertions: packageSelectionAssertionListSchema,
  })
  .superRefine((envelope, context) => {
    const selected = new Set(envelope.ids);
    envelope.packageAssertions.forEach((assertion, assertionIndex) => {
      assertion.members.forEach((member, memberIndex) => {
        if (!selected.has(member.selectionId)) {
          context.addIssue({
            code: "custom",
            path: ["packageAssertions", assertionIndex, "members", memberIndex, "selectionId"],
            message: "Package assertions can reference only selected skill IDs.",
          });
        }
      });
    });
  });

export const legacyPersistedSelectionEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  ids: catalogSkillIdListSchema,
});

export type CatalogSkillId = z.infer<typeof catalogSkillIdSchema>;
export type PackageSelectionMemberAssertion = Readonly<
  z.infer<typeof packageSelectionMemberAssertionSchema>
>;
export type PackageSelectionAssertion = Readonly<
  Omit<z.infer<typeof packageSelectionAssertionSchema>, "members"> & {
    members: readonly PackageSelectionMemberAssertion[];
  }
>;
export type PersistedSelectionEnvelope = Readonly<
  Omit<z.infer<typeof persistedSelectionEnvelopeSchema>, "ids" | "packageAssertions"> & {
    ids: readonly CatalogSkillId[];
    packageAssertions: readonly PackageSelectionAssertion[];
  }
>;

export function sortAndDedupeCatalogSkillIds(
  ids: readonly CatalogSkillId[],
): readonly CatalogSkillId[] {
  return [...new Set(ids)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

export function canonicalizePackageSelectionAssertions(
  assertions: readonly PackageSelectionAssertion[],
): readonly PackageSelectionAssertion[] {
  return [...assertions]
    .map((assertion) => ({
      ...assertion,
      members: [...assertion.members].sort((left, right) =>
        left.selectionId < right.selectionId
          ? -1
          : left.selectionId > right.selectionId
            ? 1
            : 0,
      ),
    }))
    .sort((left, right) =>
      left.packageSlug < right.packageSlug
        ? -1
        : left.packageSlug > right.packageSlug
          ? 1
          : 0,
    );
}
