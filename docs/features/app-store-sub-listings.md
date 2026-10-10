# App Store sub-listings

A parent app can place individual items it contains (for example, one generator inside
`custom-generators`) into the `/apps` store as their own cards, badged "in ‹Parent›". The
item's author publishes it from inside the app; a moderator approves it. An off-site parent's
platform instead syncs its catalog server-to-server ([Catalog sync](#catalog-sync-off-site-parents)).

## Data

Two tables, created by `packages/civitai-db-schema/prisma/migrations/20261010120000_app_sub_listings/migration.sql`
(manual apply, like every migration here):

- `app_sub_listing_parents` — one row per parent listing allowed to carry sub-listings:
  `enabled`, `max_per_author` and, for an off-site parent, `link_template` (added by
  `packages/civitai-db-schema/prisma/migrations/20261015120000_app_sub_listing_catalog_sync/migration.sql`).
  No row, or `enabled = false`, means the app cannot publish and the store shows none of its
  children. Parent rows are created by hand (the migration seeds the first).
- `app_sub_listings` — one row per item, unique on `(parent_listing_id, item_key)`, where
  `item_key` is the app's shared-storage row key (for an off-site parent, the item's id on its
  platform). There is no URL column: an on-site card links to
  `/apps/run/<parent slug>/<sub_path>?sl=<id>`, an off-site card to the parent's `link_template`
  with `{id}` replaced by the item's id, both built server-side.

Statuses: `pending` → `approved` by a moderator; `hidden` is a moderator lock the app cannot
lift; `withdrawn` is set by the author (or the in-app withdraw) and returns on republish as
`pending`. There is no auto-approve: every new or republished item waits for a moderator.

**Edits to an approved item do not take it out of the store.** The proposed version is staged in
the `pending_*` columns (a complete snapshot while `pending_submitted_at` is set) and the live
columns keep serving the last approved version. A moderator approves the edit (copied onto the
live columns) or rejects it (cleared, with an optional reason in `edit_rejection_reason`). A new
edit overwrites a staged one; an edit identical to the live version clears it.

## Publishing (block token, scope `apps:store:items:write`)

| Endpoint                                    | Body                                                          | Returns                       |
| ------------------------------------------- | ------------------------------------------------------------- | ----------------------------- |
| `POST /api/v1/blocks/sub-listings/upsert`   | `itemKey, title, tagline?, imageId?, subPath, contentRating?` | `{ id, status, pendingEdit }` |
| `POST /api/v1/blocks/sub-listings/withdraw` | `itemKey`                                                     | `{ ok, withdrawn }`           |
| `GET /api/v1/blocks/sub-listings/mine`      | —                                                             | the caller's items + status   |

The parent is the calling app's own listing, from the token. A publish requires: an enabled
parent row; a signed-in subject passing the shared-write trust check; an item that exists in the
app's shared storage, is not hidden and was authored by the caller; a title (1–80) and tagline
(≤140) that pass cleaning and the shared text-safety check; an image the caller owns that is
publicly visible (the anonymous-viewer read of `getImage`: in a published, non-private post and
reviewed), else 400 `image_not_public`; a `subPath`
of one to four `[A-Za-z0-9_-]` segments; and a rating no less mature than the parent's (unset
inherits it). Limits: 30/hour and 100/day per user per parent, `max_per_author` active items,
8 KB body. While the tables are absent the endpoints answer 503. An upsert that keeps losing a
race with another write to the same item answers 409 (`conflict`) after three attempts.

The scope is sensitive (manifests must justify it), consent-exempt (the checks above are the
gate) and never minted for dev, tunnel or review tokens.

An in-app author withdraw of the shared row withdraws the store item, and a moderator hide or
delete of the shared row hides it (an item already withdrawn stays withdrawn), from the server
and best-effort.

## Catalog sync (off-site parents)

An off-site listing linked to an OAuth client (`connect_client_id`) can carry the items of the
platform behind it, for example the games on a games site. The platform's server authenticates
as that client and keeps the store in step with its own catalog.

**Setup, by a moderator:** the listing is approved and linked to the client; its
`app_sub_listing_parents` row is enabled and has a `link_template`: an https URL with exactly one
`{id}`, e.g. `https://games.example.com/?game={id}`. The client is confidential and has
`client_credentials` in its grants and `AppStoreCatalogWrite` (268435456) in its allowed scopes.
Those two client settings can only be set by hand, and editing the client's scopes in the OAuth
apps page drops the bit.

**Token:** the client-credentials grant on the hub's token endpoint, asking for
`scope=268435456`. The token carries `AppStoreCatalogWrite` and `UserRead` only, lives an hour and
has no refresh token; see `docs/auth/oauth-developer-docs.md` → Client Credentials Flow.

```
POST https://auth.civitai.com/api/auth/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=<client id>&client_secret=<client secret>&scope=268435456
```

**Endpoints.** Every call sends `Authorization: Bearer <access token>`; cookies and `?token=` are
not read and there is no CORS. The token's client selects the parent: the one approved,
top-level, off-site listing linked to it with an enabled parent row and a template. Nothing in the
path or body names it.

