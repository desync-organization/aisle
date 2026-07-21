import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const excludedDirectories = new Set([".git", ".next", "coverage", "node_modules"]);

function trackedSurfaceFiles(directory: string, root = directory): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) return [];

    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) return trackedSurfaceFiles(absolutePath, root);

    return [relative(root, absolutePath).replaceAll("\\", "/")];
  });
}

describe("public-only repository policy", () => {
  it("contains no authored Agent Skill payloads", () => {
    const skillFiles = trackedSurfaceFiles(process.cwd()).filter(
      (file) => file === "SKILL.md" || file.endsWith("/SKILL.md"),
    );

    expect(skillFiles).toEqual([]);
  });

  it("documents the fail-closed package and selection boundary", () => {
    const policy = readFileSync(
      join(process.cwd(), "docs", "architecture", "public-catalog-policy.md"),
      "utf8",
    );

    expect(policy).toContain("does not author, generate, synthesize, rewrite");
    expect(policy).toContain("Public does not mean safe");
    expect(policy).toContain("Package manifests contain only canonical skill and revision references");
    expect(policy).toContain("fail closed for installation");
    expect(policy).toContain("blocked until baseline validation passes");
    expect(policy).toContain("passed baseline validation and an Aisle assessment of `pass` or `warn`");
    expect(policy).toContain("`warn` also requires explicit acknowledgement");
  });

  it("keeps the mobile shell inset inside the viewport", () => {
    const styles = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");

    expect(styles).toContain("--shell: min(calc(100% - 28px), 1180px)");
    expect(styles).not.toContain("--shell: min(100% - 28px, 1180px)");
  });
});
