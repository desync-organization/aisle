import { ArrowLeft, FolderHeart, GitBranch, Link2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";

import { CollectionActions } from "@/components/marketplace/collection-actions";
import { CollectionSkillEditor } from "@/components/marketplace/collection-skill-editor";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { loadPublicCollection } from "@/lib/collections/load";
import { createPageMetadata, siteRelativePath } from "@/lib/seo";

type CollectionPageProps = Readonly<{ params: Promise<{ slug: string }> }>;

export const dynamic = "force-dynamic";
const getPublicCollection = cache(loadPublicCollection);

function sourceName(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl);
    return url.pathname.split("/").filter(Boolean).slice(0, 2).join("/") || url.hostname;
  } catch {
    return "Public upstream";
  }
}

export async function generateMetadata({ params }: CollectionPageProps): Promise<Metadata> {
  const { slug } = await params;
  const collection = await getPublicCollection(slug);
  if (!collection) return {};
  return createPageMetadata({
    title: collection.name,
    description: `${collection.name}: a shared collection of ${collection.skills.length} public Agent Skills.`,
    path: siteRelativePath(`/collections/${collection.slug}`),
  });
}

export default async function CollectionPage({ params }: CollectionPageProps) {
  const { slug } = await params;
  const collection = await getPublicCollection(slug);
  if (!collection) notFound();

  return (
    <div className="site-frame">
      <SiteHeader />
      <main className="shared-collection-page shell">
        <Link className="market-back-link" href="/profile"><ArrowLeft aria-hidden="true" size={15} /> Back to profile</Link>
        <header className="shared-collection-hero">
          <div>
            <Badge tone="iris"><FolderHeart aria-hidden="true" size={12} /> Shared collection</Badge>
            <h1>{collection.name}</h1>
            <p>{collection.skills.length} {collection.skills.length === 1 ? "skill" : "skills"} in this shared collection.</p>
          </div>
          <CollectionActions
            collectionName={collection.name}
            skillIds={collection.skills.map((skill) => skill.id)}
          />
        </header>

        <section aria-labelledby="collection-skills-heading" className="shared-collection-skills">
          <div className="market-section__heading">
            <div>
              <span>Collection / {String(collection.skills.length).padStart(2, "0")}</span>
              <h2 id="collection-skills-heading">Included skills</h2>
            </div>
            <p>Add another skill below, or move the whole collection to your stack.</p>
          </div>
          <CollectionSkillEditor
            collectionId={collection.id}
            collectionSlug={collection.slug}
            initialSkillIds={collection.skills.map((skill) => skill.id)}
          />
          <ol>
            {collection.skills.map((skill) => (
              <li key={skill.id}>
                <span>{String(skill.position).padStart(2, "0")}</span>
                <div>
                  <h3><Link href={`/skills/${encodeURIComponent(skill.id)}`}>{skill.name}</Link></h3>
                  <p>{skill.description || "No upstream description was provided."}</p>
                </div>
                <a href={skill.sourceUrl} rel="noreferrer" target="_blank">
                  <GitBranch aria-hidden="true" size={14} /> {sourceName(skill.sourceUrl)}
                </a>
              </li>
            ))}
          </ol>
        </section>

        <footer className="shared-collection-footer">
          <Link2 aria-hidden="true" size={18} />
          <p>Anyone with this link can view this collection.</p>
        </footer>
      </main>
      <SiteFooter />
    </div>
  );
}
