import { createCatalogDatabase } from "../lib/db/client";
import { migrateCatalogDatabase } from "../lib/db/migrate";
import { CatalogRepository, PackagePublicationError } from "../lib/db/repository";
import {
  getLaunchPackageBlueprint,
  launchPackageBlueprints,
} from "../lib/packages/launch-blueprints";

function requestedBlueprints() {
  const requestedSlugs = [...new Set(process.argv.slice(2))];
  if (requestedSlugs.length === 0) return launchPackageBlueprints;
  return requestedSlugs.map((slug) => {
    const blueprint = getLaunchPackageBlueprint(slug);
    if (!blueprint) throw new Error(`Unknown launch package blueprint: ${slug}`);
    return blueprint;
  });
}

async function main(): Promise<void> {
  const connection = createCatalogDatabase();
  try {
    await migrateCatalogDatabase(connection.client);
    const repository = new CatalogRepository(connection.db);
    const published = await repository.publishPackageBlueprintSet(requestedBlueprints());
    console.log(JSON.stringify({ published }, null, 2));
  } finally {
    connection.client.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof PackagePublicationError) {
    console.error(
      JSON.stringify({
        error: {
          code: error.code,
          packageSlug: error.packageSlug,
          memberPosition: error.memberPosition,
          message: error.message,
        },
      }),
    );
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
