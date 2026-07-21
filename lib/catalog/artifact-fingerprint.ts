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

export interface PersistedFileInventoryEntry {
  path: string;
  type: string;
  mode: string;
  size: number;
  sha256: string;
}

export interface PersistedFileInventory {
  schemaVersion: 1;
  complete: boolean;
  fileCount: number;
  listedFileCount: number;
  totalBytes: number;
  regularFileCount: number;
  binaryFileCount: number;
  executableFileCount: number;
  otherFileCount: number;
  aggregateSha256: string;
  truncated: boolean;
  files: PersistedFileInventoryEntry[];
}

export const PERSISTED_FILE_INVENTORY_ENTRY_LIMIT = 256;
export const PERSISTED_FILE_INVENTORY_BYTE_LIMIT = 65_536;

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

function normalizeVerifiedInventory(
  files: readonly ArtifactInventoryInput[],
): PersistedFileInventoryEntry[] {
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
    if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(type)) {
      throw new Error(`Artifact inventory type is invalid for ${path}`);
    }
    if (mode && !/^[0-7]{5,6}$/.test(mode)) {
      throw new Error(`Artifact inventory mode is invalid for ${path}`);
    }
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
  return inventory;
}

function hashNormalizedInventory(files: readonly PersistedFileInventoryEntry[]): string {
  return createHash("sha256")
    .update(
      files
        .map(({ path, type, mode, size, sha256 }) =>
          `${path.length}:${path}\0${type.length}:${type}\0${mode.length}:${mode}\0${size}\0${sha256}`,
        )
        .join("\n"),
    )
    .digest("hex");
}

/** Hashes the complete installed inventory, including verified non-text bytes. */
export function computeArtifactContentHash(files: readonly ArtifactInventoryInput[]): string {
  return hashNormalizedInventory(normalizeVerifiedInventory(files));
}

export function createPersistedFileInventory(
  artifact: { complete: boolean; files?: readonly ArtifactInventoryInput[] },
  expectedContentHash: string,
  options: { maxEntries?: number; maxEntriesBytes?: number } = {},
): PersistedFileInventory {
  if (!artifact.complete) {
    throw new Error("Cannot persist an incomplete artifact inventory");
  }
  const inventory = normalizeVerifiedInventory(artifact.files ?? []);
  const aggregateSha256 = hashNormalizedInventory(inventory);
  const normalizedExpectedHash = expectedContentHash.trim().toLowerCase().replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(normalizedExpectedHash) || aggregateSha256 !== normalizedExpectedHash) {
    throw new Error("Persisted file inventory did not match the validated content hash");
  }

  const maxEntries = options.maxEntries ?? PERSISTED_FILE_INVENTORY_ENTRY_LIMIT;
  const maxEntriesBytes = options.maxEntriesBytes ?? PERSISTED_FILE_INVENTORY_BYTE_LIMIT;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error("Persisted file inventory entry limit must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxEntriesBytes) || maxEntriesBytes < 2) {
    throw new Error("Persisted file inventory byte limit must be at least two bytes");
  }

  let totalBytes = 0;
  let regularFileCount = 0;
  let binaryFileCount = 0;
  let executableFileCount = 0;
  const files: PersistedFileInventoryEntry[] = [];
  let serializedBytes = 2;
  let truncated = false;
  for (const file of inventory) {
    totalBytes += file.size;
    if (!Number.isSafeInteger(totalBytes)) {
      throw new Error("Artifact inventory aggregate size exceeds the safe integer range");
    }
    if (file.type === "file") regularFileCount += 1;
    if (file.type === "binary") binaryFileCount += 1;
    if (/^1007(?:00|55)$/.test(file.mode)) executableFileCount += 1;

    const entryBytes = Buffer.byteLength(JSON.stringify(file), "utf8") + (files.length ? 1 : 0);
    if (files.length >= maxEntries || serializedBytes + entryBytes > maxEntriesBytes) {
      truncated = true;
      continue;
    }
    files.push(file);
    serializedBytes += entryBytes;
  }

  return {
    schemaVersion: 1,
    complete: artifact.complete,
    fileCount: inventory.length,
    listedFileCount: files.length,
    totalBytes,
    regularFileCount,
    binaryFileCount,
    executableFileCount,
    otherFileCount: inventory.length - regularFileCount - binaryFileCount,
    aggregateSha256,
    truncated,
    files,
  };
}
