import { emptyQuerySchema, stackPreflightRequestSchema } from "@/lib/api/contracts";
import {
  handleMutationRequest,
  parseJsonBody,
  parseSearchParams,
  withCatalogDatabase,
} from "@/lib/api/v1/http";
import { preflightStackSelections } from "@/lib/api/v1/stack";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleMutationRequest(async () => {
    parseSearchParams(new URL(request.url), emptyQuerySchema);
    const body = await parseJsonBody(request, stackPreflightRequestSchema);
    return withCatalogDatabase(async (_repository, database) => ({
      rows: await preflightStackSelections(database, body),
    }));
  });
}
