import {
  ArrowLeft,
  ArrowUpRight,
  BadgeCheck,
  FileLock2,
  Fingerprint,
  GitBranch,
  Scale,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";

import { ExploreRail } from "@/components/marketplace/explore-rail";
import { SkillSelectionButton } from "@/components/marketplace/skill-selection-button";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { loadMarketplaceSkill } from "@/lib/marketplace/catalog";
import { catalogSelectionGateCopy } from "@/lib/marketplace/selection-gates";
import { catalogSkillIdSchema } from "@/lib/selection";
import { createPageMetadata } from "@/lib/seo";

type SkillPageProps = Readonly<{ params: Promise<{ id: string }> }>;
const getSkill = cache(loadMarketplaceSkill);

export const revalidate = 300;

function sourceIdentity(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl);
    return url.pathname.split("/").filter(Boolean).slice(0, 2).join("/") || url.hostname;
  } catch {
    return "Public upstream";
  }
}

export async function generateMetadata({ params }: SkillPageProps): Promise<Metadata> {
  const { id } = await params;
  if (!catalogSkillIdSchema.safeParse(id).success) return {};
  const snapshot = await getSkill(id);
  if (!snapshot.skill) return createPageMetadata({
    title: "Skill detail",
    description: "See the source, version, license, and trust details for a public Agent Skill.",
    path: `/skills/${encodeURIComponent(id)}`,
  });

  return createPageMetadata({
    title: snapshot.skill.name,
    description: snapshot.skill.description || `Source and trust details for ${snapshot.skill.name}.`,
    path: `/skills/${encodeURIComponent(id)}`,
  });
}

export default async function SkillPage({ params }: SkillPageProps) {
  const { id } = await params;
  if (!catalogSkillIdSchema.safeParse(id).success) notFound();
  const snapshot = await getSkill(id);
  if (snapshot.availability === "empty") notFound();

  const skill = snapshot.skill;
  if (!skill) {
    return (
      <div className="site-frame">
        <SiteHeader />
        <main className="marketplace-shell shell">
          <ExploreRail active="skills" />
          <div className="marketplace-main">
            <Link className="market-back-link" href="/skills"><ArrowLeft aria-hidden="true" size={15} /> Skills explorer</Link>
            <div className="market-empty-state skill-detail-unavailable">
              <span><FileLock2 aria-hidden="true" size={24} /></span>
              <div>
                <p className="eyebrow">Catalog state</p>
                <h1>{snapshot.availability === "not-configured" ? "The catalog isn’t connected." : "This skill isn’t loading right now."}</h1>
                <p>Return to the skills page and try again later.</p>
              </div>
            </div>
          </div>
        </main>
        <SiteFooter />
      </div>
    );
  }

  const source = sourceIdentity(skill.sourceUrl);
  const trustLabel = skill.trustState === "pass"
    ? "Trust checked"
    : skill.trustState === "blocked"
      ? "Trust blocked"
      : skill.trustState === "unreviewed"
        ? "Review pending"
        : "Review warning";

  return (
    <div className="site-frame">
      <SiteHeader />
      <main className="marketplace-shell shell">
        <ExploreRail active="skills" />
        <div className="marketplace-main">
          <Link className="market-back-link" href="/skills"><ArrowLeft aria-hidden="true" size={15} /> Skills explorer</Link>
          <header className="skill-detail-hero">
            <div className="skill-detail-hero__monogram" aria-hidden="true">{skill.name.slice(0, 2).toUpperCase()}</div>
            <div className="skill-detail-hero__copy">
              <Badge tone={skill.trustState === "pass" ? "success" : "iris"}>
                {skill.trustState === "pass"
                  ? <ShieldCheck aria-hidden="true" size={12} />
                  : <TriangleAlert aria-hidden="true" size={12} />} {trustLabel}
              </Badge>
              <h1>{skill.name}</h1>
              <p>{skill.description || "The upstream publisher did not provide a catalog description."}</p>
              <div className="skill-detail-hero__actions">
                <SkillSelectionButton
                  gateReasons={skill.gateReasons}
                  id={skill.id}
                  name={skill.name}
                  selectable={skill.selectable}
                />
                <a className="button button--secondary" href={skill.sourceUrl} rel="noreferrer" target="_blank">
                  View public source <ArrowUpRight aria-hidden="true" size={15} />
                </a>
              </div>
              {!skill.selectable ? (
                <div className="skill-detail-gates" role="note">
                  <strong>You can’t add this skill yet.</strong>
                  <ul>
                    {skill.gateReasons.map((reason) => (
                      <li key={reason}>{catalogSelectionGateCopy[reason]}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            <div className="skill-detail-hero__source">
              <span>Source</span>
              <strong>{source}</strong>
              <code>{skill.skillPath}</code>
            </div>
          </header>

          <section aria-labelledby="skill-provenance" className="skill-detail-section">
            <div className="market-section__heading">
              <div>
                <span>01 / Source details</span>
                <h2 id="skill-provenance">See exactly where this skill came from.</h2>
              </div>
              <p>Aisle keeps the details needed to check this version before install. The instructions stay in the original repository.</p>
            </div>
            <dl className="skill-metadata-grid">
              <div><dt><GitBranch aria-hidden="true" size={15} /> Source</dt><dd>{source}</dd><small>{skill.sourceUrl}</small></div>
              <div><dt><Fingerprint aria-hidden="true" size={15} /> Immutable ref</dt><dd>{skill.immutableRef || "Pending"}</dd><small>Catalog-observed upstream revision</small></div>
              <div><dt><Scale aria-hidden="true" size={15} /> License</dt><dd>{skill.license}</dd><small>License evidence is required for package eligibility</small></div>
              <div><dt><ShieldCheck aria-hidden="true" size={15} /> Trust</dt><dd>{skill.trustState}</dd><small>Current revision assessment</small></div>
              <div><dt><BadgeCheck aria-hidden="true" size={15} /> Provenance</dt><dd>{skill.officialProvenance ? "Official publisher" : "Community publisher"}</dd><small>Provider: {skill.provider}</small></div>
              <div><dt><FileLock2 aria-hidden="true" size={15} /> Lifecycle</dt><dd>{skill.lifecycle}</dd><small>{skill.compatibility || "No compatibility note supplied upstream"}</small></div>
            </dl>
          </section>

          <section className="skill-integrity-panel">
            <div>
              <span>Version details</span>
              <h2>The original skill stays upstream.</h2>
              <p>Aisle stores the source and version details needed to check this skill before install.</p>
            </div>
            <dl>
              <div><dt>Catalog skill ID</dt><dd>{skill.id}</dd></div>
              <div><dt>Revision ID</dt><dd>{skill.revisionId || "Pending"}</dd></div>
              <div><dt>Content hash</dt><dd>{skill.contentHash || "Pending"}</dd></div>
              <div><dt>Skill path</dt><dd>{skill.skillPath}</dd></div>
            </dl>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
