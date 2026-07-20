import { createHash } from "node:crypto";

export interface ArtifactTextInput {
  path: string;
  contents: string;
}

export interface ArtifactInventoryInput {
  path: string;
  type: string;
  mode?: string;
  size?: number;
  sha?: string;
}

export function createTextArtifactInventory(
  files: readonly ArtifactTextInput[],
): ArtifactInventoryInput[] {
  return files.map((file) => ({
    path: file.path,
    type: "file",
    size: Buffer.byteLength(file.contents, "utf8"),
    sha: createHash("sha256").update(file.contents).digest("hex"),
  }));
}

export function normalizeArtifactFilePath(value: string): string {
  let path = value;
  for (let depth = 0; depth < 4; depth += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      throw new Error("Artifact path contains invalid percent encoding");
    }
    if (decoded === path) break;
    path = decoded;
    if (depth === 3 && /%[0-9a-f]{2}/i.test(path)) {
      throw new Error("Artifact path exceeds the supported encoding depth");
    }
  }
  path = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !path ||
    /%[0-9a-f]{2}|[\u0000-\u001f\u007f]/i.test(path) ||
    path.startsWith("/") ||
    /^[a-z]:/i.test(path) ||
    path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Artifact path is not a safe canonical relative path");
  }
  return path;
}

/**
 * Revision trust is scoped to the exact UTF-8 text bytes Aisle scanned. The
 * provider's revision identifier remains provenance; it is never reused as
 * this local assessment fingerprint.
 */
export function computeScannedTextHash(files: readonly ArtifactTextInput[]): string {
  if (files.length === 0) {
    throw new Error("At least one scanned text file is required for an artifact fingerprint");
  }

  const paths = new Set<string>();
  const inventory = files.map((file) => {
    const path = normalizeArtifactFilePath(file.path);
    if (!path || paths.has(path)) {
      throw new Error(`Artifact inventory contains an empty or duplicate path: ${path}`);
    }
    paths.add(path);
    const sha256 = createHash("sha256").update(file.contents).digest("hex");
    return { path, sha256 };
  });
  inventory.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  return createHash("sha256")
    .update(inventory.map(({ path, sha256 }) => `${path.length}:${path}\0${sha256}`).join("\n"))
    .digest("hex");
}

/** Hashes the complete installed inventory, including verified non-text bytes. */
export function computeArtifactContentHash(files: readonly ArtifactInventoryInput[]): string {
  if (files.length === 0) {
    throw new Error("At least one verified file is required for an artifact fingerprint");
  }
  const paths = new Set<string>();
  const inventory = files.map((file) => {
    const path = normalizeArtifactFilePath(file.path);
    if (paths.has(path)) throw new Error(`Artifact inventory contains duplicate path ${path}`);
    paths.add(path);
    const type = file.type.trim().toLowerCase();
    const mode = file.mode?.trim() ?? "";
    if (!type) throw new Error(`Artifact inventory type is missing for ${path}`);
    if (!Number.isSafeInteger(file.size) || file.size! < 0) {
      throw new Error(`Artifact inventory size is unverified for ${path}`);
    }
    const sha256 = file.sha?.trim().toLowerCase().replace(/^sha256:/, "") ?? "";
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`Artifact inventory SHA-256 is unverified for ${path}`);
    }
    return { path, type, mode, size: file.size!, sha256 };
  });
  inventory.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return createHash("sha256")
    .update(
      inventory
        .map(({ path, type, mode, size, sha256 }) =>
          `${path.length}:${path}\0${type.length}:${type}\0${mode.length}:${mode}\0${size}\0${sha256}`,
        )
        .join("\n"),
    )
    .digest("hex");
}