| Endpoint                                     | Body                                                 | Returns                             |
| -------------------------------------------- | ---------------------------------------------------- | ----------------------------------- |
| `PUT /api/v1/catalog/items/{externalId}`     | `title, tagline?, contentRating?, creatorUserId?`    | `{ id, status, pendingEdit, href }` |
| `DELETE /api/v1/catalog/items/{externalId}`  | —                                                    | `{ ok, withdrawn }`                 |
| `GET /api/v1/catalog/items?cursor=`          | —                                                    | `{ items, nextCursor }`             |

`externalId` is 1-64 letters, digits, `_` or `-`; it is both the item key and the card's `{id}`.
The PUT body is strict (unknown keys are 400) and at most 8 KB. The listing lists 100 items per
page, oldest first, each as `externalId, id, status, title, creatorUserId, pendingEdit,
statusReason, editRejectionReason, updatedAt`.

A PUT follows the same rules as an in-app publish: a new item, or a withdrawn one republished,
waits for a moderator; an edit to an approved item is staged and the live card keeps serving; a
hidden item answers `200` with `status: "hidden"` (to its own creator) and is not changed. An
identical re-sync writes nothing and is not rate limited. The title (1-80 characters) and tagline
(at most 140) go through cleaning and the shared text-safety check (never as a moderator), and the
rating may not be less mature than the parent's. There are no item images yet: the card shows the
parent's cover.

The author is the listing's owner, or `creatorUserId` when that user has signed in to the platform
with Civitai (an OAuth consent to the token's client). Either must pass the shared-write trust
check. An existing item is never re-attributed. A DELETE withdraws the item whoever authored it
and never lifts a hide; a hidden item it targets can afterwards only be restored to review, not
straight back into the store. Deleting an unknown or already withdrawn item changes nothing and is
not rate limited.

| Status | Code                                                       | When                                                                                      |
| ------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 401    | `invalid_token`                                            | missing, unknown, expired or non-OAuth token, or a token sent anywhere but the header     |
| 403    | `insufficient_scope`                                       | no `AppStoreCatalogWrite`, or not a client-credentials token of its client                |
| 403    | `not_enabled`                                              | no listing qualifies as the client's parent (see Endpoints above)                         |
| 409    | `parent_ambiguous`                                         | more than one (a configuration error)                                                     |
| 400    | `invalid_body`, `text_rejected`, `rating_too_loose`        | as named                                                                                  |
| 403    | `creator_not_linked`, `untrusted`                          | the creator has no consent to the client, or fails the trust check                        |
| 404    | `creator_not_found`                                        | the creator's account is gone                                                             |
| 409    | `author_mismatch`, `conflict`                              | the item belongs to another creator; the item kept changing while saving                  |
| 429    | `rate_limited` (with `Retry-After`), `author_cap`          | 600/hour and 3000/day writes per parent; `max_per_author` active items per creator        |
| 503    | `unavailable`                                              | the tables or the `link_template` column are not applied yet                              |

**Off-switches**, fastest first: disable the parent row (the endpoints answer 403 at once); remove
`client_credentials` from the client's grants (no new tokens; live ones expire within the hour);
rotate the client secret.

## Store read path

`listAvailableListings` takes `includeSubListings`. `appListings.listAvailable` sets it only when
the caller opts in (`input.includeSubListings`, sent by the `/apps` store grid alone) AND the
`app-store-sub-listings` flag is on for the viewer, so other callers (the related-apps rail on a
detail page) only ever get app cards. With it, the keyset runs over the union of listings
and approved children. Both arms apply `storeEligibilityWhere` to the **parent** row, so a child
is visible only when its parent is; the child arm adds the parent switch, its own status, an
approved backing block (for an off-site parent, a `link_template` instead), an author who is not
banned or deleted, and the maturity gate on its own rating. Before the `link_template` column is
applied, off-site parents show no children. A parent sorts before its
children on equal sort keys. Cards render the live columns, the stricter of the two ratings, and
the item image only when it is cleared for the viewer (otherwise the parent's cover); hydration
re-checks the item's status, its author and, for an off-site parent, its link template, so a
change after the page was cached hides the card on the next render. A missing table falls back to
parents only. The public `GET /api/v1/apps` catalog never includes them.

Opening an on-site sub-card records the parent's `App_Open` event with `subListingId` added. An
off-site card opens its platform in a new tab and records nothing.

## Moderation

`/apps/review` → **Sub-listings**, for the same moderators as the app queue (`isAppReviewer` on
the page, `moderatorProcedure` on `appListings.listSubListingQueue`, `countSubListingQueue` and
`moderateSubListing`). The tab shows a pending count (new items plus staged edits). Actions:
approve, hide (with a reason), restore, approve edit, reject edit; each records
`moderated_by_id` / `moderated_at`. A decision carries the version of the row the moderator was
shown, so an author edit that lands in between is refused (409) rather than approved unseen.
Restoring an item that was never approved returns it to review, not to the store. An item whose
shared row is hidden or gone in the app (e.g. hidden by the in-app moderation sync) cannot be
restored (409) until the row is live again; an off-site parent's items have no shared row, so
that check does not apply to them. For an off-site parent's item the queue shows the link the
card opens instead of its path.
