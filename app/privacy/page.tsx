import {
  ArrowRight,
  ExternalLink,
  EyeOff,
  GitFork,
  HardDrive,
  KeyRound,
  Network,
  ShieldCheck,
} from "lucide-react";
import type { Metadata } from "next";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Privacy and data use",
  description: "What Aisle handles in the browser, from public sources, and through external tools.",
  path: "/privacy",
});

const privacyAreas = [
  {
    icon: HardDrive,
    title: "Local selection state",
    body: "When the stack builder is available, it may keep public catalog identifiers and interface choices in browser storage on this device. It is not an account or cloud backup, and clearing site data removes it.",
  },
  {
    icon: GitFork,
    title: "Public source metadata",
    body: "Catalog records use public publisher names, repository URLs, skill paths, revisions, and declared metadata for discovery and attribution. Aisle does not use private-repository credentials for public catalog ingestion.",
  },
  {
    icon: Network,
    title: "Routine request data",
    body: "Hosting infrastructure may process standard request information such as IP address, user agent, requested URL, and timestamps to deliver and protect the site. Hosting details must be named before public launch.",
  },
  {
    icon: ExternalLink,
    title: "External destinations",
    body: "Upstream repositories, specification pages, and terminal tools are separate services with their own terms and privacy practices. Following a link or running a command leaves Aisle’s web boundary.",
  },
] as const;

export default function PrivacyPage() {
  return (
    <div className="site-frame">
      <SiteHeader />
      <main className="editorial-page shell">
        <header className="editorial-hero">
          <div className="editorial-hero__copy">
            <Badge tone="iris">Privacy · Plain language</Badge>
            <h1>Public discovery without a profile attached.</h1>
            <p>
              Aisle is designed so browsing public skills does not require an account. This notice separates data handled by the site, public source metadata, local browser state, and third-party tools.
            </p>
            <div className="editorial-hero__actions">
              <ButtonLink href="#current-state">
                Current posture <ArrowRight aria-hidden="true" size={16} />
              </ButtonLink>
              <ButtonLink href="/docs/public-catalog-policy" variant="secondary">
                Source policy
              </ButtonLink>
            </div>
          </div>
          <aside className="editorial-hero__note" aria-label="Current privacy summary">
            <span>CURRENT APP</span>
            <strong>No accounts, ads, or payment collection.</strong>
            <p>
              The application code in this release does not include ad tracking, account registration, profile forms, or payment flows.
            </p>
          </aside>
        </header>

        <section className="privacy-current" id="current-state">
          <ShieldCheck aria-hidden="true" size={23} />
          <div>
            <span className="eyebrow">Current transparency release</span>
            <h2>The catalog is not synchronized and the composed installer is not live.</h2>
            <p>
              No catalog counts, cloud stack records, or install histories are being claimed by this static shell. This notice must be revised before a hosted data service, account system, analytics tool, or payment flow is enabled.
            </p>
          </div>
          <time dateTime="2026-07-21">Reviewed 21 Jul 2026</time>
        </section>

        <section className="docs-section privacy-section">
          <div className="docs-section__heading">
            <span>01 / DATA MAP</span>
            <div>
              <h2>Four boundaries worth keeping distinct.</h2>
              <p>
                “Public data” describes where catalog material came from; it does not describe every request needed to deliver a website or every third-party tool a user may choose to run.
              </p>
            </div>
          </div>
          <div className="privacy-grid">
            {privacyAreas.map(({ body, icon: Icon, title }) => (
              <article key={title}>
                <Icon aria-hidden="true" size={20} />
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="docs-section privacy-section">
          <div className="docs-section__heading">
            <span>02 / NOT COLLECTED</span>
            <div>
              <h2>Secrets do not belong in the marketplace UI.</h2>
              <p>
                Aisle’s public catalog does not need your source-control token, agent credential, environment secrets, or private repository access.
              </p>
            </div>
          </div>
          <div className="privacy-guardrails">
            <article>
              <EyeOff aria-hidden="true" size={21} />
              <strong>Do not paste secrets into search or selection fields.</strong>
              <p>Search terms and public identifiers should be enough to compose a stack.</p>
            </article>
            <article>
              <KeyRound aria-hidden="true" size={21} />
              <strong>Install permissions stay on your machine.</strong>
              <p>Review what a terminal command and its selected skills can access before running it.</p>
            </article>
          </div>
        </section>

        <section className="docs-section privacy-section">
          <div className="docs-section__heading">
            <span>03 / THIRD PARTIES</span>
            <div>
              <h2>Aisle cannot rewrite another service’s policy.</h2>
              <p>
                For example, Vercel’s public <code>skills</code> CLI documentation describes anonymous telemetry and an opt-out environment variable. That tool’s collection is separate from Aisle’s website.
              </p>
            </div>
          </div>
          <div className="privacy-source-links">
            <a href="https://www.skills.sh/docs/cli" rel="noreferrer" target="_blank">
              Vercel skills CLI privacy note <ExternalLink aria-hidden="true" size={15} />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <a href="https://github.com/Krishang-Zinzuwadia/aisle/issues" rel="noreferrer" target="_blank">
              Request a correction or removal <ExternalLink aria-hidden="true" size={15} />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </div>
          <aside className="privacy-change-note">
            <strong>Material changes should be visible before collection begins.</strong>
            <p>
              If Aisle adds analytics, accounts, cloud-saved stacks, newsletters, or payments, this notice should name the provider, purpose, retention, controls, and effective date before activation.
            </p>
          </aside>
          <ButtonLink href="/safety" variant="secondary">
            Continue to safety <ArrowRight aria-hidden="true" size={16} />
          </ButtonLink>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
