# Aisle

Aisle is a public Agent Skills marketplace for discovering existing skills, assembling them into a stack, and installing that stack with one command.

Aisle indexes public upstream skills with immutable source references, revision-scoped validation, and explicit source-coverage state. It does not author, generate, rewrite, or fork skills. See [the public catalog policy](docs/architecture/public-catalog-policy.md).

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
- `GITHUB_TOKEN` is optional and only increases public GitHub API limits for SkillMD hydration and explicitly configured repositories. It must not grant Aisle access to private repositories.
- `AISLE_GITHUB_REPOSITORIES` is a comma-separated allowlist of public GitHub repository URLs to inspect for `SKILL.md` files at exact commits.
- `AISLE_WELL_KNOWN_ORIGINS` is a comma-separated administrator allowlist, but these connectors remain `not-configured` and perform no fetch until hostname traffic is IP-pinned or egress-contained against DNS rebinding. Setting the variable alone does not bypass that guard.

The command prints a per-connector JSON result. A fulfilled command is not a claim that every source is current: read each source's stored mode, coverage state, record count, last successful sync, failures, and exclusions before presenting coverage.

### Coverage semantics

There is no universal registry of every public Agent Skill. Aisle can only claim eligible records proven from configured sources at their displayed sync state:

- Full sources such as `skills.sh` and ClawHub become current only after a complete, internally consistent terminal crawl. Pagination drift, duplicate identities, failed hydration, or count mismatches leave coverage partial and do not retire unseen records.
- SkillMD is federated and non-retiring: its offset API has no stable snapshot token, so a sweep remains partial even after its terminal page.
- Configured GitHub repositories are explicit, on-demand sources. Their coverage applies only to those named public repositories.
- SkillsMP and well-known hostname discovery remain visibly `not-configured` until their enumeration or transport requirements can be met safely.

Stale, failed, credentials-required, and not-configured sources keep their previous provenance visible, but their retained counts are not represented as current coverage.

### No skill authorship or body storage

Aisle's catalog contains only records for already-public upstream skills. Connectors may fetch bounded public artifacts transiently to validate schemas, inventory exact files, calculate hashes, inspect licensing, and run static checks. The catalog persists source metadata, immutable references, hashes, file fingerprints, license-evidence metadata, and trust/audit results—not `SKILL.md` bodies or copied skill trees.

Installation resolves back to the verified immutable upstream source. Aisle packages are editorial reference manifests over existing skill revisions; they are not newly authored skills.

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
