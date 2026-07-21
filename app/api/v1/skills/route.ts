import { skillsQuerySchema } from "@/lib/api/contracts";
import { listPublicSkills } from "@/lib/api/v1/catalog";
import {
  handleReadRequest,
  parseSearchParams,
  withCatalogDatabase,
} from "@/lib/api/v1/http";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleReadRequest(async () => {
    const query = parseSearchParams(new URL(request.url), skillsQuerySchema);
    return withCatalogDatabase(async (_repository, database) => {
      const result = await listPublicSkills(database, query);
      return { data: { items: result.items }, nextCursor: result.nextCursor };
    });
  });
}
