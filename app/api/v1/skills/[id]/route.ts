import { emptyQuerySchema, skillIdParamsSchema } from "@/lib/api/contracts";
import { ApiError } from "@/lib/api/errors";
import { getPublicSkill } from "@/lib/api/v1/catalog";
import {
  handleReadRequest,
  parseRouteParams,
  parseSearchParams,
  withCatalogDatabase,
} from "@/lib/api/v1/http";

export const runtime = "nodejs";

type SkillRouteContext = Readonly<{ params: Promise<{ id: string }> }>;

export async function GET(request: Request, context: SkillRouteContext): Promise<Response> {
  return handleReadRequest(async () => {
    parseSearchParams(new URL(request.url), emptyQuerySchema);
    const { id } = parseRouteParams(await context.params, skillIdParamsSchema);
    return withCatalogDatabase(async (_repository, database) => {
      const skill = await getPublicSkill(database, id);
      if (!skill) throw new ApiError(404, "SKILL_NOT_FOUND", "The public skill was not found.");
      return { data: skill };
    });
  });
}
