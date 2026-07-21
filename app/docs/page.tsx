import {
  ArrowRight,
  ArrowUpRight,
  BookOpenCheck,
  Boxes,
  Braces,
  CheckCircle2,
  FileCode2,
  FolderOpen,
  GitBranch,
  PackageCheck,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Documentation",
  description: "A practical guide to the open Agent Skills format and Aisle’s public-only boundary.",
  path: "/docs",
});

const formatParts = [
  {
    icon: FileCode2,
    title: "SKILL.md is required",
    body: "YAML frontmatter names and describes the skill. Markdown below it carries the instructions an agent reads after activation.",
  },
  {
    icon: FolderOpen,
    title: "Resources are optional",
    body: "A skill can include scripts, references, assets, and other files. Those additions can increase both usefulness and risk.",
  },
  {
    icon: Braces,
    title: "Clients decide support",
    body: "License, compatibility, metadata, and allowed-tools may appear in frontmatter. Experimental fields can behave differently by client.",
  },
] as const;

const lifecycle = [
  {
    number: "01",
    title: "Discover",
    body: "A compatible agent first sees lightweight metadata, usually the skill name and description.",
  },
  {
    number: "02",
    title: "Activate",
    body: "When a request matches, the agent loads the instructions from the upstream SKILL.md into its context.",
  },
  {
    number: "03",
    title: "Use resources",
    body: "The agent may then read referenced files or run bundled scripts when the task and client allow it.",
  },
] as const;

const aisleSteps = [
  {
    icon: GitBranch,
    title: "Keep the origin attached",
    body: "A catalog record must point to a public canonical source, skill path, and immutable revision before it can become installable.",
  },
  {
    icon: ShieldCheck,
    title: "Add context, not replacement content",
    body: "Aisle may add categories, duplicate relationships, compatibility notes, and revision-scoped findings. Upstream content stays upstream.",
  },
  {
    icon: Boxes,
    title: "Compose references",
    body: "A package is an ordered set of public skill references. It is not a new skill and does not contain copied instructions.",
  },
  {
    icon: PackageCheck,
    title: "Resolve again before install",
    body: "The eventual installer must recheck every selected revision and fail closed if a source is missing, changed, or blocked.",
  },
] as const;

const primarySources = [
  {
    href: "https://agentskills.io/specification",
    title: "Agent Skills specification",
    detail: "Canonical format, fields, directory structure, and progressive disclosure.",
  },
  {
    href: "https://github.com/vercel-labs/skills",
    title: "Vercel skills CLI source",
    detail: "Current commands, supported clients, install scopes, and linking behavior.",
  },
  {
    href: "https://www.skills.sh/docs/cli",
    title: "Vercel skills CLI documentation",
    detail: "Public command reference and telemetry disclosure.",
  },
] as const;

