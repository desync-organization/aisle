# Profile collections

Collections are user-curated, public sets of existing catalog skills. The device-local index lives at `/profile`; public share pages remain at `/collections/[slug]`. The `/collections` index redirects to `/profile` for now.

## Anonymous ownership today

- `POST /api/v1/collections` accepts a bounded name and 1–64 canonical catalog skill IDs.
- The server verifies that every referenced skill is still public and present before writing anything.
- A random public slug identifies the share page. It is safe to disclose.
- A separate random owner token is returned once to the creating browser. Only its SHA-256 hash is stored in the database.
- The browser keeps the owner token and a local index of every collection created on that device. The database remains the authoritative collection store.
- A browser with that owner token can add another verified public skill through `POST /api/v1/collections/[slug]/members`. The token is sent as a bearer credential and is never placed in the share URL.
- The anonymous owner token is a long-lived browser credential. Until account ownership replaces it, Aisle avoids third-party browser scripts and treats same-origin script access as part of the anonymous-ownership risk.

Collection IDs, slugs, and share URLs stay stable when an owner adds a skill. Each change rechecks ownership, catalog availability, the 64-skill limit, and the latest collection version inside the database transaction. Visitors with the public link can view the updated collection but cannot edit it.

## Account migration later

`collections.owner_kind` distinguishes anonymous and account ownership. A future authenticated claim operation can verify the anonymous owner token, set `owner_kind` to `account`, attach `owner_account_id`, and clear `owner_token_hash`. The collection ID, members, slug, and public URL do not need to change.

Authentication must remain responsible for account identity and sessions. Collection code should only consume a verified account identifier at that boundary.
