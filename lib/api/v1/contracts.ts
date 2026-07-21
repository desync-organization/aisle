import { z } from "zod";

import { installPlanOptionsSchema } from "@/lib/install-plan/contracts";
import { packageCategories } from "@/lib/packages/package-blueprint";
import { MAX_SELECTED_SKILLS } from "@/lib/selection/contracts";

export const API_VERSION = "v1" as const;
export const API_PAGE_LIMIT_MAX = 100 as const;

export const skillLifecycleSchema = z.enum([
  "current",
  "stale",
  "unavailable",
  "removed",
]);

export const publicTrustStateSchema = z.enum([
  "pass",
  "warn",
  "unreviewed",
  "fail",
  "quarantined",
]);

const queryBooleanSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const limitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(API_PAGE_LIMIT_MAX)
  .default(24);

const cursorSchema = z.string().min(1).max(1_024).optional();
const searchSchema = z.string().trim().min(1).max(120).optional();
const categorySlugSchema = z
  .string()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const sourceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
  .transform((value) => value.toLowerCase());

export const skillsQuerySchema = z.strictObject({
  q: searchSchema,
  category: categorySlugSchema.optional(),
  source: sourceIdSchema.optional(),
  compatibility: z.string().trim().min(1).max(120).optional(),
  lifecycle: skillLifecycleSchema.default("current"),
  trust: publicTrustStateSchema.optional(),
  official: queryBooleanSchema.optional(),
  license: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9.+-]*$/)
    .optional(),
  sort: z.enum(["name", "popular", "recent"]).default("popular"),
  limit: limitSchema,
  cursor: cursorSchema,
});

export const skillIdParamsSchema = z.strictObject({
  id: z.string().regex(/^skill_[a-f0-9]{24}$/),
});

export const packagesQuerySchema = z.strictObject({
  q: searchSchema,
  category: z.enum(packageCategories).optional(),
  featured: queryBooleanSchema.optional(),
  sort: z.enum(["name", "recent"]).default("name"),
  limit: limitSchema,
  cursor: cursorSchema,
});

export const packageSlugParamsSchema = z.strictObject({
  slug: categorySlugSchema,
});

export const packageDetailQuerySchema = z.strictObject({
  version: z.coerce.number().int().positive().optional(),
});

export const emptyQuerySchema = z.strictObject({});

export const skillGateReasonCodes = [
  "NOT_CURRENT",
  "MISSING_CURRENT_REVISION",
  "UNBOUND_REVISION",
  "INCOMPLETE_ARTIFACT",
  "MISSING_INSTALL_SPEC",
  "UNSUPPORTED_SOURCE",
  "NO_CURRENT_SOURCE_OBSERVATION",
  "LICENSE_UNVERIFIED",
  "TRUST_PENDING",
  "TRUST_BLOCKED",
  "TRUST_QUARANTINED",
  "UPSTREAM_AUDIT_FAILED",
  "DUPLICATE_MIRROR",
] as const;

export type SkillGateReasonCode = (typeof skillGateReasonCodes)[number];

export type SkillGateReason = Readonly<{
  code: SkillGateReasonCode;
  message: string;
}>;

export type SkillsQuery = z.infer<typeof skillsQuerySchema>;
export type PackagesQuery = z.infer<typeof packagesQuerySchema>;
export type PackageDetailQuery = z.infer<typeof packageDetailQuerySchema>;

export const stackSelectionIdSchema = z.string().regex(/^skill_[a-f0-9]{24}$/);
export const stackRevisionIdSchema = z.string().regex(/^revision_[a-f0-9]{24}$/);
export const warningFingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const uniqueSelectionIdsSchema = z
  .array(stackSelectionIdSchema)
  .min(1)
  .max(MAX_SELECTED_SKILLS)
  .superRefine((ids, context) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        context.addIssue({ code: "custom", path: [index], message: "Selection IDs must be unique." });
      }
      seen.add(id);
    });
  });

export const stackPreflightRequestSchema = z.strictObject({
  selectionIds: uniqueSelectionIdsSchema,
});

export const stackWarningAcknowledgementSchema = z.strictObject({
  selectionId: stackSelectionIdSchema,
  revisionId: stackRevisionIdSchema,
  warningFingerprint: warningFingerprintSchema,
});

export const stackResolveRequestSchema = z
  .strictObject({
    selectionIds: uniqueSelectionIdsSchema,
    acknowledgements: z.array(stackWarningAcknowledgementSchema).max(MAX_SELECTED_SKILLS),
    options: installPlanOptionsSchema,
  })
  .superRefine((request, context) => {
    const selected = new Set(request.selectionIds);
    const acknowledged = new Set<string>();
    request.acknowledgements.forEach((acknowledgement, index) => {
      if (!selected.has(acknowledgement.selectionId)) {
        context.addIssue({
          code: "custom",
          path: ["acknowledgements", index, "selectionId"],
          message: "Acknowledgements must belong to the requested selection set.",
        });
      }
      if (acknowledged.has(acknowledgement.selectionId)) {
        context.addIssue({
          code: "custom",
          path: ["acknowledgements", index, "selectionId"],
          message: "A selection can be acknowledged only once.",
        });
      }
      acknowledged.add(acknowledgement.selectionId);
    });
  });

export const stackGateReasons = [
  "lifecycle-not-current",
  "revision-evidence-missing",
  "install-unresolved",
  "source-inactive",
  "license-not-eligible",
  "license-evidence-missing",
  "trust-pending",
  "trust-blocked",
  "upstream-audit-failed",
] as const;

export type StackGateReason = (typeof stackGateReasons)[number];
export type StackPreflightRequest = z.infer<typeof stackPreflightRequestSchema>;
export type StackResolveRequest = z.infer<typeof stackResolveRequestSchema>;

export type ApiFieldIssue = Readonly<{
  path: string;
  message: string;
}>;

export type ApiErrorBody = Readonly<{
  ok: false;
  error: Readonly<{
    code: string;
    message: string;
    requestId: string;
    fieldIssues?: readonly ApiFieldIssue[];
  }>;
}>;

export type ApiSuccessBody<T> = Readonly<{
  ok: true;
  data: T;
  meta: Readonly<{
    requestId: string;
    nextCursor?: string | null;
  }>;
}>;
