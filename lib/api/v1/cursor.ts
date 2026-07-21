import { createHash } from "node:crypto";

import { z } from "zod";

const cursorScopeSchema = z.enum(["skills", "packages"]);
const cursorKeyPartSchema = z.union([
  z.string().max(512),
  z.number().finite().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
]);

const cursorPayloadSchema = z.strictObject({
  version: z.literal(1),
  scope: cursorScopeSchema,
  filterHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  key: z.array(cursorKeyPartSchema).min(1).max(4),
  id: z.string().min(1).max(128),
});

const encodedCursorSchema = z.strictObject({
  payload: cursorPayloadSchema,
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
});

export type CursorScope = z.infer<typeof cursorScopeSchema>;
export type CursorKey = readonly (string | number)[];

export class InvalidCursorError extends Error {
  constructor(message = "The pagination cursor is invalid or no longer matches this query.") {
    super(message);
    this.name = "InvalidCursorError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cursorChecksum(payload: z.infer<typeof cursorPayloadSchema>): string {
  return digest(`aisle:api:v1:cursor:${canonicalJson(payload)}`);
}

export function apiFilterHash(value: unknown): string {
  return `sha256:${digest(canonicalJson(value))}`;
}

export function encodeCursor(input: Readonly<{
  scope: CursorScope;
  filterHash: string;
  key: CursorKey;
  id: string;
}>): string {
  const payload = cursorPayloadSchema.parse({
    version: 1,
    scope: input.scope,
    filterHash: input.filterHash,
    key: [...input.key],
    id: input.id,
  });
  return Buffer.from(
    JSON.stringify({ payload, checksum: cursorChecksum(payload) }),
    "utf8",
  ).toString("base64url");
}

export function decodeCursor(
  encoded: string | undefined,
  expected: Readonly<{ scope: CursorScope; filterHash: string }>,
): Readonly<{ key: CursorKey; id: string }> | null {
  if (!encoded) return null;

  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const envelope = encodedCursorSchema.parse(JSON.parse(decoded));
    if (
      envelope.checksum !== cursorChecksum(envelope.payload) ||
      envelope.payload.scope !== expected.scope ||
      envelope.payload.filterHash !== expected.filterHash
    ) {
      throw new InvalidCursorError();
    }
    return { key: envelope.payload.key, id: envelope.payload.id };
  } catch (error) {
    if (error instanceof InvalidCursorError) throw error;
    throw new InvalidCursorError();
  }
}
