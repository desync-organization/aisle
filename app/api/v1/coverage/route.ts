import { emptyQuerySchema } from "@/lib/api/contracts";
import { publicCoverage } from "@/lib/api/v1/catalog";
import {
  handleReadRequest,
  parseSearchParams,
  withCatalogDatabase,
} from "@/lib/api/v1/http";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleReadRequest(async () => {
    parseSearchParams(new URL(request.url), emptyQuerySchema);
    return withCatalogDatabase(async (repository) => ({
      data: await publicCoverage(repository),
    }));
  });
}
