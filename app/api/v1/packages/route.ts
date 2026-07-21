import { packagesQuerySchema } from "@/lib/api/contracts";
import { listPublicPackages } from "@/lib/api/v1/catalog";
import {
  handleReadRequest,
  parseSearchParams,
  withCatalogDatabase,
} from "@/lib/api/v1/http";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleReadRequest(async () => {
    const query = parseSearchParams(new URL(request.url), packagesQuerySchema);
    return withCatalogDatabase(async (repository) => {
      const result = await listPublicPackages(repository, query);
      return { data: { items: result.items }, nextCursor: result.nextCursor };
    });
  });
}
