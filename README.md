# Aisle

Aisle is a public Agent Skills marketplace for discovering existing skills, assembling them into a stack, and installing that stack with one command.

Aisle indexes public upstream skills with immutable source references, revision-scoped validation, and explicit source-coverage state. Its isolated install planner turns server-resolved eligible selections into deterministic argv operations and shell-safe commands; see [its architecture contract](docs/architecture/install-plan-command-generation.md). Aisle does not author, generate, rewrite, modify, or fork skills. See [the public catalog policy](docs/architecture/public-catalog-policy.md).

## Development

Requirements:

- Node.js 20.9 or newer
- npm 11.16 (the version declared by `packageManager` and used in CI)

```powershell
npm ci
Copy-Item .env.example .env.local
npm run db:setup
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Database

The default database is local SQLite-compatible libSQL at `file:./data/aisle.db`. `npm run db:setup` applies every journaled migration and seeds source descriptors and categories. The `data/` database files are ignored by Git.

For a hosted Turso/libSQL database, set both values before running the same setup command:

```powershell
$env:DATABASE_URL = "libsql://your-database.turso.io"
$env:DATABASE_AUTH_TOKEN = "your-token"
npm run db:setup
```

Hosted `libsql://` and `https://` database URLs fail configuration validation when `DATABASE_AUTH_TOKEN` is absent.

## Public catalog sync

The sync command migrates and seeds the database, then attempts each configured public connector independently:

```powershell
npm run catalog:sync
```

The catalog CLI reads its process environment. Use the names documented in `.env.example`; for local PowerShell runs, set the required values with `$env:NAME = "value"` before invoking the command. The Next.js runtime also reads `.env.local`.

- `skills.sh` requires a request-scoped Vercel OIDC token. A linked Vercel runtime supplies it through `@vercel/oidc`; local development can use the short-lived `SKILLS_SH_OIDC_TOKEN` override.
- `GITHUB_TOKEN` increases public GitHub API limits for SkillMD hydration and explicitly configured repositories. It is required when `AISLE_AGENTSKILLS_IN_ENABLED=true`, `AISLE_ASKSKILL_ENABLED=true`, or `AISLE_GITHUB_CODE_SEARCH_ENABLED=true`. Use a public-only token that does not grant Aisle access to private repositories.
- `AISLE_AGENTSKILLS_IN_ENABLED` defaults to `false`. Setting it to `true` opts into bounded AgentSkills.in discovery plus exact public-GitHub hydration; a missing GitHub token leaves the source honestly `not-configured` and performs no provider fetch.
- `AISLE_ASKSKILL_ENABLED` defaults to `false`. Setting it to `true` opts into bounded AskSkill page discovery plus exact public-GitHub hydration. Missing either the flag or GitHub token keeps the source `not-configured` without requesting AskSkill.
- `AISLE_GETSKILLARY_ENABLED` defaults to `false`. Setting it to `true` opts into GetSkillary's bounded selected-public snapshot. Rows remain coverage-only and non-installable because the snapshot does not prove an authoritative repository, immutable artifact, or upstream license; Aisle does not fetch or persist provider ZIP downloads.
- `AISLE_SKILLS_RE_ENABLED` defaults to `false`. Setting it to `true` opts into bounded Skills.re public cursor search. The documented search result has no authoritative repository-relative skill path, so rows remain coverage-only, unresolved, and non-installable; optional provider repository, version, license, verification, audit, and score fields are not Aisle provenance or trust.
- `AISLE_GITHUB_CODE_SEARCH_ENABLED` defaults to `false`. Setting it to `true` opts into bounded searches for the required `SKILL.md` metadata terms `name` and `description`, followed by independent exact public-default-branch hydration. The source remains query-scoped and partial.
- `AISLE_GITHUB_CODE_SEARCH_QUERIES` optionally adds at most six comma-separated plain-text search terms. They extend coverage samples only; qualifiers, operators, and oversized terms are rejected, while empty comma-separated entries are ignored.
- `AISLE_GITHUB_REPOSITORIES` is a comma-separated administrator extension to Aisle's default public GitHub repository inventory. Defaults, launch-package origins, and configured additions are normalized and deduplicated before inspection; see the [inventory and its fail-closed semantics](docs/architecture/public-github-repository-inventory.md).
- `AISLE_WELL_KNOWN_ORIGINS` is a comma-separated administrator allowlist, but these connectors remain `not-configured` and perform no fetch until hostname traffic is IP-pinned or egress-contained against DNS rebinding. Setting the variable alone does not bypass that guard.

