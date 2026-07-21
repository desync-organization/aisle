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
        providerName: "Playwright quality workflows",
        providerDescription: "A public marketplace summary.",
        frontmatterName: "browser-qa",
        frontmatterDescription: "Testing for React components in a design system.",
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
        providerName: "Fixture helper",
        providerDescription: "Handles a narrowly described public workflow.",
        frontmatterName: "fixture-helper",
        frontmatterDescription: "Handles one inert workflow.",
        skillPath: "skills/fixture-helper",
      }),
    ).toEqual([]);
  });

  it("does not promote ambiguous single words from free text", () => {
    expect(
      classifySkillCategories({
        providerName: "React to incidents",
        providerDescription: "Summarizes an API document for a meeting.",
        frontmatterName: "incident-summary",
        frontmatterDescription: "Produces a concise meeting summary.",
        skillPath: "skills/incident-summary",
      }),
    ).toEqual([]);
  });
});
