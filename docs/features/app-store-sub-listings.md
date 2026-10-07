# App Store sub-listings

A parent app can place individual items it contains (for example, one generator inside
`custom-generators`) into the `/apps` store as their own cards, badged "in ‹Parent›". The
item's author publishes it from inside the app; a moderator approves it.

## Data

Two tables, created by `packages/civitai-db-schema/prisma/migrations/20261010120000_app_sub_listings/migration.sql`
(manual apply, like every migration here):

- `app_sub_listing_parents` — one row per parent listing allowed to carry sub-listings:
  `enabled` and `max_per_author`. No row, or `enabled = false`,
  means the app cannot publish and the store shows none of its children. Parent rows are created
  by hand (the migration seeds the first).
- `app_sub_listings` — one row per item, unique on `(parent_listing_id, item_key)`, where
  `item_key` is the app's shared-storage row key. There is no URL column: the card links to
  `/apps/run/<parent slug>/<sub_path>?sl=<id>`, built server-side.

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

## Store read path

`listAvailableListings` takes `includeSubListings`. `appListings.listAvailable` sets it only when
the caller opts in (`input.includeSubListings`, sent by the `/apps` store grid alone) AND the
`app-store-sub-listings` flag is on for the viewer, so other callers (the related-apps rail on a
detail page) only ever get app cards. With it, the keyset runs over the union of listings
and approved children. Both arms apply `storeEligibilityWhere` to the **parent** row, so a child
is visible only when its parent is; the child arm adds the parent switch, its own status, an
approved backing block, an author who is not banned or deleted, and the maturity gate on its
own rating. A parent sorts before its
children on equal sort keys. Cards render the live columns, the stricter of the two ratings, and
the item image only when it is cleared for the viewer (otherwise the parent's cover); hydration
re-checks the item's status and its author, so a change after the page was cached hides the card
on the next render. A missing
table falls back to parents only. The public `GET /api/v1/apps` catalog never includes them.

Opening a sub-card records the parent's `App_Open` event with `subListingId` added.

## Moderation

`/apps/review` → **Sub-listings**, for the same moderators as the app queue (`isAppReviewer` on
the page, `moderatorProcedure` on `appListings.listSubListingQueue`, `countSubListingQueue` and
`moderateSubListing`). The tab shows a pending count (new items plus staged edits). Actions:
approve, hide (with a reason), restore, approve edit, reject edit; each records
`moderated_by_id` / `moderated_at`. A decision carries the version of the row the moderator was
shown, so an author edit that lands in between is refused (409) rather than approved unseen.
Restoring an item that was never approved returns it to review, not to the store. An item whose
shared row is hidden or gone in the app (e.g. hidden by the in-app moderation sync) cannot be
restored (409) until the row is live again.
