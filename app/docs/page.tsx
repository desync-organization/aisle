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
  description: "How Agent Skills work, what Aisle indexes, and what to check before installing.",
  path: "/docs",
});

const formatParts = [
  {
    icon: FileCode2,
    title: "SKILL.md is required",
    body: "Every SKILL.md starts with YAML frontmatter: a lowercase name (1–64 characters) and a description (up to 1,024 characters). The instructions follow in Markdown.",
  },
  {
    icon: FolderOpen,
    title: "Resources are optional",
    body: "A skill can also include scripts, references, assets, and other files. Review them before installation.",
  },
  {
    icon: Braces,
    title: "Clients decide support",
    body: "Frontmatter can also include a license, metadata, a compatibility note (up to 500 characters), and the experimental allowed-tools field. Support varies by client.",
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
    title: "Link to the source",
    body: "Every installable record includes a public source, skill path, and immutable revision.",
  },
  {
    icon: ShieldCheck,
    title: "Label Aisle’s additions",
    body: "Aisle adds categories, duplicate relationships, compatibility notes, and revision-specific findings. It does not replace the publisher’s content.",
  },
  {
    icon: Boxes,
    title: "Group skills without copying them",
    body: "A package is an ordered list of public skill references. It is not a new skill and does not copy the instructions.",
  },
  {
    icon: PackageCheck,
    title: "Check again before installation",
    body: "The installer must recheck each selected revision and stop if a source is missing, changed, or blocked.",
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
            <Badge tone="iris">Docs · Agent Skills</Badge>
            <h1>How Agent Skills work</h1>
            <p>
              Learn what a skill contains, how clients load it, what Aisle adds, and what to check before you install.
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
          <aside className="editorial-hero__note" aria-label="What Aisle does">
            <span>WHAT AISLE DOES</span>
            <strong>Aisle indexes public skills.</strong>
            <p>
              It does not write or copy them. Categories, packages, and review findings are clearly marked as Aisle’s work.
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
                  <h2>What a skill contains</h2>
                  <p>
                    The open specification requires a SKILL.md file and allows supporting resources. Aisle checks the format but does not rewrite the instructions.
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
                  <h2>How clients load a skill</h2>
                  <p>
                    Clients usually start with the name and description, then load the full instructions when needed. Exact behavior varies by client.
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
                  <h2>What Aisle adds</h2>
                  <p>
                    Aisle handles discovery, attribution, review details, grouping, and installation checks around the original skill.
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
                  <strong>Who supplied the information</strong>
                  <p>
                    Names, files, and licenses come from the publisher. Categories and packages come from Aisle. Review findings are tied to one exact revision.
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
                    Installation writes files into an agent’s skill directory and may make executable resources available to that agent. Review the generated command before running it.
                  </p>
                </div>
              </div>
              <div className="install-status">
                <TerminalSquare aria-hidden="true" size={21} />
                <div>
                  <strong>Aisle checks the selection before generating a command.</strong>
                  <p>The stack builder resolves every selected catalog ID again, blocks stale or ineligible revisions, and requires an exact acknowledgement for each warning-tier revision.</p>
                </div>
              </div>
              <div className="install-reference">
                <span>PINNED CLI EXAMPLE</span>
                <code>npx skills add &lt;public-source&gt; --skill &lt;name&gt; --agent &lt;client&gt;</code>
              </div>
              <ul className="caveat-list">
                <li>
                  <strong>Choose project or global scope.</strong>
                  <span>The Vercel CLI defaults to project installation; global installs apply across projects for the selected agent.</span>
                </li>
                <li>
                  <strong>Choose link or copy.</strong>
                  <span>Interactive installs can use a shared symlink or independent copies. Confirm which update model you want.</span>
                </li>
                <li>
                  <strong>Keep confirmation prompts when possible.</strong>
                  <span>Flags such as <code>--yes</code> remove prompts. Use non-interactive mode only after inspecting source, revision, destination, and files.</span>
                </li>
                <li>
                  <strong><code>npx</code> runs downloaded code.</strong>
                  <span><code>npx</code> fetches and runs a package. Pin or verify the tool version according to your own supply-chain policy.</span>
                </li>
                <li>
                  <strong>The CLI controls its own telemetry.</strong>
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
                  <h2>Source documentation</h2>
                  <p>
                    These are the primary references for the format and CLI. Check them for the latest behavior.
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
