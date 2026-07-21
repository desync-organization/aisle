# Wider public-source boundaries

Aisle has bounded client contracts for the sources below. AgentSkills.in and
AskSkill have explicitly configured connectors that rebind registry identities to
exact public GitHub artifacts. The other sources remain disabled descriptors until
equivalent hydration and synchronization boundaries are implemented. A disabled
source claims zero current records; the presence of a client is not a coverage claim.

| Source | Discovery mode | What the client can observe | Coverage boundary |
| --- | --- | --- | --- |
| AgentSkills.in | Opt-in partial sweep | Empty-search offset pages nominate exact public GitHub repository and `SKILL.md` paths | Pages are mutable and have no snapshot token. Every sweep is degraded, non-retiring partial coverage even when a terminal offset is observed. |
| AskSkill | Opt-in federated sweep | Bounded list pages nominate exact public GitHub repository and `SKILL.md` paths | Totals may be estimated and the provider may limit the reachable page window. Every sweep is degraded, non-retiring partial coverage. |
| GetSkillary | Full within declared boundary | A bounded JSON snapshot with declared count and package hash observations | Completeness covers only the provider's selected-public boundary. Missing upstream repository/license evidence keeps records non-installable. |
| GitHub Code Search | Federated, query-only | Server-authenticated `SKILL.md` search results and bounded exact-commit tree resolution | Results depend on the query, are capped at 1,000, may be incomplete, and never prove global GitHub coverage. |

## Shared acceptance boundary

Registry identity, rank, badges, archive hashes, and claimed visibility are source
observations. Before any result can become selectable, a connector must:

1. resolve the canonical public upstream repository and exact `SKILL.md` path;
2. bind that path to an immutable commit or equivalent revision;
3. hydrate a bounded artifact inventory without permanently mirroring skill text;
4. establish revision-scoped license and baseline trust evidence; and
5. emit the source-specific exclusions and completion proof to the coverage ledger.

The GitHub Code Search `sha` is a blob identifier. Its resolver separately
rechecks repository visibility and accepts a commit only after a bounded,
non-recursive tree walk finds the same blob at the same path. Oversized,
truncated, missing, private, or conflicting origins remain unresolved.

## Remaining orchestration work

- Wrap GetSkillary in the current `CatalogSourceConnector` page contract.
- Reuse the exact GitHub artifact/license hydrator for future registry connectors
  rather than trusting registry payloads.
- Persist GetSkillary rows as unresolved provenance unless an authoritative
  upstream origin can be proved.
- Expose GitHub Code Search only as a labeled query result set; never feed it into
  full-source retirement or source-wide totals.

No connector may create, rewrite, vendor, or infer a `SKILL.md` on Aisle's behalf.

## AgentSkills.in configuration and limits

AgentSkills.in performs no request unless `AISLE_AGENTSKILLS_IN_ENABLED=true` and
`GITHUB_TOKEN` is present. The token must be public-only. Missing either setting
keeps the source `not-configured` with its reason in the coverage ledger.

The connector persists no registry instruction body. It keeps only a bounded raw
attribution to the provider record ID and exact repository/manifest identity, plus
bounded category hints. Names, descriptions, totals, rankings, and availability
flags remain discovery observations. The GitHub adapter supplies the public
repository check, exact head, artifact inventory, hashes, license evidence, and
install binding; those hydrated fields are preserved instead of reconstructed from
registry metadata.

Each run is capped by provider page bytes and records, page count, distinct
repositories, exact paths per repository, total hydration attempts, GitHub tree
entries, artifact files, and dynamic exclusion entries. A failed or omitted item
produces a bounded exclusion and no synthetic catalog record. Because offset pages
are mutable, the connector reports no source-wide total, never declares a complete
snapshot, and never uses absence to retire a previously observed record.

## AskSkill configuration and limits

AskSkill performs no request unless `AISLE_ASKSKILL_ENABLED=true` and
`GITHUB_TOKEN` is present. The token must be public-only. Missing either setting
keeps the source `not-configured` with its reason in the coverage ledger.

The connector requests only bounded list pages. It does not call AskSkill detail or
raw-instruction endpoints, and it does not persist provider names, descriptions,
scores, badges, rankings, instruction bodies, totals, or install references. It
keeps a bounded source attribution and bounded tag hints. The GitHub adapter alone
supplies public-repository, immutable-revision, artifact, license, hash, and install
evidence; the connector preserves that hydrated record instead of reconstructing it
from registry observations.

Each run is capped by provider response bytes and records, page count, distinct
repositories, exact paths per repository, total hydration attempts, GitHub tree
entries, artifact files, and dynamic exclusion entries. Duplicate, conflicting,
oversized, missing, or failed identities are excluded without producing synthetic
records. Because page numbers, totals, and reachable windows are mutable, an
AskSkill run never resumes an earlier partial sweep, reports no source-wide total,
never declares a complete snapshot, and never retires a record solely by absence.
