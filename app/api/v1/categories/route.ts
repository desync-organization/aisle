import { emptyQuerySchema } from "@/lib/api/contracts";
import { listPublicCategories } from "@/lib/api/v1/catalog";
import {
  handleReadRequest,
  parseSearchParams,
  withCatalogDatabase,
} from "@/lib/api/v1/http";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleReadRequest(async () => {
    parseSearchParams(new URL(request.url), emptyQuerySchema);
    return withCatalogDatabase(async (_repository, database) => ({
      data: { items: await listPublicCategories(database) },
    }));
  });
}
