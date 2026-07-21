# Wider public-source boundaries

Aisle has bounded client contracts for the sources below. They are registered as
disabled source descriptors until catalog connectors can hydrate exact upstream
artifacts, license evidence, and revision-scoped trust results. A disabled source
claims zero current records; the presence of a client is not a coverage claim.

| Source | Discovery mode | What the client can observe | Coverage boundary |
| --- | --- | --- | --- |
| AgentSkills.in | Full sweep target | Empty-search offset pages and public GitHub identity hints | Pages are mutable and have no snapshot token. A sweep stays partial until stable-sweep orchestration exists. |
| AskSkill | Federated | Bounded pages, details, and transient raw validation text | Totals may be estimated and the provider may limit the reachable page window. It is never exhaustive. |
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

- Wrap each client in the current `CatalogSourceConnector` page contract.
- Add exact GitHub artifact/license hydration shared with the existing public
  repository adapter rather than trusting registry payloads.
- Define stable repeated-sweep checkpoints for AgentSkills.in and non-retiring
  partial semantics for AskSkill.
- Persist GetSkillary rows as unresolved provenance unless an authoritative
  upstream origin can be proved.
- Expose GitHub Code Search only as a labeled query result set; never feed it into
  full-source retirement or source-wide totals.

No connector may create, rewrite, vendor, or infer a `SKILL.md` on Aisle's behalf.
