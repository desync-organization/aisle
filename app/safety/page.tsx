import {
  ArrowRight,
  BadgeCheck,
  Ban,
  Check,
  CircleHelp,
  CircleSlash2,
  FileSearch,
  GitCommitHorizontal,
  ScanLine,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import type { Metadata } from "next";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Safety and trust",
  description: "How Aisle reviews skill revisions and decides whether they can be installed.",
  path: "/safety",
});

const trustLabels = [
  {
    label: "Official",
    icon: BadgeCheck,
    tone: "identity",
    meaning: "The publisher identity was verified as the organization responsible for the referenced product. This is not a security audit.",
    gate: "Not sufficient on its own",
  },
  {
    label: "Audited / no known findings",
    icon: ScanLine,
    tone: "clear",
    meaning: "The named scanners reported no findings for this exact revision. This is a limited review, not a guarantee of safety.",
    gate: "Allowed",
  },
  {
    label: "Warning",
    icon: TriangleAlert,
    tone: "warning",
    meaning: "Review found behavior, permissions, or capabilities that require explicit user attention before installation.",
    gate: "Requires acknowledgement",
  },
  {
    label: "Unreviewed",
    icon: CircleHelp,
    tone: "neutral",
    meaning: "Aisle has no current assessment for this exact revision. The skill stays visible, but results from older revisions do not apply.",
    gate: "Blocked until baseline validation passes",
  },
  {
    label: "Failed",
    icon: CircleSlash2,
    tone: "blocked",
    meaning: "A scanner or review found a high-confidence dangerous condition in this revision.",
    gate: "Blocked",
  },
  {
    label: "Quarantined",
    icon: Ban,
    tone: "blocked",
    meaning: "Aisle blocked the revision pending investigation or because of a confirmed catalog policy violation.",
    gate: "Blocked",
  },
] as const;

const inspectItems = [
  "Canonical source and publisher identity",
  "Exact revision, version, or content digest",
  "File inventory and executable resources",
  "Declared compatibility and tool access",
  "License or a clearly marked unknown state",
  "Scanner name, review time, and full findings",
] as const;

const installChecklist = [
  "Open the upstream source; confirm it is the project and publisher you intended.",
  "Read the instructions and inspect scripts, references, assets, and dependency setup.",
  "Check the pinned revision instead of relying on a moving branch name.",
  "Prefer project scope unless you intentionally want the skill available everywhere.",
  "Review the generated command, destination agents, and any prompt-skipping flags.",
  "Run unfamiliar code with the least filesystem, network, credential, and tool access it needs.",
] as const;

export default function SafetyPage() {
  return (
    <div className="site-frame">
      <SiteHeader />
      <main className="editorial-page shell">
        <header className="editorial-hero">
          <div className="editorial-hero__copy">
            <Badge tone="iris">Safety · Before you install</Badge>
            <h1>Check every skill before you install it</h1>
            <p>
              Skills can change how an agent behaves, what files it reads, and which code it runs. Aisle shows publisher identity, review results, and installation status separately. Check all three.
            </p>
            <div className="editorial-hero__actions">
              <ButtonLink href="#labels">
                Read the labels <ArrowRight aria-hidden="true" size={16} />
              </ButtonLink>
              <ButtonLink href="/docs/public-catalog-policy" variant="secondary">
                Catalog policy
              </ButtonLink>
            </div>
          </div>
          <aside className="editorial-hero__note editorial-hero__note--danger" aria-label="Core safety rule">
            <span>IMPORTANT</span>
            <strong>Public does not mean safe.</strong>
            <p>
              “Official” confirms identity. “No known findings” reports a review result. Neither is permission to skip your own inspection.
            </p>
          </aside>
        </header>

        <section aria-labelledby="risk-heading" className="risk-primer">
          <ShieldAlert aria-hidden="true" size={25} />
          <div>
            <span className="eyebrow">Treat skills as code and instructions</span>
            <h2 id="risk-heading">Skills can include instructions and executable files.</h2>
            <p>
              A malicious or careless skill can request secrets, modify files, contact networks, install dependencies, or steer an agent toward unsafe actions. Read the entire upstream folder, not only its description.
            </p>
          </div>
        </section>

        <section className="docs-section safety-section" id="labels">
          <div className="docs-section__heading">
            <span>01 / LABELS</span>
            <div>
              <h2>What each trust label means</h2>
              <p>
                Every review result belongs to an immutable revision. When upstream content changes, the new revision returns to Unreviewed until it is assessed.
              </p>
            </div>
          </div>
          <div
            aria-label="Trust label table, horizontally scrollable"
            className="trust-table-shell"
            role="region"
            tabIndex={0}
          >
            <table className="trust-table">
              <caption className="sr-only">Aisle trust labels, meanings, and default install behavior</caption>
              <thead>
                <tr>
                  <th scope="col">Label</th>
                  <th scope="col">What it means</th>
                  <th scope="col">Default install gate</th>
                </tr>
              </thead>
              <tbody>
                {trustLabels.map(({ gate, icon: Icon, label, meaning, tone }) => (
                  <tr key={label}>
                    <th scope="row">
                      <span className="trust-label" data-tone={tone}>
                        <Icon aria-hidden="true" size={16} /> {label}
                      </span>
                    </th>
                    <td>{meaning}</td>
                    <td>{gate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="docs-section safety-section">
          <div className="docs-section__heading">
            <span>02 / EVIDENCE</span>
            <div>
              <h2>Check the source behind the label</h2>
              <p>
                The skill page shows the public source and exact revision before installation. Missing information stays marked as unknown.
              </p>
            </div>
          </div>
          <div className="safety-split">
            <article className="inspection-card">
              <FileSearch aria-hidden="true" size={20} />
              <span>WHAT TO CHECK</span>
              <ul>
                {inspectItems.map((item) => (
                  <li key={item}><Check aria-hidden="true" size={14} /> {item}</li>
                ))}
              </ul>
            </article>
            <article className="revision-card">
              <GitCommitHorizontal aria-hidden="true" size={21} />
              <span>REVIEW HISTORY</span>
              <ol>
                <li><strong>Source found</strong><small>Public source and immutable revision confirmed</small></li>
                <li><strong>Unreviewed</strong><small>No current revision-scoped result yet</small></li>
                <li><strong>Review recorded</strong><small>Named checks and findings remain attached to this revision</small></li>
                <li><strong>Upstream changes</strong><small>A new revision starts again as Unreviewed</small></li>
              </ol>
            </article>
          </div>
        </section>

        <section className="docs-section safety-section" id="checklist">
          <div className="docs-section__heading">
            <span>03 / BEFORE RUN</span>
            <div>
              <h2>Before you run the command</h2>
              <p>
                Aisle’s review helps, but only you know what access is appropriate for your repository, credentials, and machine.
              </p>
            </div>
          </div>
          <ol className="install-checklist">
            {installChecklist.map((item, index) => (
              <li key={item}>
                <span>0{index + 1}</span>
                <p>{item}</p>
              </li>
            ))}
          </ol>
          <div className="safety-actions">
            <ButtonLink href="/docs#installing">
              Installation notes <ArrowRight aria-hidden="true" size={16} />
            </ButtonLink>
            <ButtonLink href="/coverage" variant="secondary">
              How catalog coverage works
            </ButtonLink>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
