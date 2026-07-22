import { ApiError } from "@/lib/api/errors";
import { getPublicSkill } from "@/lib/api/v1/catalog";
import {
  handleMutationRequest,
  parseJsonBody,
  parseRouteParams,
  withCatalogDatabase,
} from "@/lib/api/v1/http";
import {
  addCollectionMemberBodySchema,
  collectionSlugParamsSchema,
} from "@/lib/collections/contracts";
import { addSkillToAnonymousCollection } from "@/lib/collections/repository";

export const runtime = "nodejs";

type CollectionMembersRouteContext = Readonly<{
  params: Promise<{ slug: string }>;
}>;

function ownerTokenFrom(request: Request): string {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/iu);
  if (!match?.[1]) {
    throw new ApiError(
      401,
      "COLLECTION_OWNER_TOKEN_REQUIRED",
      "This collection needs its private owner key before it can be edited.",
    );
  }
  return match[1];
}

export async function POST(
  request: Request,
  context: CollectionMembersRouteContext,
): Promise<Response> {
  return handleMutationRequest(async () => {
    const token = ownerTokenFrom(request);
    const { slug } = parseRouteParams(await context.params, collectionSlugParamsSchema);
    const input = await parseJsonBody(request, addCollectionMemberBodySchema);

    return withCatalogDatabase(async (_repository, database) => {
      const skill = await getPublicSkill(database, input.skillId);
      if (!skill?.selection.selectable) {
        throw new ApiError(
          409,
          "COLLECTION_SKILL_UNAVAILABLE",
          "This skill cannot be added from the public catalog right now.",
          [{ path: "skillId", message: `${input.skillId} is not currently selectable.` }],
        );
      }
      const result = await addSkillToAnonymousCollection(database, slug, token, input);
      return {
        data: {
          collection: result.collection,
          added: result.added,
        },
      };
    });
  });
}
