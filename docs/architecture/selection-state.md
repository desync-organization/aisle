# Shared skill selection state

The Skills explorer, featured packages, and future install review must use one
client-side selection store. The store carries only opaque Aisle catalog skill
IDs. It never stores upstream URLs, repository coordinates, install commands,
or browser assertions about eligibility.

Browser-held IDs remain untrusted. The install-plan API must resolve every ID
again from durable catalog state, enforce current public/trust/license status,
and generate command argv server-side.

## Contracts and limits

- IDs are 1–128 character bounded ASCII tokens with no path separators,
  whitespace, shell metacharacters, or executable URL schemes.
- A selection contains at most 64 IDs.
- `toggle`, `addMany`, `remove`, `replace`, and `clear` all operate on the same
  store. Mutations are all-or-nothing, sorted, and deduplicated.
- Package “Add All” calls `addMany`; skill rows call `toggle`. Neither owns a
  second selection state.

## Persistence and hydration

localStorage uses the strict envelope `{ "version": 1, "ids": [...] }` under
`aisle.selection.v1`. Unknown fields, invalid IDs, corrupt JSON, and old
versions recover to an empty selection; corrupt and old payloads are removed.
Storage access is deferred until `hydrate()`, guarded for SSR and browser
privacy/security failures.

`SelectionProvider` injects a store through a React 19 context. Consumers use
`useSyncExternalStore` with a stable empty server snapshot. The first client
render therefore matches SSR, and the persisted selection appears only after
the provider effect hydrates the store. Consumers receive `state`, `actions`,
and `meta`, including an explicit `hydrated` flag for accessible loading states.

Cross-tab synchronization is intentionally omitted from v1. A partial storage
event implementation would create ordering and stale-tab races; persistence on
reload is deterministic without it.

## Share queries

The codec expects a standalone share query and owns a single `skills` query
field; callers with explorer filters preserve those outside this codec.
Encoding sorts and deduplicates IDs. Decoding rejects URLs, fragments,
repeated fields, unknown fields such as
`source` or `command`, invalid IDs, and values over the shared cap. A present
`skills` field replaces the current selection; an absent field leaves it
unchanged, while `?skills=` explicitly clears it.
