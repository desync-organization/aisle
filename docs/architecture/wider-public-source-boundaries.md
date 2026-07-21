# Wider public-source boundaries

Aisle has bounded client contracts for the sources below. AgentSkills.in, AskSkill,
and GitHub Code Search have explicitly configured connectors that rebind discovery
identities to exact public GitHub artifacts. GetSkillary has a separate coverage-only
connector because its snapshot does not prove an authoritative repository or license.
A disabled source claims zero current records; the presence of a client is not a
coverage claim.

| Source | Discovery mode | What the client can observe | Coverage boundary |
| --- | --- | --- | --- |
| AgentSkills.in | Opt-in partial sweep | Empty-search offset pages nominate exact public GitHub repository and `SKILL.md` paths | Pages are mutable and have no snapshot token. Every sweep is degraded, non-retiring partial coverage even when a terminal offset is observed. |
| AskSkill | Opt-in federated sweep | Bounded list pages nominate exact public GitHub repository and `SKILL.md` paths | Totals may be estimated and the provider may limit the reachable page window. Every sweep is degraded, non-retiring partial coverage. |
| GetSkillary | Full within declared boundary | A bounded JSON snapshot with declared count and package hash observations | Completeness covers only the provider's selected-public boundary. Missing upstream repository/license evidence keeps records non-installable. |
| GitHub Code Search | Opt-in federated query sweep | Fixed required-metadata queries plus bounded configured terms nominate exact public GitHub repository and `SKILL.md` paths | Ranked results are capped at 1,000 per query, may be incomplete, and are rebound to the current public default branch. Every sweep remains partial and non-retiring. |

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

- Reuse the exact GitHub artifact/license hydrator for future registry connectors
  rather than trusting registry payloads.
- Keep GetSkillary observations unresolved unless a future authoritative upstream
  origin and license can be proved independently.

No connector may create, rewrite, vendor, or infer a `SKILL.md` on Aisle's behalf.

## GetSkillary configuration and limits

GetSkillary performs no request unless `AISLE_GETSKILLARY_ENABLED=true`. It needs no
credential because the selected-public snapshot is public. A disabled connector stays
`not-configured` and claims zero current records.

One sync requests only the bounded `skills.json` snapshot. It does not request any
provider ZIP URL or archive. A successful count-consistent terminal response may be
complete only inside the provider's explicit selected-public boundary, and its displayed
count is therefore source-relative. Aisle caps the response at four MiB and accepts at
most 5,000 observations; exceeding either limit fails the run without a new current
coverage claim.

Each persisted listing contains a stable provider ID, canonical GetSkillary page,
bounded title/summary/category/tag observations, snapshot attribution, and the provider's
declared archive hash and size as typed raw metadata. The download URL is discarded.
Repository, license, artifact, immutable reference, content hash, install URL, and
install specification remain null. Ingestion consequently keeps every row unresolved:
it cannot become a canonical skill, package member, selectable item, or install command.

Because each accepted response is a single declared-boundary snapshot rather than a
mutable pagination sweep, GetSkillary uses latest-completed-observation freshness. An
absent provider identity stops contributing to the displayed current count only after a
newer count-consistent snapshot has completed; unresolved listing history may remain for
audit. A failed, oversized, or malformed response does not replace the last current count.

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

## GitHub Code Search configuration and limits

GitHub Code Search performs no request unless
`AISLE_GITHUB_CODE_SEARCH_ENABLED=true` and `GITHUB_TOKEN` is present. The token
must be public-only. Missing either setting keeps the source `not-configured`.

The connector always runs the plain-text terms `name` and `description`, the two
required `SKILL.md` frontmatter keys. Up to six configured terms may add bounded
query slices. Raw qualifiers and Boolean syntax are rejected; Aisle supplies
`filename:SKILL.md is:public`. Query pages are interleaved so one ranked slice does
not consume every global candidate cap before another query is sampled, and exact
identities are deduplicated across queries and pages.

This strategy cannot enumerate GitHub. A required key may still be absent from the
provider index or outside the returned ranked window; each query exposes at most
1,000 results and can report incomplete results. Shared page, record, repository,
hydration, tree, artifact, and exclusion caps may stop a run earlier. The connector
therefore reports no source-wide total, never declares a complete snapshot, never
resumes a partial query cursor, and never retires a prior record by absence.

Search blob SHAs, result ranks, URL refs, and unknown response fields are not used
as revision, trust, license, or install evidence. Search nominates only a repository
and exact path. The GitHub repository adapter independently proves that the path
exists on the current public default branch and supplies the immutable revision,
artifact inventory, hashes, license evidence, and install binding. Missing or stale
search paths fail closed, and neither search nor hydration persists instruction
bodies in catalog source attribution.
