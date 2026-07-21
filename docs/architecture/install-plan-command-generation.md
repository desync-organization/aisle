# Install plan and command generation

The install planner is a pure server-side boundary between persisted catalog
resolution and the stack preflight/resolve APIs. It does not query a registry,
accept a URL, or accept browser-provided command text. Its input is strict
metadata for already-resolved public GitHub revisions plus explicit install
options.

## Fail-closed input

A selection is rejected unless all of these facts are present and valid:

- the exact catalog revision is current and confirmed public;
- validation passed and the revision is neither blocked nor quarantined;
- license evidence is verified;
- every requested agent is a destination supported by the pinned
  `skills@1.5.19` release; the upstream freeform `compatibility` text is shown
  as an advisory and is not treated as an agent allowlist;
- the GitHub owner/repository, single-segment branch, relative discovery path,
  and observed branch-head SHA form an explicit verified discovery scope;
- the CLI `--skill` selector is proven unique within that exact scope at the
  observed current branch head;
- the selector's verified scope, the source scope, and the observed artifact
  commit are identical; and
- the selection has no duplicate revision, canonical-revision conflict, or
  normalized-name collision with another source.

The API first snapshots durable candidate identities in a short database
transaction, closes that transaction, and then performs live verification.
Both preflight and resolve refetch the current branch HEAD and one bounded
recursive GitHub tree. Repository checks use bounded concurrency and an overall
deadline; any group that cannot finish becomes unavailable. The observed HEAD
must still equal the stored commit, the tree must be complete and non-truncated,
and the selected discovery scope must contain exactly one non-symlink
`SKILL.md` at the persisted skill path.

After the network work, the API opens a fresh transaction and rereads every
catalog row and warning. A verified result is accepted only when its selection,
owner, repository, branch, path, and persisted HEAD identity exactly reproduce
the initial candidate. Equality with the immutable Git commit then binds the
already-scanned artifact, license evidence, and selector name to that live
tree. Unavailable verification, a moved branch, an identity change, or an
ambiguous scope fails closed. Browser-provided sources, refs, paths, flags,
shell fragments, observed hashes, and eligibility assertions are never passed
through.

Current source observations are also completion-bound. A listing last seen by
a still-running crawl cannot make a revision selectable; its run must have a
finished `succeeded` or `partial` state. Sources using latest-completed-
observation freshness additionally require the catalog's completed-observation
certificate after the catalog freshness migration is integrated. The merge
hook is explicit: require `last_completed_observation_run_id` to equal the
latest run for that source whose `observation_sweep_complete = 1`,
`finished_at is not null`, and status is `succeeded` or `partial`. The base
branch cannot reference those columns before that migration lands.

### Backend evidence shape

Each resolved selection now requires both `source.discoveryScope` and
`installer.verifiedDiscoveryScope`, with the same shape:

```text
{ branch, path, branchHeadSha }
```

`observed.commitSha` must equal `branchHeadSha`. The persisted branch-head value
is not sufficient by itself; the API supplies it to the live verifier as the
expected value and rejects any mismatch. The former
`installer.verifiedAtCommitSha` field is no longer accepted because a commit
alone did not prove which branch/path boundary was searched. The backend must
persist and supply the complete scope evidence; the planner derives
`sourceUrl` and never accepts one as input.

## Pinned executable contract

Every operation is represented first as `file: "npx"` and an argument array:

```text
npx --yes skills@1.5.19 add \
  https://github.com/freshtechbro/claudedesignskills/tree/main/.claude/skills \
  --full-depth --skill gsap-scrolltrigger --agent codex --copy --yes
```

The source URL is generated only from validated GitHub owner/repository,
branch, and path fields. It never comes from browser text. The pinned CLI's
GitHub tree parser treats the first segment after `/tree/` as the branch, so
the contract deliberately accepts only safe single-segment branch names.
Paths are safe relative POSIX directory paths; traversal, backslashes,
encoded separators, URL punctuation, and absolute paths are rejected.

Live checks are grouped by lower-cased owner/repository and case-sensitive
branch so one bounded GitHub HEAD/tree observation can validate multiple
selected paths. Install selections are grouped only when lower-cased
owner/repository, case-sensitive branch and path, and `branchHeadSha` all
match. Each exact scope gets one CLI process. Scopes, skills, and agents are
sorted deterministically. Every process uses `--full-depth`; `--skill` and
`--agent` are always explicit, and `--all` is forbidden. Global scope adds
`--global`. Project scope is the CLI default and therefore adds no flag. Copy
mode adds `--copy`; symlink mode is the pinned CLI default and there is no
supported `--symlink` flag.

The planner caps skills, discovery scopes, agents, and the final command length.
The discovery-scope ceiling equals the 64-skill ceiling because every selected
skill can legitimately come from a different verified repository/path scope.
This also accommodates the launch package set's 46 members across 17 distinct
repositories. The rendered command-length cap remains the final pasteability
bound.
It emits one single-line command for POSIX shells, PowerShell 7, Windows
PowerShell 5.1, and cmd.exe. Arguments are quoted independently. The cmd.exe
renderer uses the fixed trusted executable token `npx.cmd` without quotes;
quoting `"npx"` can select Node's extensionless Unix shim on Windows. POSIX,
PowerShell 7, and cmd use process-level `&&`; PowerShell 5.1 uses a guarded
script block that checks `$?` and `$LASTEXITCODE` after every process.

## Deliberate limitations

The output makes these semantics machine-readable:

- `atomic: false` — completed repositories are not rolled back;
- `failFastBoundary: "process-exit-status-only"` — chaining stops only when a
  CLI process reports failure;
- `runtimeCompletenessVerified: false` and `partialInstallPossible: true` — a
  partial selector match is not proof that every requested skill installed;
- `pathScopeEnforced: true` — the generated branch/path URL constrains where
  the CLI performs full-depth discovery;
- `allSelectorsRuntimeEnforced: false` — the CLI does not guarantee that every
  requested selector matched before reporting overall success;
- `agentFailureMayExitZero: true` — an individual agent failure may not fail
  the CLI process;
- `sourceRevisionEnforced: false` — observed commits and content digests are
  provenance, not a pin enforced by the generated command; and
- `mutableSourceRacePossible: true` — even after the backend confirms the live
  branch HEAD, the verified branch may advance before the CLI clone starts.

The CLI package and branch name are explicit, but the source revision remains
mutable. Commit-shaped branch tokens are rejected and the planner never emits
`/tree/<commit>`. Arbitrary commit SHAs are not emitted because this CLI
release performs a shallow branch clone and the generated command cannot
honestly enforce the scanned revision. Users need Node.js 22.20.0 or newer for
the pinned release.

Interoperability fixtures cover the audited public layouts without copying any
skill body: Freshtech at `.claude/skills`, Microsoft Azure Skills at `skills`,
and Impeccable at `.agents/skills/impeccable`.

Primary implementation evidence:

- [skills add implementation at the audited commit](https://github.com/vercel-labs/skills/blob/777599e1159e401b11ce4c8a57c20f09a8f1596e/src/add.ts)
- [source parsing at the audited commit](https://github.com/vercel-labs/skills/blob/777599e1159e401b11ce4c8a57c20f09a8f1596e/src/source-parser.ts)
- [Git clone behavior at the audited commit](https://github.com/vercel-labs/skills/blob/777599e1159e401b11ce4c8a57c20f09a8f1596e/src/git.ts)
