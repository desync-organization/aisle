import { z } from "zod";

export const PACKAGE_BLUEPRINT_SCHEMA_VERSION = 1 as const;

export const packageCategories = [
  "frontend",
  "motion-3d",
  "deployment",
  "cybersecurity",
  "mobile",
  "data-ai",
  "agent-engineering",
  "testing-quality",
] as const;

export const packageIconTokens = [
  "brackets",
  "orbit",
  "rocket",
  "shield",
  "device-mobile",
  "database",
  "network",
  "check-circle",
] as const;

export const packageColorTokens = [
  "iris",
  "cyan",
  "amber",
  "emerald",
  "coral",
  "blue",
  "magenta",
  "lime",
] as const;

const slugSchema = z
  .string()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const githubOwnerSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/);

const githubRepositorySchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/)
  .refine((value) => value !== "." && value !== "..", "Invalid repository name");

const repositoryPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !value.startsWith("/"), "Path must be repository-relative")
  .refine((value) => !value.includes("\\"), "Path must use forward slashes")
  .refine(
    (value) => value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "Path cannot contain empty or traversal segments",
  );

const skillPathSchema = repositoryPathSchema.refine(
  (value) => value === "SKILL.md" || value.endsWith("/SKILL.md"),
  "Path must point to an exact SKILL.md",
);

const httpsGithubRepositoryUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && url.search === "" && url.hash === "";
  }, "Repository URL must be an HTTPS github.com URL without query or fragment");

/**
 * A locator is public upstream identity, not a canonical catalog skill ID and
 * not an immutable skill revision. The catalog resolver owns those bindings.
 */
export const githubSkillLocatorSchema = z
  .strictObject({
    kind: z.literal("public-github-skill-locator"),
    host: z.literal("github.com"),
    visibility: z.literal("public"),
    owner: githubOwnerSchema,
    repository: githubRepositorySchema,
    repositoryUrl: httpsGithubRepositoryUrlSchema,
    skillPath: skillPathSchema,
    upstreamSkillName: slugSchema,
  })
  .superRefine((locator, context) => {
    const expectedUrl = `https://github.com/${locator.owner}/${locator.repository}`;

    if (locator.repositoryUrl !== expectedUrl) {
      context.addIssue({
        code: "custom",
        path: ["repositoryUrl"],
        message: `Repository URL must equal ${expectedUrl}`,
      });
    }
  });

export const launchLicenseSpdxSchema = z.enum(["MIT", "Apache-2.0"]);

export const licenseEvidenceClassSchema = z.enum([
  "repository-license",
  "skill-local-license",
  "skill-frontmatter",
]);

const licenseObservationSchema = z.strictObject({
  spdx: launchLicenseSpdxSchema,
  evidenceClass: licenseEvidenceClassSchema,
  evidencePath: repositoryPathSchema,
});

const sourceObservationSchema = z.strictObject({
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  observedAt: z.iso.date(),
});

export const packageBlueprintMemberSchema = z
  .strictObject({
    position: z.number().int().positive(),
    defaultSelected: z.literal(true),
    rationale: z.string().trim().min(20).max(240),
    publisherClass: z.enum(["official", "community"]),
    locator: githubSkillLocatorSchema,
    observedLicense: licenseObservationSchema,
    observedSource: sourceObservationSchema.optional(),
  })
  .superRefine((member, context) => {
    const { evidenceClass, evidencePath } = member.observedLicense;
    const skillDirectory = member.locator.skillPath.split("/").slice(0, -1).join("/");

    if (evidenceClass === "skill-frontmatter" && evidencePath !== member.locator.skillPath) {
      context.addIssue({
        code: "custom",
        path: ["observedLicense", "evidencePath"],
        message: "Frontmatter evidence must point to the located SKILL.md",
      });
    }

    if (
      evidenceClass === "skill-local-license" &&
      !evidencePath.startsWith(skillDirectory === "" ? "" : `${skillDirectory}/`)
    ) {
      context.addIssue({
        code: "custom",
        path: ["observedLicense", "evidencePath"],
        message: "Skill-local license evidence must be adjacent to the located skill",
      });
    }

    if (evidenceClass === "repository-license" && evidencePath.includes("/")) {
      context.addIssue({
        code: "custom",
        path: ["observedLicense", "evidencePath"],
        message: "Repository license evidence must point to a root-level file",
      });
    }
  });