export default function DocsPage() {
  return (
    <div className="site-frame">
      <SiteHeader />
      <main className="editorial-page shell">
        <header className="editorial-hero">
          <div className="editorial-hero__copy">
            <Badge tone="iris">Documentation · Open format</Badge>
            <h1>A clear map of what a skill is—and what Aisle adds.</h1>
            <p>
              Agent Skills are portable instruction folders. Aisle helps you find and compose public ones while keeping ownership, revision, license, and review state visible.
            </p>
            <div className="editorial-hero__actions">
              <ButtonLink href="#format">
                Start with the format <ArrowRight aria-hidden="true" size={16} />
              </ButtonLink>
              <ButtonLink href="/docs/public-catalog-policy" variant="secondary">
                Read the catalog policy
              </ButtonLink>
            </div>
          </div>
          <aside className="editorial-hero__note" aria-label="Aisle authorship boundary">
            <span>THE BOUNDARY</span>
            <strong>Aisle does not make skills.</strong>
            <p>
              It indexes existing public work, adds separately labeled marketplace context, and builds reference-only selections.
            </p>
          </aside>
        </header>

        <div className="docs-layout">
          <nav aria-label="Documentation sections" className="docs-nav">
            <span>On this page</span>
            <a href="#format">The open format</a>
            <a href="#loading">How agents load skills</a>
            <a href="#aisle">What Aisle adds</a>
            <a href="#installing">Installation notes</a>
            <a href="#sources">Primary sources</a>
            <div className="docs-nav__rule" />
            <Link href="/safety">Safety &amp; trust</Link>
            <Link href="/coverage">Catalog coverage</Link>
            <Link href="/privacy">Privacy</Link>
          </nav>

          <div className="docs-content">
            <section className="docs-section" id="format">
              <div className="docs-section__heading">
                <span>01 / FORMAT</span>
                <div>
                  <h2>A folder an agent can load progressively.</h2>
                  <p>
                    The open specification requires one file and permits supporting resources. Aisle validates that shape; it does not rewrite the instructions inside it.
                  </p>
                </div>
              </div>
              <div className="format-map">
                <pre aria-label="Agent Skill directory structure"><code>{`skill-directory/
├── SKILL.md       required metadata + instructions
├── scripts/       optional executable code
├── references/    optional supporting documents
└── assets/        optional templates and resources`}</code></pre>
                <div className="format-map__facts">
                  <span>Required frontmatter</span>
                  <strong>name</strong>
                  <strong>description</strong>
                  <span>Optional context</span>
                  <p>license · compatibility · metadata · allowed-tools (experimental)</p>
                </div>
              </div>
              <div className="detail-grid detail-grid--three">
                {formatParts.map(({ body, icon: Icon, title }) => (
                  <article className="detail-card" key={title}>
                    <Icon aria-hidden="true" size={19} />
                    <h3>{title}</h3>
                    <p>{body}</p>
                  </article>
                ))}
              </div>
            </section>

            <section className="docs-section" id="loading">
              <div className="docs-section__heading">
                <span>02 / LOADING</span>
                <div>
                  <h2>Small at discovery, detailed when needed.</h2>
                  <p>
                    The format is designed for progressive disclosure. Exact behavior still belongs to the agent client, so compatibility must be checked rather than assumed.
                  </p>
                </div>
              </div>
              <ol className="process-list">
                {lifecycle.map((step) => (
                  <li key={step.number}>
                    <span>{step.number}</span>
                    <div>
                      <h3>{step.title}</h3>
                      <p>{step.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            <section className="docs-section" id="aisle">
              <div className="docs-section__heading">
                <span>03 / AISLE</span>
                <div>
                  <h2>Marketplace context with the receipts intact.</h2>
                  <p>
                    Aisle’s work begins around the skill: discovery, attribution, qualification, grouping, and install-time resolution.
                  </p>
                </div>
              </div>
              <div className="detail-grid detail-grid--two">
                {aisleSteps.map(({ body, icon: Icon, title }) => (
                  <article className="detail-card detail-card--roomy" key={title}>
                    <Icon aria-hidden="true" size={20} />
                    <h3>{title}</h3>
                    <p>{body}</p>
                  </article>
                ))}
              </div>
              <div className="docs-callout">
                <CheckCircle2 aria-hidden="true" size={21} />
                <div>
                  <strong>Attribution has three lanes.</strong>
                  <p>
                    Publisher-supplied fields remain upstream metadata; categories and packages are Aisle editorial context; audits and trust labels are Aisle findings tied to one revision.
                  </p>
                </div>
              </div>
            </section>

            <section className="docs-section" id="installing">
              <div className="docs-section__heading">
                <span>04 / INSTALL</span>
                <div>
                  <h2>Read the command before you run it.</h2>
                  <p>
                    Installation writes files into an agent’s skill directory and can expose executable resources to that agent. The command is part of the security boundary.
                  </p>
                </div>
              </div>
              <div className="install-status">
                <TerminalSquare aria-hidden="true" size={21} />
                <div>
                  <strong>Commands are issued only after current server-side revalidation.</strong>
                  <p>The stack builder resolves the selected catalog IDs again, blocks stale or ineligible revisions, and requires an exact acknowledgement for each warning-tier revision before returning one command.</p>
                </div>
              </div>
              <div className="install-reference">
                <span>PINNED UPSTREAM CLI SHAPE</span>
                <code>npx skills add &lt;public-source&gt; --skill &lt;name&gt; --agent &lt;client&gt;</code>
              </div>
              <ul className="caveat-list">
                <li>
                  <strong>Scope changes reach.</strong>
                  <span>The Vercel CLI defaults to project installation; global installs apply across projects for the selected agent.</span>
                </li>
                <li>
                  <strong>Link and copy behave differently.</strong>
                  <span>Interactive installs can use a shared symlink or independent copies. Confirm which update model you want.</span>
                </li>
                <li>
                  <strong>Confirmation is useful.</strong>
                  <span>Flags such as <code>--yes</code> remove prompts. Use non-interactive mode only after inspecting source, revision, destination, and files.</span>
                </li>
                <li>
                  <strong>Package runners execute code.</strong>
                  <span><code>npx</code> fetches and runs a package. Pin or verify the tool version according to your own supply-chain policy.</span>
                </li>
                <li>
                  <strong>Third-party telemetry has its own controls.</strong>
                  <span>The Vercel CLI documents anonymous telemetry and the <code>DISABLE_TELEMETRY=1</code> opt-out. Its policy is separate from Aisle’s.</span>
                </li>
              </ul>
              <div className="editorial-hero__actions">
                <ButtonLink href="/stack">
                  Open stack builder <ArrowRight aria-hidden="true" size={16} />
                </ButtonLink>
                <ButtonLink href="/safety" variant="secondary">
                  Review the install checklist
                </ButtonLink>
              </div>
            </section>

            <section className="docs-section" id="sources">
              <div className="docs-section__heading">
                <span>05 / SOURCES</span>
                <div>
                  <h2>Primary references, not marketplace folklore.</h2>
                  <p>
                    These pages informed this guide. Product behavior can change, so the upstream specification and CLI repository remain the source of truth.
                  </p>
                </div>
              </div>
              <div className="source-list">
                {primarySources.map((source) => (
                  <a href={source.href} key={source.href} rel="noreferrer" target="_blank">
                    <BookOpenCheck aria-hidden="true" size={18} />
                    <span>
                      <strong>{source.title}</strong>
                      <small>{source.detail}</small>
                    </span>
                    <ArrowUpRight aria-hidden="true" size={16} />
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                ))}
              </div>
            </section>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
