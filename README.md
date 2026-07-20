# Aisle

Aisle is a public Agent Skills marketplace for discovering existing skills, assembling them into a stack, and installing that stack with one command.

The project is in its foundation phase. Catalog ingestion, curated packages, and the installer UI will land in later changes. The isolated install planner already turns server-resolved eligible selections into deterministic argv operations and shell-safe commands; see [its architecture contract](docs/architecture/install-plan-command-generation.md). Aisle does not author, generate, or modify skills. See [the public catalog policy](docs/architecture/public-catalog-policy.md).

## Development

Requirements:

- Node.js 20.9 or newer
- npm 11.16 (the version declared by `packageManager` and used in CI)

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

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
- `lib/` — environment and future catalog boundaries
- `docs/architecture/` — product invariants and architecture decisions

The shared colors, type, interaction states, and component accessibility contracts are documented in [the visual-system guide](docs/design-system.md).

## Catalog invariant

Only already-public upstream Agent Skills may become installable. Packages will contain references to immutable upstream revisions, never copied or synthesized skill content.
