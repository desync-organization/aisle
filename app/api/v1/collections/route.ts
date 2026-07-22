import { createCollectionBodySchema } from "@/lib/collections/contracts";
import { createAnonymousCollection } from "@/lib/collections/repository";
import {
  handleMutationRequest,
  parseJsonBody,
  withCatalogDatabase,
} from "@/lib/api/v1/http";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleMutationRequest(async () => {
    const input = await parseJsonBody(request, createCollectionBodySchema);
    return withCatalogDatabase(async (_repository, database) => {
      const result = await createAnonymousCollection(database, input);
      return {
        data: {
          collection: result.collection,
          sharePath: `/collections/${result.collection.slug}`,
        },
        ownerToken: result.ownerToken,
      };
    });
  });
}
