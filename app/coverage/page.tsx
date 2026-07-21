import {
  Activity,
  ArrowRight,
  CircleDashed,
  CloudCog,
  DatabaseZap,
  Gauge,
  ListRestart,
  Radar,
  SearchCode,
  TriangleAlert,
} from "lucide-react";
import type { Metadata } from "next";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { loadMarketplaceCoverage } from "@/lib/marketplace/catalog";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Catalog coverage",
  description: "Aisle’s source-by-source coverage contract, discovery modes, exclusions, and current sync state.",
  path: "/coverage",
});

const coverageModes = [
  {
    icon: DatabaseZap,
    mode: "Full",
    body: "Enumerates entries inside the source's declared, count-consistent snapshot boundary.",
  },
  {
    icon: ListRestart,
    mode: "Incremental",
    body: "Applies changes since a checkpoint. Aisle must still show the last complete baseline and current lag.",
  },
  {
    icon: Radar,
    mode: "Federated",
    body: "Queries another public index at request time. Results are labeled and are not silently mixed into stored totals.",
  },
  {
    icon: SearchCode,
    mode: "On-demand",
    body: "Validates a specific public source requested by a user. One validated URL is not evidence of broader source coverage.",
  },
] as const;

const sourceFields = [
  "Source name and upstream identifier",
  "Discovery mode",
  "Last successful full or incremental sync",
  "Indexed and unavailable record counts",
  "Current lag and stale state",
  "Partial failures and known exclusions",
  "Access method and applicable upstream terms",
] as const;

const exclusions = [
  {
    title: "Not publicly reachable",
    body: "Private, internal, withdrawn, or credential-gated content is outside Aisle’s public-only catalog boundary.",
  },
  {
    title: "Not a valid supported skill",
    body: "A source without a supported SKILL.md shape can be recorded for diagnosis but cannot become installable.",
  },
  {
    title: "Not immutable",
    body: "If Aisle cannot resolve a stable source path and exact revision or digest, the record fails closed for installation.",
  },
  {
    title: "Outside configured discovery",
    body: "A public repository can exist without appearing in Aisle until an enumerable source, federated search, or on-demand route can discover it.",
  },
] as const;

