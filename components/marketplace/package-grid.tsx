import { PackageCard } from "@/components/marketplace/package-card";
import type { PackageBlueprint } from "@/lib/packages";

export function PackageGrid({
  packages,
  priorityCount = 0,
}: {
  packages: ReadonlyArray<PackageBlueprint>;
  priorityCount?: number;
}) {
  return (
    <div className="package-grid">
      {packages.map((blueprint, index) => (
        <PackageCard blueprint={blueprint} key={blueprint.slug} priority={index < priorityCount} />
      ))}
    </div>
  );
}
