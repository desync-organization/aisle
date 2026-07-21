import { describe, expect, it } from "vitest";

import {
  classifySkillCategories,
  mapCategoryHint,
} from "./categories";

describe("catalog category classification", () => {
  it.each([
    ["cybersecurity", ["security"]],
    ["data-ai", ["ai-agents", "data"]],
    ["testing-quality", ["testing"]],
    ["agent-engineering", ["ai-agents"]],
    ["motion-3d", ["frontend"]],
  ])("maps the public hint %s onto the canonical taxonomy", (hint, expected) => {
    expect(mapCategoryHint(hint)).toEqual(expected);
  });

  it("combines only explicit hints and bounded upstream metadata signals", () => {
    expect(
      classifySkillCategories({
        upstreamName: "Playwright quality workflows",
        upstreamDescription: "Testing for a React design system.",
        skillPath: "skills/browser-qa",
        categoryHints: {
          categories: ["Cybersecurity"],
          tags: ["agent-engineering"],
        },
      }),
    ).toEqual(["frontend", "ai-agents", "security", "testing"]);
  });

  it("leaves records without a taxonomy signal uncategorized", () => {
    expect(
      classifySkillCategories({
        upstreamName: "Fixture helper",
        upstreamDescription: "Handles a narrowly described public workflow.",
        skillPath: "skills/fixture-helper",
      }),
    ).toEqual([]);
  });
});
