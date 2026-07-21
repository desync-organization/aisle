import { packageDetailQuerySchema, packageSlugParamsSchema } from "@/lib/api/contracts";
import { ApiError } from "@/lib/api/errors";
import { getPublicPackage } from "@/lib/api/v1/catalog";
import {
  handleReadRequest,
  parseRouteParams,
  parseSearchParams,
  withCatalogDatabase,
} from "@/lib/api/v1/http";

export const runtime = "nodejs";

type PackageRouteContext = Readonly<{ params: Promise<{ slug: string }> }>;

export async function GET(request: Request, context: PackageRouteContext): Promise<Response> {
  return handleReadRequest(async () => {
    const { slug } = parseRouteParams(await context.params, packageSlugParamsSchema);
    const query = parseSearchParams(new URL(request.url), packageDetailQuerySchema);
    return withCatalogDatabase(async (repository) => {
      const packageDetails = await getPublicPackage(repository, slug, query.version);
      if (!packageDetails) {
        throw new ApiError(404, "PACKAGE_NOT_FOUND", "The published package was not found.");
      }
      return { data: packageDetails };
    });
  });
}