function formatTimestamp(value: string | null): string {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function formatLag(value: number | null): string {
  if (value === null) return "No successful sync";
  const minutes = Math.floor(value / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export const dynamic = "force-dynamic";

export default async function CoveragePage() {
  const coverage = await loadMarketplaceCoverage();
  const hasRows = coverage.availability === "ready" && coverage.sources.length > 0;
  const status = coverage.availability === "not-configured"
    ? "Not configured"
    : coverage.availability === "unavailable"
      ? "Temporarily unavailable"
      : hasRows
        ? `${coverage.summary.currentSourceCount}/${coverage.summary.sourceCount} current`
        : "No source rows";

  return (
    <div className="site-frame">
      <SiteHeader />
      <main className="editorial-page shell">
        <header className="editorial-hero">
          <div className="editorial-hero__copy">
            <Badge tone="iris">Coverage · Source by source</Badge>
            <h1>Coverage you can audit, not a total you have to trust.</h1>
            <p>
              There is no universal registry of every public Agent Skill. Aisle reports what each configured source made discoverable, when it was last checked, and where the gaps are.
            </p>
            <div className="editorial-hero__actions">
              <ButtonLink href="#contract">
                Read the contract <ArrowRight aria-hidden="true" size={16} />
              </ButtonLink>
              <ButtonLink href="/docs/public-catalog-policy" variant="secondary">
                Public catalog policy
              </ButtonLink>
            </div>
          </div>
          <aside className="coverage-snapshot" aria-label="Current catalog coverage status">
            <div className="coverage-snapshot__status">
              <CircleDashed aria-hidden="true" size={17} />
              <span>{status}</span>
            </div>
            <dl>
              <div>
                <dt>Published source rows</dt>
                <dd>{hasRows ? coverage.summary.sourceCount : "Not available"}</dd>
              </div>
              <div>
                <dt>Last successful sync</dt>
                <dd>{formatTimestamp(coverage.summary.latestSuccessfulSyncAt)}</dd>
              </div>
              <div>
                <dt>Observed source records</dt>
                <dd>{hasRows ? coverage.summary.observedRecordCount.toLocaleString("en") : "Not available"}</dd>
              </div>
            </dl>
            <p>
              {hasRows
                ? "Counts are source-relative observations and can overlap. Open each ledger row for its mode, state, lag, and exclusions."
                : "No measured source snapshot is being substituted with zeroes or sample data in this environment."}
            </p>
          </aside>
        </header>

        <section className="coverage-contract" id="contract">
          <Activity aria-hidden="true" size={22} />
          <div>
            <span className="eyebrow">The coverage promise</span>
            <h2>All observed entries inside each configured source’s displayed coverage boundary at its last successful sync.</h2>
            <p>
              Federated and on-demand results are added only with their mode clearly labeled. Aisle will not shorten this promise to “every skill on the internet.”
            </p>
          </div>
        </section>

        <section className="docs-section coverage-section">
          <div className="docs-section__heading">
            <span>01 / MODES</span>
            <div>
              <h2>Four discovery modes, four different claims.</h2>
              <p>
                The mode determines what a result says about completeness. Search-time discovery cannot be presented as a completed full crawl.
              </p>
            </div>
          </div>
          <div className="mode-grid">
            {coverageModes.map(({ body, icon: Icon, mode }) => (
              <article className="mode-card" key={mode}>
                <Icon aria-hidden="true" size={19} />
                <span>{mode}</span>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="docs-section coverage-section">
          <div className="docs-section__heading">
            <span>02 / REPORTING</span>
            <div>
              <h2>Every source earns its own ledger row.</h2>
              <p>
                Once synchronization is connected, each source must expose the facts below. Stale or failed sources stay visible; old counts cannot masquerade as current ones.
              </p>
            </div>
          </div>
          <div className="coverage-reporting">
            <article>
              <Gauge aria-hidden="true" size={20} />
              <span>REQUIRED PER SOURCE</span>
              <ul>
                {sourceFields.map((field) => <li key={field}>{field}</li>)}
              </ul>
            </article>
            <div className="coverage-ledger-list" aria-label="Current source ledger">
              {hasRows ? coverage.sources.map((source) => (
                <article className="coverage-ledger" data-degraded={source.degraded ? "true" : "false"} key={source.id}>
                  <div className="coverage-ledger__topline">
                    <span>{source.name}</span>
                    <strong>{source.state}</strong>
                  </div>
                  <div>
                    <span>Mode</span>
                    <strong>{source.mode}</strong>
                  </div>
                  <div>
                    <span>Last success</span>
                    <strong>{formatLag(source.lagMs)}</strong>
                  </div>
                  <div>
                    <span>Records</span>
                    <strong>{source.recordCount.toLocaleString("en")} · {source.unavailableCount.toLocaleString("en")} unavailable</strong>
                  </div>
                  <p>{source.upstreamIdentifier}</p>
                  {source.exclusions.length > 0 ? (
                    <ul className="coverage-ledger__exclusions">
                      {source.exclusions.slice(0, 3).map((item) => <li key={item}>{item}</li>)}
                      {source.exclusions.length > 3 ? <li>+{source.exclusions.length - 3} more source exclusions</li> : null}
                    </ul>
                  ) : null}
                </article>
              )) : (
                <article className="coverage-ledger">
                  <div className="coverage-ledger__topline">
                    <span>CURRENT LEDGER</span>
                    <strong>NO SNAPSHOT</strong>
                  </div>
                  <div><span>Source</span><strong>Not published</strong></div>
                  <div><span>Mode</span><strong>Not available</strong></div>
                  <div><span>Last success</span><strong>Not available</strong></div>
                  <div><span>Records</span><strong>Not available</strong></div>
                  <p>No zeroes are shown because zero would be a measured count. No measurement has been published.</p>
                </article>
              )}
            </div>
          </div>
        </section>

        <section className="docs-section coverage-section">
          <div className="docs-section__heading">
            <span>03 / EXCLUSIONS</span>
            <div>
              <h2>Absent, ineligible, and blocked are not the same.</h2>
              <p>
                Coverage explains discovery. Eligibility controls installation. Trust controls risk gates. Aisle reports these dimensions separately.
              </p>
            </div>
          </div>
          <div className="exclusion-grid">
            {exclusions.map((item, index) => (
              <article key={item.title}>
                <span>0{index + 1}</span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
          <aside className="coverage-failure-note">
            <TriangleAlert aria-hidden="true" size={20} />
            <div>
              <strong>Failures stay part of the report.</strong>
              <p>
                A transient source failure does not erase provenance or silently delete records. The source remains visible with its last successful timestamp, stale state, and failure detail while new installation eligibility fails closed where required.
              </p>
            </div>
          </aside>
        </section>

        <section className="coverage-close">
          <CloudCog aria-hidden="true" size={22} />
          <div>
            <span className="eyebrow">Why “all public skills” needs a definition</span>
            <h2>The public ecosystem changes faster than any single index.</h2>
            <p>
              Repositories appear, move, become private, and expose inconsistent metadata. Aisle’s goal is exhaustive reporting within named sources—not an unverifiable global claim.
            </p>
          </div>
          <ButtonLink href="/docs" variant="secondary">Documentation</ButtonLink>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
