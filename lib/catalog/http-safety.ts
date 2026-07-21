interface CancelableResource {
  cancel(reason?: unknown): unknown;
}

/**
 * Starts disposal without trusting a remote stream's cancellation promise to
 * settle. Synchronous throws and asynchronous rejections are intentionally
 * swallowed because this helper is used only after the response is discarded.
 */
export function cancelBestEffort(
  resource: CancelableResource | null | undefined,
  reason?: unknown,
): void {
  if (!resource) return;
  try {
    void Promise.resolve(resource.cancel(reason)).catch(() => undefined);
  } catch {
    // A hostile or non-standard stream must not block the caller's failure path.
  }
}

export async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    cancelBestEffort(response.body, "response size limit exceeded");
    throw new Error(`Response exceeds the ${maximumBytes}-byte limit`);
  }
  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        cancelBestEffort(reader, "response size limit exceeded");
        throw new Error(`Response exceeds the ${maximumBytes}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function requestTimeout(milliseconds = 15_000): AbortSignal {
  return AbortSignal.timeout(milliseconds);
}