The command prints a per-connector JSON result. A fulfilled command is not a claim that every source is current: read each source's stored mode, coverage state, record count, last successful sync, failures, and exclusions before presenting coverage.

Production synchronization is scheduled and manually dispatchable through GitHub Actions. Each connector runs in a separately bounded process so a slow upstream cannot block later sources. See the [production catalog synchronization runbook](docs/operations/catalog-sync.md) for source-scoped commands, required Turso secrets, and the public-only GitHub token boundary.

## Curated package publication

After the required public GitHub sources have completed and every pinned member has
current provenance, license, inventory, and trust evidence, publish the eight launch
packages with:

```powershell
npm run packages:publish
```

Publication is transactional and fail-closed: if one requested member no longer
matches its exact upstream revision or eligibility evidence, no partial package set
is published. Pass one or more package slugs after `--` to publish a subset, for
example `npm run packages:publish -- frontend-foundations cybersecurity`.

### Coverage semantics

There is no universal registry of every public Agent Skill. Aisle can only claim eligible records proven from configured sources at their displayed sync state:

- Full sources such as `skills.sh` and ClawHub become current only after a complete, internally consistent terminal crawl. Pagination drift, duplicate identities, failed hydration, or count mismatches leave coverage partial and do not retire unseen records.
- SkillMD is federated and non-retiring: its offset API has no stable snapshot token, so a sweep remains partial even after its terminal page.
- AgentSkills.in is opt-in and non-retiring. Its mutable offset pages always remain partial/degraded; registry rows only nominate exact GitHub repository and `SKILL.md` paths, and failed, oversized, duplicate, or identity-conflicting hydrations become bounded exclusions.
- AskSkill is opt-in, federated, and non-retiring. Its totals and page windows may be estimated or limited, every sweep remains partial/degraded, and only exact GitHub-hydrated identities enter the catalog. Provider scores, badges, and instruction bodies are not trust evidence or persisted discovery data.
- GetSkillary is opt-in and complete only inside the exact selected-public boundary declared by a bounded snapshot. Its source-relative count may be current while every row remains unresolved and excluded from canonical search, packages, selection, and installation. Provider archive hashes and sizes are coverage observations, never upstream content or install evidence.
- Skills.re is opt-in, federated, and non-retiring. Its cursor search has no immutable global snapshot and guarantees no authoritative GitHub repository/path pair, so bounded metadata observations remain unresolved and excluded from canonical search, packages, selection, and installation. Aisle does not request Skills.re skill bodies or archives.
- GitHub Code Search is opt-in, query-scoped, and non-retiring. Fixed and configured query pages are interleaved and deduplicated, but each query is ranked, capped at 1,000 results, and may be incomplete. Search blobs and ranks never become install evidence; the exact path must exist on the repository's current public default branch.
- Default and configured GitHub repositories are explicit, on-demand discovery sources. Their coverage is source-relative and applies only to the normalized repository inventory; a seed grants no selection or trust status.
- SkillsMP and well-known hostname discovery remain visibly `not-configured` until their enumeration or transport requirements can be met safely.

Stale, failed, credentials-required, and not-configured sources keep their previous provenance visible, but their retained counts are not represented as current coverage.

### No skill authorship or body storage

Aisle's catalog contains only records for already-public upstream skills. Connectors may fetch bounded public artifacts transiently to validate schemas, inventory exact files, calculate hashes, inspect licensing, and run static checks. The catalog persists source metadata, immutable references, hashes, file fingerprints, license-evidence metadata, and trust/audit results—not `SKILL.md` bodies or copied skill trees.

Selection resolves to a verified public upstream locator and records the immutable observation. Aisle package manifests pin those catalog revisions, while installation tooling must disclose whether its upstream mechanism can enforce the exact revision. Packages are editorial reference manifests, not newly authored skills.

## Quality gates

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

`npm run check` runs the first three gates together. The production build remains a separate command so CI can report it independently.

## Project map

- `app/` — Next.js App Router routes and metadata
- `components/` — shared shell and visual primitives
- `lib/catalog/` — public-source adapters, normalization, validation, and sync orchestration
- `lib/db/` — Drizzle schema, repository invariants, migrations, and seed data
- `scripts/` — database setup and catalog-sync entry points
- `docs/architecture/` — product invariants and architecture decisions

The shared colors, type, interaction states, and component accessibility contracts are documented in [the visual-system guide](docs/design-system.md).

## Catalog invariant

Only already-public upstream Agent Skills may become installable. Packages contain references to immutable upstream revisions, never copied or synthesized skill content.
