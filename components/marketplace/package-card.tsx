import { ArrowUpRight, GitBranch, Layers3 } from "lucide-react";
import Link from "next/link";

import { CategoryIcon } from "@/components/marketplace/category-icon";
import type { PackageBlueprint } from "@/lib/packages";

export function PackageCard({ blueprint, priority = false }: { blueprint: PackageBlueprint; priority?: boolean }) {
  const { editorial, members, slug } = blueprint;
  const visibleMembers = members.slice(0, 3);

  return (
    <article
      className={`package-card${priority ? " package-card--priority" : ""}`}
      data-color={editorial.visual.colorToken}
    >
      <div className="package-card__topline">
        <span className="package-card__icon">
          <CategoryIcon size={19} token={editorial.visual.iconToken} />
        </span>
        <span>{editorial.featured ? "Featured" : "Package"}</span>
        <span className="package-card__count">
          <Layers3 aria-hidden="true" size={14} /> {members.length}
        </span>
      </div>
      <div className="package-card__body">
        <p className="package-card__category">{editorial.category.replaceAll("-", " ")}</p>
        <h3>
          <Link href={`/packages/${slug}`} prefetch={false}>{editorial.title}</Link>
        </h3>
        <p>{editorial.summary}</p>
      </div>
      <div aria-label="Included upstream skills" className="package-card__members">
        {visibleMembers.map((member) => (
          <span key={`${member.locator.repositoryUrl}:${member.locator.skillPath}`}>
            {member.locator.upstreamSkillName}
          </span>
        ))}
        {members.length > visibleMembers.length ? <span>+{members.length - visibleMembers.length} more</span> : null}
      </div>
      <div className="package-card__footer">
        <span>
          <GitBranch aria-hidden="true" size={14} /> {members.length} public skills
        </span>
        <Link aria-label={`View ${editorial.title}`} href={`/packages/${slug}`} prefetch={false}>
          View package <ArrowUpRight aria-hidden="true" size={15} />
        </Link>
      </div>
    </article>
  );
}
