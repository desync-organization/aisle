# GitHub Code Search discovery boundary

GitHub Code Search is a federated, request-time discovery source for Aisle. It is
not a catalog snapshot and cannot support a claim that Aisle has enumerated all
public skills.

## Contract

- Requests are authenticated on the server and use GitHub REST API version
  `2026-03-10`.
- A user must provide at least two Unicode letters or numbers. Aisle rejects raw
  qualifiers, wildcards, Boolean operators, controls, and oversized queries,
  then adds `filename:SKILL.md is:public` itself.
- GitHub returns at most 100 items per page and exposes only the first 1,000
  results for a query. `incomplete_results` and totals above 1,000 remain visible
  as partial-coverage metadata.
- Every returned repository must say `private: false`; an explicit visibility
  value must be `public`. Repository, content, HTML, and Git blob URLs are bound
  exactly to the same owner, repository, numeric repository ID, path, and blob.
- Search ordering and provider fields are observations only. Aisle does not map
  rank, text matches, or other unknown fields to trust.

## Blob and commit identity

The `sha` on a Code Search item is a Git blob SHA. It is never a commit or an
installable immutable revision. The content and HTML URLs can expose either a
40-character commit ref or a branch. Branch observations fail closed as
`missing_commit_ref`.

For a selected result with a commit-shaped ref, the optional resolver:

1. rechecks that the repository is currently public;
2. resolves the separately observed Git commit object;
3. walks each Git tree non-recursively, with response, timeout, and path-depth
   bounds; and
4. accepts the commit only when the final `SKILL.md` blob exactly matches the
   search-result blob SHA.

The resolver never calls a contents or blob endpoint and never fetches or stores
skill instructions.

Primary contracts:

- <https://docs.github.com/en/rest/search/search>
- <https://docs.github.com/en/rest/git/trees>
- <https://docs.github.com/en/rest/about-the-rest-api/api-versions>
- <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>
