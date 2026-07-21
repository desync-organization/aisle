# Public catalog, provenance, licensing, and package policy

Status: accepted  
Scope: catalog ingestion, marketplace presentation, curated packages, and installation manifests

## Decision

Aisle is an index and orchestration layer for already-public Agent Skills. It does not author, generate, synthesize, rewrite, improve, translate, or fork skill contents.

Every installable catalog record must resolve to a specific public upstream skill and immutable upstream revision. Aisle packages are ordered reference manifests. They are not new skills and never contain copied `SKILL.md` instructions.

## Truthful coverage

There is no universal registry of every public Agent Skill. Aisle therefore defines coverage as:

> All eligible entries discoverable from each configured enumerable source at its displayed last-successful-sync time, plus clearly labeled results from configured federated or on-demand sources.

The product must never abbreviate that claim to “every skill on the internet.” The coverage page must expose, per source:

- source name and discovery mode (`full`, `incremental`, `federated`, or `on-demand`);
- last successful full or incremental sync time;
- indexed record count and unavailable record count;
- current lag, partial failures, and known exclusions;
- the upstream identifier and terms used to access it.

A source with a stale or failed sync remains visible with that state. Its old count must not be presented as current.

## Eligibility rules

A skill is eligible for catalog discovery when all of the following are true:

1. Its source is reachable through a configured public source without private-repository credentials.
2. Aisle can resolve a stable canonical source URL and skill path.
3. The skill has a `SKILL.md` that passes the supported Agent Skills schema.
4. The skill is not marked internal, private, withdrawn, or quarantined.
5. Aisle can resolve an immutable source revision or content digest before installation.

Public registry API credentials may identify Aisle to that registry. They must never grant access to private skill content.

Records that fail validation may remain as non-installable provenance records when the source previously exposed them. They must not enter packages or selection manifests.

## Canonical identity and revisions

The primary identity is the normalized tuple:

```text
source provider + canonical repository/base URL + normalized skill path
```

Registry IDs and marketplace slugs are aliases, not identity. Each observed immutable commit, version, or content digest creates a separate revision. The current catalog record points to one revision, while past revisions remain available for provenance and audit history.

Exact content hashes provide secondary duplicate detection. A fork or copy remains attributed to its own upstream source and may point at a canonical duplicate. Aisle must not combine popularity, ownership, or security results in a way that hides which source a user will install.

## Upstream metadata and editorial metadata

- Upstream skill names and descriptions are stored verbatim with source attribution.
- Aisle may add categories, compatibility facets, duplicate relationships, and trust state as separately attributed catalog metadata.
- Package titles, descriptions, ordering, and artwork are Aisle editorial content.
- Editorial copy must not imply that Aisle created, maintains, or endorses an upstream skill.

## Licensing and content handling

Public availability is not permission to redistribute.

- Record the upstream license identifier or `unknown` at every revision.
- Install directly from the immutable upstream origin.
- Do not permanently mirror full skill file trees unless the license and source terms permit it.
- Cache the minimum content required for validation and security review under a documented retention policy.
- Link to the source license and original repository from every skill detail view.
- A missing or restrictive license is shown clearly. It does not authorize redistribution.

## Lifecycle

One transient failure cannot remove a skill. A configured number of missed complete crawls moves the record to `unavailable`. A confirmed deletion, visibility change, or upstream withdrawal moves it to `removed`.

Unavailable and removed records retain source, revision, and audit history, but are excluded from search defaults, packages, new selections, and install manifests. If a source becomes public again, ingestion creates or selects a newly verified revision before restoring installability.

## Trust and quarantine

Public does not mean safe. Trust labels have these exact meanings:

| Label | Meaning | Selectable / installable by default |
| --- | --- | --- |
| Official | Published by the organization responsible for the referenced product; source identity verified | No; identity alone is not an exact-revision Aisle assessment |
| Audited / no known findings | Named scanners reported no findings for this exact revision and baseline validation passed | Yes |
| Warning | Review found behavior or permissions requiring explicit user attention | Yes, with explicit acknowledgement |
| Failed | A scanner reported a high-confidence dangerous condition | No |
| Quarantined | Aisle blocked the revision pending investigation or due to confirmed policy violation | No |
| Unreviewed | No current revision-scoped Aisle assessment is available; the record remains discoverable and provenance-visible | No; blocked until baseline validation passes |

The interface must use “no known findings,” not “safe.” Audit results are revision-scoped; a new revision returns to `unreviewed` until baseline validation and assessment complete. Selection fails closed unless the exact revision has a passed baseline validation and an Aisle assessment of `pass` or `warn`; `warn` also requires explicit acknowledgement.

## Package and selection invariants

Package manifests contain only canonical skill and revision references plus editorial ordering/default-selection metadata. Validation must reject a package or selection when any member is:

- unresolved or not public;
- internal, unavailable, removed, failed, or quarantined;
- unreviewed or missing a passed baseline validation and exact-revision `pass` or `warn` assessment;
- missing an immutable revision or expected content hash;
- a duplicate of another selected canonical skill;
- represented by embedded or generated skill content.

Published package versions and generated selection manifests are immutable. Updating a package creates a new version.

## Enforcement points

This policy becomes testable at four boundaries:

1. **Connector validation:** public visibility, schema validity, canonical source, and internal flags.
2. **Revision ingestion:** immutable reference, content hash, license, lifecycle, and revision-scoped trust state.
3. **Package validation:** references only, resolvable active members, no blocked or duplicate skills.
4. **Selection generation:** server-side ID resolution, final eligibility recheck, and a signed immutable manifest.

Any boundary failure must fail closed for installation while preserving enough provenance to diagnose the exclusion.
