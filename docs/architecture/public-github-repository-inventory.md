# Public GitHub repository inventory

Aisle's repository inventory is a bounded discovery input, not a registry or a
coverage claim. The catalog sync builds the inventory from three groups, normalizes
each GitHub URL, and removes duplicates before creating repository connectors:

1. repository origins referenced by the launch package blueprints;
2. researched public-catalog candidates maintained in
   `lib/catalog/public-repository-seeds.ts`; and
3. administrator additions from `AISLE_GITHUB_REPOSITORIES`.

The first two groups form the default inventory. At this revision they contain 23
distinct repository candidates.

## Launch package origins

- `https://github.com/anthropics/skills`
- `https://github.com/cloudflare/security-audit-skill`
- `https://github.com/cloudflare/skills`
- `https://github.com/expo/skills`
- `https://github.com/firebase/agent-skills`
- `https://github.com/freshtechbro/claudedesignskills`
- `https://github.com/giuseppe-trisciuoglio/developer-kit`
- `https://github.com/huggingface/skills`
- `https://github.com/microsoft/azure-skills`
- `https://github.com/microsoft/playwright-cli`
- `https://github.com/neondatabase/agent-skills`
- `https://github.com/obra/superpowers`
- `https://github.com/pbakaus/impeccable`
- `https://github.com/shadcn-ui/ui`
- `https://github.com/supabase/agent-skills`
- `https://github.com/vercel-labs/agent-browser`

## Researched discovery seeds

- `https://github.com/openai/skills`
- `https://github.com/NVIDIA/skills`
- `https://github.com/microsoft/skills`
- `https://github.com/MicrosoftDocs/Agent-Skills`
- `https://github.com/github/awesome-copilot`
- `https://github.com/googleworkspace/cli`
- `https://github.com/vercel-labs/agent-skills`

Inclusion in either list does not assert that a repository is currently public,
contains an eligible Agent Skill, is officially endorsed, or has a usable license.
The lists only authorize bounded discovery attempts.

## Source-relative, fail-closed semantics

- Coverage is relative to the repositories in the normalized inventory and the
  connector's displayed sync state. It does not represent every public GitHub
  repository or every public Agent Skill.
- The GitHub repository connector must independently observe a currently public
  repository, its public default branch, and exact skill paths at one commit.
- A discovered path remains non-selectable unless the existing ingestion pipeline
  also proves its immutable revision and complete bounded inventory, recognizes
  revision-scoped license evidence, validates the skill, and records eligible trust
  evidence without a blocking audit or duplicate binding.
- Missing, private, moved, oversized, malformed, unlicensed, unreviewed, blocked, or
  otherwise unresolved candidates fail closed. A seed never creates a synthetic
  catalog record, package member, or install target.
- Sync persists provenance, hashes, evidence metadata, and audit state. Aisle does
  not add, copy, or author an upstream `SKILL.md` because a repository is seeded.

`AISLE_GITHUB_REPOSITORIES` extends the default inventory for an operator-controlled
deployment. Its entries pass through the same normalization, deduplication, discovery,
and selection gates as every built-in candidate.
