# Aisle

Aisle is a public Agent Skills marketplace for discovering existing skills, assembling them into a stack, and installing that stack with one command.

The project is in its foundation phase. Catalog ingestion, curated packages, and the installer will land in later changes. Aisle does not author, generate, or modify skills. See [the public catalog policy](docs/architecture/public-catalog-policy.md).

## Development

Requirements:

- Node.js 20.9 or newer
- npm 11

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

## Catalog invariant

Only already-public upstream Agent Skills may become installable. Packages will contain references to immutable upstream revisions, never copied or synthesized skill content.
