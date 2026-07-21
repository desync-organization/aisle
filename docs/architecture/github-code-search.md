# GitHub Code Search discovery boundary

GitHub Code Search is a federated discovery source for Aisle. It is not a catalog
snapshot and cannot support a claim that Aisle has enumerated every public GitHub
repository, every indexed `SKILL.md`, or every public skill on the internet.

## Catalog query strategy

The catalog connector always runs two plain-text queries: `name` and `description`.
Those are the required Agent Skills frontmatter keys, so they are defensible
discovery terms without inspecting or inventing skill content. An administrator may
add at most six comma-separated terms with `AISLE_GITHUB_CODE_SEARCH_QUERIES`.
Configured terms extend the observed slices; they never replace the fixed queries or
expand the coverage claim.

The client rejects raw qualifiers, wildcards, Boolean operators, controls, empty
terms, and oversized terms. Aisle adds `filename:SKILL.md is:public` itself. Query
pages are interleaved, then exact repository/path identities are deduplicated across
queries and pages. This keeps one ranked query from consuming every global candidate
cap before another query is sampled.

This remains intentionally incomplete:

- GitHub ranks query results and exposes at most the first 1,000 results for each
  query.
- GitHub may report `incomplete_results`; Aisle preserves that as an exclusion.
- A required metadata key may be unindexed or outside the returned ranked window.
- Extra configured terms observe more query slices, not a source-wide partition.
- Shared page, provider-record, repository, hydration, tree, artifact, and exclusion
  caps can stop a run before the provider's reachable query windows end.

The connector consequently emits no source-wide total, always reports degraded
partial coverage, retains previous provenance, never retires a record solely by
absence, and never resumes a mutable partial query sweep.

## Configuration

No Code Search or repository request occurs unless
`AISLE_GITHUB_CODE_SEARCH_ENABLED=true` and `GITHUB_TOKEN` is present. Missing either
setting keeps the source `not-configured` with zero claimed current records. The
token must be server-side and restricted to public access; Aisle never exposes it to
the browser.

## Search result contract

- Requests use GitHub REST API version `2026-03-10`.
- GitHub returns at most 100 items per page and only the first 1,000 results per
  query.
- Every result must be named `SKILL.md` and report `private: false`; an explicit
  visibility value must be `public`.
- Repository, content, HTML, and Git blob URLs must bind exactly to the same owner,
  repository, numeric repository ID, path, and blob observation.
- Search ordering, blob SHAs, URL refs, repository state, text matches, and unknown
  provider fields remain observations only. The catalog connector does not map them
  to trust, license, revision, or install evidence and does not request result bodies.

## Exact default-branch hydration

For catalog synchronization, Code Search nominates only the validated public GitHub
repository identity and exact `SKILL.md` path. The reusable GitHub repository adapter
then independently:

1. rechecks that the repository is public;
2. resolves its current default branch to an exact commit;
3. finds the nominated path in a bounded, non-truncated tree;
4. hydrates a bounded exact artifact and file inventory; and
5. supplies revision-scoped hashes, license evidence, and install binding.

The search-result blob or URL commit is deliberately not used as the catalog
revision. A result for a stale, deleted, renamed, non-default-branch, private,
oversized, truncated, or identity-conflicting path fails closed. The GitHub-hydrated
record is preserved wholesale except for the source-specific stable record ID,
bounded category hints, and typed source attribution.

## Optional exact-commit resolver

The lower-level client also retains a bounded exact-commit resolver for explicit
request-time search selections. A search item `sha` is a Git blob SHA, never a commit.
When both content and HTML observations expose a matching 40-character commit ref,
the resolver rechecks public visibility and walks each path segment through bounded
non-recursive Git trees. It accepts the commit only when the final `SKILL.md` blob
matches the search observation. The catalog connector does not use this optional
resolver for source ingestion.

Primary contracts:

- <https://docs.github.com/en/rest/search/search>
- <https://docs.github.com/en/rest/git/trees>
- <https://docs.github.com/en/rest/about-the-rest-api/api-versions>
- <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>
