# Install plan and command generation

The install planner is a pure server-side boundary between persisted catalog
resolution and the future API/UI. It does not query a registry, accept a URL,
or accept browser-provided command text. Its input is strict metadata for
already-resolved public GitHub revisions plus explicit install options.

## Fail-closed input

A selection is rejected unless all of these facts are present and valid:

- the exact catalog revision is current and confirmed public;
- validation passed and the revision is neither blocked nor quarantined;
- license evidence is verified;
- every requested agent is both supported by `skills@1.5.19` and compatible
  with the revision;
- the CLI `--skill` selector is proven unique within that repository at the
  same commit the catalog scanned; and
- the selection has no duplicate revision, canonical-revision conflict, or
  normalized-name collision with another source.

The API integration must produce this evidence from durable catalog state in
the same transaction that resolves revision IDs. Browser-provided sources,
flags, shell fragments, observed hashes, and eligibility assertions must never
be passed through.

## Pinned executable contract

Every operation is represented first as `file: "npx"` and an argument array:

```text
npx --yes skills@1.5.19 add owner/repo \
  --skill exact-name --agent codex --copy --yes
```

Skills are grouped by lower-cased GitHub `owner/repo`; repositories, skills,
and agents are sorted deterministically. `--skill` and `--agent` are always
explicit, and `--all` is forbidden. Global scope adds `--global`. Project scope
is the CLI default and therefore adds no flag. Copy mode adds `--copy`; symlink
mode is the pinned CLI default and there is no supported `--symlink` flag.

The planner caps skills, repositories, agents, and the final command length.
It emits one single-line command for POSIX shells, PowerShell 7, Windows
PowerShell 5.1, and cmd.exe. Every argv item is quoted independently. POSIX,
PowerShell 7, and cmd use process-level `&&`; PowerShell 5.1 uses a guarded
script block that checks `$?` and `$LASTEXITCODE` after every process.

## Deliberate limitations

The output makes these semantics machine-readable:

- `atomic: false` — completed repositories are not rolled back;
- `failFastBoundary: "process-exit-status-only"` — chaining stops only when a
  CLI process reports failure;
- `runtimeCompletenessVerified: false` and `partialInstallPossible: true` — a
  partial selector match is not proof that every requested skill installed;
- `agentFailureMayExitZero: true` — an individual agent failure may not fail
  the CLI process; and
- `sourceRevisionEnforced: false` — observed commits and content digests are
  provenance, not a pin enforced by the generated command.

The CLI package is pinned, but the GitHub source remains the publisher's
current default branch. Arbitrary commit SHAs are not emitted because this CLI
release uses a shallow branch clone and cannot reliably enforce them. Users
need Node.js 22.20.0 or newer for the pinned release.

Primary implementation evidence:

- [skills add implementation at the audited commit](https://github.com/vercel-labs/skills/blob/777599e1159e401b11ce4c8a57c20f09a8f1596e/src/add.ts)
- [source parsing at the audited commit](https://github.com/vercel-labs/skills/blob/777599e1159e401b11ce4c8a57c20f09a8f1596e/src/source-parser.ts)
- [Git clone behavior at the audited commit](https://github.com/vercel-labs/skills/blob/777599e1159e401b11ce4c8a57c20f09a8f1596e/src/git.ts)
