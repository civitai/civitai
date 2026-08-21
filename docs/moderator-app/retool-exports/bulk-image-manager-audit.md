# Bulk Image Manager — coverage classification

All 40 queries bucketed per the migration skill's §2, before any code.

**What the app is.** Find a batch of images by one of five sources, select some, act on the batch.
That is the whole shape: five finders, one grid, a row of bulk actions. Everything else is Retool
plumbing or an action already ported during the User Lookup and User Reports slices.

## The five finders — this is the real work

| Source | Retool queries | Notes |
| --- | --- | --- |
| Post | `PostQuery` | by `Post.id` |
| Model | `FindModelVersions` → `FindPosts` → `FindmagesFromPosts` | three chained queries = every image across every version of a model |
| Model version | `MVFindPost` → `MVFindImages` | two chained |
| Collection | `CollectionQuery` | via `CollectionItem` |
| User | `UserQuery`, `UsernameQuery`, `UserQuery5000` | id / username / a 5000-row variant |

Retool chained these because a Retool query cannot join to another query's output; here each is one
query with a join, so the five collapse to five service functions rather than ten.

`Source`/`Link` columns are dropped: they hardcode `image.civitai.com` and — in `PostQuery` —
**`civitai.red`**, so a moderator clicking through from that one lands on the wrong site. The app
builds media URLs through `$lib/media/edge-url` and entity links through `$lib/entity-url`.

## Classification of all 40

### port (12)

`PostQuery`, `FindModelVersions`, `FindPosts`, `FindmagesFromPosts`, `MVFindPost`, `MVFindImages`,
`CollectionQuery` — the five finders above.

`UserQuery5000` — **not** covered by `resolveUserId`, which resolves an identifier to an id and
carries none of this query's `WHERE i."nsfwLevel" = 32`. That value is what `handleBlockImages` sets,
so the query lists what has already been REMOVED from an account: the restore path. Ported as the
`userRemoved` source.

`RemoveArrayOfImages`, `RestoreArrayOfImages`, `query39` — the `textArea5` path, a pasted list of
image ids. Classifying these under the remove/restore endpoints named the endpoint but dropped the
ENTRY POINT: a ticket or a script hands over ids, not a post. Ported as the `imageIds` source.

`TogglePoIMakeSureToEdit` — the POI flag toggle. Its Retool name is a warning that it was edited in
place and easy to get wrong; ported as an explicit action.

`GetBulkRemoveImageUserIdsForNotifs` — the distinct owners of a removed batch, so one notification per
affected user rather than one per image.

### equivalent (17) — shipped, name the winner

| Query | Covered by |
| --- | --- |
| `RemoveImages`, `RemoveImages2` | `/api/mod/remove-images` (a `WebhookEndpoint`), which owns the block side effects |
| `RestoreImages` | `/api/mod/restore-images` |
| `nukeUser` | `/api/mod/remove-images` with `userId` and no `imageIds` — images only. **Do not confuse with `nukeUser3`/`purgeAllContent`**, which also removes models, posts, articles and comments. |
| `nukeUser3` | `purgeAllContent` → `/api/mod/remove-all-content`, ported in cluster B |
| `InsertStrike`, `LogStrike`, `UserStrikes` | `addUserStrike` / `getUserStrikes` |
| `SendNotification2`, `PostNotification`, `SendCorrectNotif` | `sendModNotification` |
| `UserQuery`, `UsernameQuery` | `resolveUserId` resolves id / username / email in one |
| `ReportOnUser` | `getReportsOnUser` (`user-reports.service.ts`) |
| `LogTos`, `LogRestore` | `ModActivity` via `recordModActivity`, as every ported action does |

### plumbing (14)

`query30`, `query31`, `query39`, `log`, `RunAtStart`, `UnselectAll`, `UnselectAll2`,
`UpdateAfterDelete`, `UpdateAfterRestore`, `TOSImages`, `DisableApp`, `DisableAppRestore`,
`EnableApp`, `EnableApp2` — batching, selection state, and Retool locking its own UI mid-batch. A form
action and a `SvelteSet` do all of it.

### superseded (0) · blocked (0)

## Decisions taken without asking

**Bulk actions go through the main app's endpoints, not local Kysely.** `remove-images` and
`restore-images` are `WebhookEndpoint`s that run `handleBlockImages`/`handleUnblockImages` — search
index sync, nsfwLevel recomputation, ClickHouse tracking. Reimplementing that here would be a second
source of truth for the destructive path. This matches what Retool did and what `purgeAllContent`
already does.

**Selection is multiselect, matching Retool.** `ImageQueueGrid` already supports it via a `selected`
set; the app's per-card-immediate convention is for triage queues, and this app is explicitly a batch
tool.

**Notifications are per affected user, not per image.** `GetBulkRemoveImageUserIdsForNotifs` exists
precisely because a 300-image removal spanning 40 accounts must not send 300 notifications.

## Known gaps, deliberately left open

**The image-only "nuke this account" is not available here.** `nukeUser` POSTs `remove-images` with a
`userId` and no `imageIds`, so the endpoint blocks every image the account owns in one call. The port
always sends an id list, and the user source caps at 200 — so an account with 5,000 images cannot be
cleared from this page. Not added because an unbounded mass-delete behind one button is the single
most dangerous thing this page could grow, and it has never been exercised here. The
`userRemoved` source makes the aftermath auditable, which is the half that was missing. **Decide
before mods rely on it:** either add it with its own confirmation, or point them at User Lookup's
purge (which is broader — it also takes models, posts, articles and comments).

**Remove/restore counts are rows FOUND, not rows CHANGED.** `handleBlockImages` returns its `findMany`
result, so re-removing an already-blocked batch reports "Removed 300 images." The zero-check only
fires on ids that do not exist. Fixing it properly means changing the main-app endpoint to report
rows affected — out of scope for a spoke migration.

**The combined "remove + strike the owner" action is not ported.** Retool's `UnselectAll` reset a
`strikeCheckbox` alongside the selection, so a removal could strike in the same gesture. Strikes live
on User Lookup and User Reports here; from a batch spanning several accounts the moderator has to
visit each owner. The owner list on this page is the input for that.

## Note on the export

Extracted 2026-08-06, **before `extract.mjs` emitted widget option sets**. With 60 components this is
a real gap — the violation-type and reason dropdowns that `remove-images` accepts
(`violationType`, `violationDetails`) are exactly what that section would carry, and they are not in
any query. **Re-extract before trusting the action set**; the removal reason may be a fixed list
rather than free text.
