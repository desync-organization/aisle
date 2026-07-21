import { randomUUID } from "node:crypto";

import { ZodError, type ZodType } from "zod";

import { createCatalogDatabase, type CatalogDatabase } from "@/lib/db/client";
import { CatalogRepository } from "@/lib/db/repository";

import type { ApiFieldIssue } from "./contracts";
import { InvalidCursorError } from "./cursor";
import { ApiError } from "../errors";

const READ_CACHE_CONTROL = "public, max-age=0, s-maxage=30, stale-while-revalidate=120";

function zodFieldIssues(error: ZodError): ApiFieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "query",
    message: issue.message,
  }));
}

function responseHeaders(requestId: string, cacheable: boolean): HeadersInit {
  return {
    "Cache-Control": cacheable ? READ_CACHE_CONTROL : "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Request-Id": requestId,
  };
}

export function parseSearchParams<T>(url: URL, schema: ZodType<T>): T {
  const input: Record<string, string> = {};
  const duplicateIssues: ApiFieldIssue[] = [];

  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1) {
      duplicateIssues.push({ path: key, message: "Query parameters cannot be repeated." });
      continue;
    }
    input[key] = values[0]!;
  }

  if (duplicateIssues.length > 0) {
    throw new ApiError(400, "INVALID_QUERY", "The query parameters are invalid.", duplicateIssues);
  }

  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(
      400,
      "INVALID_QUERY",
      "The query parameters are invalid.",
      zodFieldIssues(result.error),
    );
  }
  return result.data;
}

export function parseRouteParams<T>(input: unknown, schema: ZodType<T>): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(
      400,
      "INVALID_PATH",
      "The route parameters are invalid.",
      zodFieldIssues(result.error),
    );
  }
  return result.data;
}

export async function withCatalogDatabase<T>(
  operation: (
    repository: CatalogRepository,
    database: CatalogDatabase,
  ) => Promise<T>,
): Promise<T> {
  const connection = createCatalogDatabase();
  try {
    return await operation(new CatalogRepository(connection.db), connection.db);
  } finally {
    connection.client.close();
  }
}

export async function handleReadRequest<T>(
  operation: (context: Readonly<{ requestId: string }>) => Promise<
    Readonly<{ data: T; nextCursor?: string | null }>
  >,
): Promise<Response> {
  const requestId = randomUUID();
  try {
    const result = await operation({ requestId });
    return new Response(
      JSON.stringify({
        ok: true,
        data: result.data,
        meta: {
          requestId,
          ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
        },
      }),
      { status: 200, headers: responseHeaders(requestId, true) },
    );
  } catch (error) {
    const apiError =
      error instanceof ApiError
        ? error
        : error instanceof InvalidCursorError
          ? new ApiError(400, "INVALID_CURSOR", error.message, [
              { path: "cursor", message: error.message },
            ])
          : new ApiError(500, "INTERNAL_ERROR", "The request could not be completed.");

    if (apiError.status >= 500) {
      console.error(`[api:${requestId}] read request failed`, error);
    }
    return new Response(
      JSON.stringify({
        ok: false,
        error: {
          code: apiError.code,
          message: apiError.message,
          requestId,
          ...(apiError.fieldIssues ? { fieldIssues: apiError.fieldIssues } : {}),
        },
      }),
      { status: apiError.status, headers: responseHeaders(requestId, false) },
    );
  }
}
