import { describe, expect, it } from "vitest";

import {
  createUnresolvedLocatorPlan,
  githubSkillLocatorKey,
  launchPackageBlueprints,
  packageBlueprintSchema,
  packageCategories,
} from "@/lib/packages";

function collectObjectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectObjectKeys);
  if (value === null || typeof value !== "object") return [];

  return Object.entries(value).flatMap(([key, child]) => [key, ...collectObjectKeys(child)]);
}

describe("launch package blueprints", () => {
  it("parses every versioned editorial blueprint", () => {
    expect(launchPackageBlueprints).toHaveLength(8);

    for (const blueprint of launchPackageBlueprints) {
      expect(packageBlueprintSchema.parse(blueprint)).toEqual(blueprint);
      expect(blueprint.schemaVersion).toBe(1);
      expect(blueprint.kind).toBe("editorial-package-blueprint");
      expect(blueprint.members.every((member) => member.defaultSelected)).toBe(true);
    }
  });

  it("keeps package slugs and upstream member locators globally unique", () => {
    const slugs = launchPackageBlueprints.map((blueprint) => blueprint.slug);
    const locatorKeys = launchPackageBlueprints.flatMap((blueprint) =>
      blueprint.members.map((member) => githubSkillLocatorKey(member.locator)),
    );

    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(locatorKeys).size).toBe(locatorKeys.length);
  });

  it("contains only explicit public GitHub SKILL.md locators", () => {
    for (const blueprint of launchPackageBlueprints) {
      for (const { locator } of blueprint.members) {
        const repositoryUrl = new URL(locator.repositoryUrl);
        const pathSegments = locator.skillPath.split("/");

        expect(locator.host).toBe("github.com");
        expect(locator.visibility).toBe("public");
        expect(repositoryUrl.protocol).toBe("https:");
        expect(repositoryUrl.hostname).toBe("github.com");
        expect(repositoryUrl.pathname).toBe(`/${locator.owner}/${locator.repository}`);
        expect(locator.skillPath.endsWith("SKILL.md")).toBe(true);
        expect(locator.skillPath.includes("\\")).toBe(false);
        expect(pathSegments).not.toContain("");
        expect(pathSegments).not.toContain(".");
        expect(pathSegments).not.toContain("..");
      }
    }
  });

  it("limits the launch set to reviewed MIT and Apache-2.0 evidence", () => {
    const allowedSpdx = new Set(["MIT", "Apache-2.0"]);

    for (const blueprint of launchPackageBlueprints) {
      for (const member of blueprint.members) {
        expect(allowedSpdx.has(member.observedLicense.spdx)).toBe(true);
        expect(member.observedSource?.headSha).toMatch(/^[0-9a-f]{40}$/);
        expect(member.observedSource?.observedAt).toBe("2026-07-21");
      }
    }
  });

  it("stores locators and evidence without vendored skill payload fields", () => {
    const forbiddenFields = new Set([
      "raw",
      "body",
      "content",
      "instruction",
      "instructions",
      "skillBody",
      "skillContent",
    ]);
    const presentForbiddenFields = collectObjectKeys(launchPackageBlueprints).filter((key) =>
      forbiddenFields.has(key),
    );

    expect(presentForbiddenFields).toEqual([]);
  });

  it("excludes unlicensed candidates and retains the corrected Firebase skill", () => {
    const upstreamNames = launchPackageBlueprints.flatMap((blueprint) =>
      blueprint.members.map((member) => member.locator.upstreamSkillName),
    );

    expect(upstreamNames).not.toContain("vercel-react-view-transitions");
    expect(upstreamNames).not.toContain("vercel-react-native-skills");
    expect(upstreamNames).not.toContain("firebase-data-connect");
    expect(upstreamNames).toContain("firebase-data-connect-basics");
  });

  it("covers every launch category with useful multi-skill packages", () => {
    const categories = new Set(
      launchPackageBlueprints.map((blueprint) => blueprint.editorial.category),
    );

    expect(launchPackageBlueprints.length).toBeGreaterThanOrEqual(6);
    expect(categories).toEqual(new Set(packageCategories));
    expect(launchPackageBlueprints.every((blueprint) => blueprint.members.length >= 5)).toBe(true);
    expect(launchPackageBlueprints.every((blueprint) => blueprint.editorial.audience.length > 0)).toBe(true);
    expect(launchPackageBlueprints.every((blueprint) => blueprint.editorial.tags.length >= 2)).toBe(true);
  });

  it("keeps the corrected package compositions explicit", () => {
    const packages = new Map(
      launchPackageBlueprints.map((blueprint) => [
        blueprint.slug,
        blueprint.members.map((member) => member.locator.upstreamSkillName),
      ]),
    );

    expect(packages.get("motion-and-3d")).toEqual([
      "gsap-scrolltrigger",
      "threejs-webgl",
      "react-three-fiber",
      "motion-framer",
      "web3d-integration-patterns",
      "hyperframes-animation",
    ]);
    expect(packages.get("mobile")).toEqual([
      "expo-project-structure",
      "expo-router",
      "expo-data-fetching",
      "expo-native-ui",
      "expo-tailwind-setup",
      "expo-upgrade",
    ]);
  });

  it("rejects canonical IDs smuggled into an editorial blueprint", () => {
    const candidate = {
      ...launchPackageBlueprints[0],
      canonicalPackageId: "pkg_fake",
    };

    expect(packageBlueprintSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects unsafe paths and licenses outside the reviewed launch set", () => {
    const blueprint = launchPackageBlueprints[0]!;
    const [firstMember, ...remainingMembers] = blueprint.members;
    expect(firstMember).toBeDefined();

    const unsafePath = {
      ...blueprint,
      members: [
        {
          ...firstMember!,
          locator: {
            ...firstMember!.locator,
            skillPath: "skills/../private/SKILL.md",
          },
        },
        ...remainingMembers,
      ],
    };
    const unsupportedLicense = {
      ...blueprint,
      members: [
        {
          ...firstMember!,
          observedLicense: {
            ...firstMember!.observedLicense,
            spdx: "NOASSERTION",
          },
        },
        ...remainingMembers,
      ],
    };

    expect(packageBlueprintSchema.safeParse(unsafePath).success).toBe(false);
    expect(packageBlueprintSchema.safeParse(unsupportedLicense).success).toBe(false);
  });

  it("returns deterministic resolver work without publishing unresolved members", () => {
    const blueprint = launchPackageBlueprints[0]!;

    const shuffled = {
      ...blueprint,
      members: [...blueprint.members].reverse(),
    };
    const first = createUnresolvedLocatorPlan(shuffled);
    const second = createUnresolvedLocatorPlan(shuffled);

    expect(first).toEqual(second);
    expect(first.publishable).toBe(false);
    expect(first.resolutionRequirement).toBe("bind-eligible-ingested-revisions-transactionally");
    expect(first.locators.map((entry) => entry.position)).toEqual([1, 2, 3, 4, 5]);
    expect(JSON.stringify(first)).not.toMatch(/headSha|canonicalSkillId|skillRevisionId|packageVersionId/);
  });
});
