import { ArrowLeft, ArrowUpRight, CalendarDays, Check, GitBranch, ShieldCheck, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CategoryIcon } from "@/components/marketplace/category-icon";
import { ExploreRail } from "@/components/marketplace/explore-rail";
import { PackageSelection } from "@/components/marketplace/package-selection";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { getCatalogCategoryForEditorial } from "@/lib/marketplace/categories";
import { loadResolvedPackage } from "@/lib/marketplace/catalog";
import { getLaunchPackageBlueprint } from "@/lib/packages";
import { createPageMetadata } from "@/lib/seo";

type PackagePageProps = Readonly<{ params: Promise<{ slug: string }> }>;

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PackagePageProps): Promise<Metadata> {
  const { slug } = await params;
  const blueprint = getLaunchPackageBlueprint(slug);
  if (!blueprint) return {};
  return createPageMetadata({
    title: blueprint.editorial.title,
    description: blueprint.editorial.summary,
    path: `/packages/${slug}`,
  });
}

function sourceSnapshotUrl(repositoryUrl: string, skillPath: string, headSha?: string): string {
  return headSha ? `${repositoryUrl}/blob/${headSha}/${skillPath}` : repositoryUrl;
}

export default async function PackagePage({ params }: PackagePageProps) {
  const { slug } = await params;
  const blueprint = getLaunchPackageBlueprint(slug);
  if (!blueprint) notFound();

  const resolved = await loadResolvedPackage(blueprint);
  const category = getCatalogCategoryForEditorial(blueprint.editorial.category);
  const resolvedByPosition = new Map(resolved.members.map((member) => [member.position, member]));
  return (
    <div className="site-frame">
      <SiteHeader />
      <main className="marketplace-shell shell">
        <ExploreRail active="packages" />
        <div className="marketplace-main">
          <Link className="market-back-link" href="/packages"><ArrowLeft aria-hidden="true" size={15} /> All packages</Link>
          <header className="package-detail-hero" data-color={blueprint.editorial.visual.colorToken}>
            <div className="package-detail-hero__icon">
              <CategoryIcon size={30} token={blueprint.editorial.visual.iconToken} />
            </div>
            <div className="package-detail-hero__copy">
              <Badge tone="iris">Skill package</Badge>
              <h1>{blueprint.editorial.title}</h1>
              <p>{blueprint.editorial.summary}</p>
              <div className="package-detail-hero__tags">
                {blueprint.editorial.tags.map((tag) => <span key={tag}>{tag}</span>)}
              </div>
            </div>
            <dl className="package-detail-hero__facts">
              <div><dt><Users aria-hidden="true" size={14} /> Built for</dt><dd>{blueprint.editorial.audience.join(" · ")}</dd></div>
              <div><dt><CalendarDays aria-hidden="true" size={14} /> Reviewed</dt><dd>{blueprint.editorial.reviewedAt}</dd></div>
              <div><dt><ShieldCheck aria-hidden="true" size={14} /> Source</dt><dd>Public skills only</dd></div>
            </dl>
          </header>

          <PackageSelection
            availability={resolved.availability}
            binding={resolved.binding}
            expectedBlueprintDigest={resolved.expectedBlueprintDigest}
            expectedBlueprintSchemaVersion={blueprint.schemaVersion}
            memberCount={blueprint.members.length}
            members={resolved.availability === "resolved" ? resolved.members : []}
            mismatchReasons={resolved.mismatchReasons}
            packageSlug={blueprint.slug}
          />

          <section aria-labelledby="package-outcome" className="package-outcome">
            <span>What this helps with</span>
            <h2 id="package-outcome">{blueprint.editorial.outcome}</h2>
            <Link href={`/categories/${category.slug}`}>Explore {category.shortName} <ArrowUpRight aria-hidden="true" size={15} /></Link>
          </section>

          <section aria-labelledby="package-members" className="package-members-section">
            <div className="market-section__heading">
              <div>
                <span>Includes / {String(blueprint.members.length).padStart(2, "0")} skills</span>
                <h2 id="package-members">What’s included.</h2>
              </div>
              <p>Skill details come from the original sources. The notes explain why each one is here.</p>
            </div>
            <ol className="package-member-list">
              {blueprint.members.map((member) => {
                const resolvedMember = resolved.availability === "resolved"
                  ? resolvedByPosition.get(member.position)
                  : undefined;
                const snapshotUrl = sourceSnapshotUrl(
                  member.locator.repositoryUrl,
                  member.locator.skillPath,
                  member.observedSource?.headSha,
                );

                return (
                  <li key={`${member.locator.repositoryUrl}:${member.locator.skillPath}`}>
                    <span className="package-member-list__position">{String(member.position).padStart(2, "0")}</span>
                    <div className="package-member-list__identity">
                      <div>
                        <h3>{member.locator.upstreamSkillName}</h3>
                        <span>{member.locator.owner}/{member.locator.repository}</span>
                      </div>
                      <p>{member.rationale}</p>
                    </div>
                    <dl>
                      <div><dt>License</dt><dd>{member.observedLicense.spdx}</dd></div>
                      <div><dt>Publisher</dt><dd>{member.publisherClass}</dd></div>
                      <div><dt>Revision</dt><dd>{member.observedSource?.headSha.slice(0, 8) ?? "Not observed"}</dd></div>
                    </dl>
                    <div className="package-member-list__actions">
                      {resolvedMember
                        ? <span className="member-ready"><Check aria-hidden="true" size={13} /> Ready</span>
                        : <span>{resolved.availability === "binding-mismatch" ? "Needs review" : "Not ready yet"}</span>}
                      <a href={snapshotUrl} rel="noreferrer" target="_blank">
                        <GitBranch aria-hidden="true" size={14} /> View source <ArrowUpRight aria-hidden="true" size={13} />
                      </a>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
