import { z } from "zod";

import { packageCategories } from "@/lib/packages/package-blueprint";

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

export const skillsQuerySchema = z.strictObject({
  q: searchSchema,
  category: categorySlugSchema.optional(),
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