const packageEditorialSchema = z.strictObject({
  title: z.string().trim().min(4).max(80),
  summary: z.string().trim().min(40).max(220),
  outcome: z.string().trim().min(30).max(220),
  audience: z.array(z.string().trim().min(3).max(80)).min(1).max(5),
  category: z.enum(packageCategories),
  tags: z.array(slugSchema).min(2).max(8),
  featured: z.boolean(),
  reviewedAt: z.iso.date(),
  visual: z.strictObject({
    iconToken: z.enum(packageIconTokens),
    colorToken: z.enum(packageColorTokens),
  }),
});

/**
 * Editorial intent only. It cannot be installed or published until every
 * locator resolves to an eligible, exact ingested revision in one transaction.
 */
export const packageBlueprintSchema = z
  .strictObject({
    schemaVersion: z.literal(PACKAGE_BLUEPRINT_SCHEMA_VERSION),
    kind: z.literal("editorial-package-blueprint"),
    slug: slugSchema,
    editorial: packageEditorialSchema,
    members: z.array(packageBlueprintMemberSchema).min(2).max(24),
  })
  .superRefine((blueprint, context) => {
    const positions = blueprint.members.map((member) => member.position).sort((left, right) => left - right);

    positions.forEach((position, index) => {
      if (position !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["members"],
          message: "Member positions must be unique and contiguous from 1",
        });
      }
    });

    const locatorKeys = blueprint.members.map(({ locator }) => githubSkillLocatorKey(locator));
    if (new Set(locatorKeys).size !== locatorKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["members"],
        message: "A package cannot include the same upstream locator twice",
      });
    }
  });

export type GitHubSkillLocator = z.infer<typeof githubSkillLocatorSchema>;
export type PackageBlueprintMember = z.infer<typeof packageBlueprintMemberSchema>;
export type PackageBlueprint = z.infer<typeof packageBlueprintSchema>;

export function githubSkillLocatorKey(locator: GitHubSkillLocator): string {
  return `${locator.owner.toLowerCase()}/${locator.repository.toLowerCase()}:${locator.skillPath}`;
}

export function parsePackageBlueprint(input: unknown): PackageBlueprint {
  return packageBlueprintSchema.parse(input);
}

export type UnresolvedPackageLocatorPlan = Readonly<{
  kind: "unresolved-package-locator-plan";
  blueprintSlug: string;
  publishable: false;
  resolutionRequirement: "bind-eligible-ingested-revisions-transactionally";
  locators: ReadonlyArray<
    Readonly<{
      position: number;
      defaultSelected: true;
      locator: GitHubSkillLocator;
    }>
  >;
}>;

/**
 * Gives the resolver deterministic upstream work. The false publishability
 * marker prevents callers from mistaking an editorial blueprint for a package
 * version backed by canonical catalog and revision IDs.
 */
export function createUnresolvedLocatorPlan(input: unknown): UnresolvedPackageLocatorPlan {
  const blueprint = parsePackageBlueprint(input);
  const locators = [...blueprint.members]
    .sort((left, right) => left.position - right.position)
    .map(({ position, defaultSelected, locator }) => ({ position, defaultSelected, locator }));

  return {
    kind: "unresolved-package-locator-plan",
    blueprintSlug: blueprint.slug,
    publishable: false,
    resolutionRequirement: "bind-eligible-ingested-revisions-transactionally",
    locators,
  };
}
