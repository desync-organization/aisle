// @vitest-environment node

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  computeArtifactContentHash,
  createPersistedFileInventory,
  type ArtifactInventoryInput,
} from "./artifact-fingerprint";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("persisted artifact inventory", () => {
  it("summarizes normalized text, binary, and executable entries without body content", () => {
    const files: ArtifactInventoryInput[] = [
      {
        path: "scripts\\run.ts",
        type: " FILE ",
        mode: "100755",
        size: 19,
        sha: `sha256:${sha256("export const run = 1")}`,
      },
      {
        path: "assets/tool.bin",
        type: "BINARY",
        mode: "100644",
        size: 4,
        sha: sha256("\u0000\u0001\u0002\u0003"),
      },
      {
        path: "SKILL.md",
        type: "file",
        mode: "100644",
        size: 18,
        sha: sha256("BODY_SECRET_MARKER"),
      },
    ];
    const contentHash = computeArtifactContentHash(files);
    const artifact = {
      complete: true,
      contents: "BODY_SECRET_MARKER",
      textFiles: [{ path: "SKILL.md", contents: "BODY_SECRET_MARKER" }],
      files,
    };

    const summary = createPersistedFileInventory(artifact, contentHash);

    expect(summary).toMatchObject({
      schemaVersion: 1,
      complete: true,
      fileCount: 3,
      listedFileCount: 3,
      totalBytes: 41,
      regularFileCount: 2,
      binaryFileCount: 1,
      executableFileCount: 1,
      otherFileCount: 0,
      aggregateSha256: contentHash,
      truncated: false,
    });
    expect(summary.files).toEqual([
      expect.objectContaining({ path: "SKILL.md", type: "file", mode: "100644" }),
      expect.objectContaining({ path: "assets/tool.bin", type: "binary", mode: "100644" }),
      expect.objectContaining({ path: "scripts/run.ts", type: "file", mode: "100755" }),
    ]);
    expect(JSON.stringify(summary)).not.toContain("BODY_SECRET_MARKER");
    expect(JSON.stringify(summary)).not.toContain("contents");
  });

  it("rejects malformed inventory fields before they can become revision metadata", () => {
    const valid = { type: "file", mode: "100644", size: 0, sha: sha256("") };
    expect(() => computeArtifactContentHash([{ ...valid, path: "../SKILL.md" }])).toThrow(
      /safe canonical relative path/,
    );
    expect(() => computeArtifactContentHash([{ ...valid, path: "SKILL.md", type: "file body" }]))
      .toThrow(/type is invalid/);
    expect(() => computeArtifactContentHash([{ ...valid, path: "SKILL.md", mode: "755" }]))
      .toThrow(/mode is invalid/);
  });

  it("truncates bounded display entries while retaining full counts, bytes, and aggregate hash", () => {
    const files = Array.from({ length: 5 }, (_, index) => ({
      path: `files/${index}.txt`,
      type: "file",
      mode: "100644",
      size: index + 1,
      sha: sha256(`file-${index}`),
    }));
    const contentHash = computeArtifactContentHash(files);
    const limited = createPersistedFileInventory(
      { complete: true, files },
      contentHash,
      { maxEntries: 2, maxEntriesBytes: 65_536 },
    );

    expect(limited).toMatchObject({
      fileCount: 5,
      listedFileCount: 2,
      totalBytes: 15,
      aggregateSha256: contentHash,
      truncated: true,
    });
    expect(limited.files.map((file) => file.path)).toEqual(["files/0.txt", "files/1.txt"]);

    const byteLimited = createPersistedFileInventory(
      { complete: true, files },
      contentHash,
      { maxEntries: 5, maxEntriesBytes: 32 },
    );
    expect(byteLimited).toMatchObject({
      fileCount: 5,
      listedFileCount: 0,
      aggregateSha256: contentHash,
      truncated: true,
      files: [],
    });
  });
});
