# Production catalog synchronization

Aisle's production catalog sync runs from `.github/workflows/catalog-sync.yml` once per day and can also be started with GitHub Actions' **Run workflow** control. Workflow-level concurrency allows only one production sync at a time. The workflow applies migrations and idempotent seed data before ingestion, discovers the source IDs from the application, and gives each source its own process and 30-minute deadline. A timed-out or failed source is reported but does not prevent later sources from running.

After every requested source has been attempted, the workflow runs curated package publication as a final bounded operation even when an individual source failed. Publication uses the existing transactional eligibility gates and fails closed until every required package member has current exact provenance, license, inventory, and trust evidence. A source or publication failure makes the workflow unsuccessful after all operations have had their turn; it never publishes a partial or unproven package set.

The catalog's existing per-source database lease remains the final write fence. An interrupted process can therefore leave only its own source lease pending until it expires; another source does not share that lease.

## Repository secrets

Configure these in **Settings > Secrets and variables > Actions** before running the workflow:

- `TURSO_DATABASE_URL` — the production `libsql://` database URL.
- `TURSO_AUTH_TOKEN` — a Turso token with only the access needed for this database.
- `AISLE_PUBLIC_GITHUB_TOKEN` — strongly recommended for public GitHub API rate limits and required by the opted-in registry hydration and code-search connectors. Use a dedicated classic personal access token with no scopes. A no-scope classic token can read public resources but cannot grant Aisle access to private repositories. Never use an organization-wide token or a token with the `repo` scope.
- `SKILLS_SH_OIDC_TOKEN` — optional, short-lived request token for a manual skills.sh run outside Vercel. Do not treat it as a durable scheduled credential; without a valid token, skills.sh fails closed as credentials-required and the workflow continues to the next source.

Repository secrets are injected only into the sync process. The workflow validates that the two Turso values are present without printing them, does not enable shell tracing, and GitHub masks registered secret values in logs.

## Optional repository variables

The workflow also accepts these non-secret Actions variables:

- `AISLE_GITHUB_REPOSITORIES` — comma-separated additional public GitHub repository URLs.
- `AISLE_GITHUB_CODE_SEARCH_QUERIES` — up to six additional plain-text discovery terms.
- `AISLE_WELL_KNOWN_ORIGINS` — approved HTTPS origins; the connector's existing transport guard still keeps unsafe origins not-configured.

The workflow enables every implemented opt-in public connector. This expands coverage only through existing public-source adapters. It does not create skills, copy skill bodies, relax license or trust checks, or make coverage-only records installable.

## Manual operation

List the exact source IDs recognized by the current checkout:

```powershell
npm run catalog:sync -- --list-sources --format lines
```

Run a single connector without waiting for any other connector:

```powershell
npm run catalog:sync -- --source github:openai/skills
```

In GitHub Actions, enter the same source ID in the manual workflow input. Leave the default `all` to run every discovered connector independently. Unknown IDs fail before ingestion and print the available public source IDs.

Running `npm run catalog:sync` with no source retains the local all-sources behavior. Production automation uses source-scoped invocations so one slow upstream cannot consume the execution window intended for later sources.
