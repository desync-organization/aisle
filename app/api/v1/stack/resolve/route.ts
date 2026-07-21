import { emptyQuerySchema, stackResolveRequestSchema } from "@/lib/api/contracts";
import {
  handleMutationRequest,
  parseJsonBody,
  parseSearchParams,
  withCatalogDatabase,
} from "@/lib/api/v1/http";
import { resolveStackInstallPlan } from "@/lib/api/v1/stack";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleMutationRequest(async () => {
    parseSearchParams(new URL(request.url), emptyQuerySchema);
    const body = await parseJsonBody(request, stackResolveRequestSchema);
    return withCatalogDatabase(async (_repository, database) => ({
      plan: await resolveStackInstallPlan(database, body, {
        github: { signal: request.signal },
      }),
    }));
  });
}
