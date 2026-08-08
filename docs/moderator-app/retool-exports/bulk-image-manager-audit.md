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

### port (9)

`PostQuery`, `FindModelVersions`, `FindPosts`, `FindmagesFromPosts`, `MVFindPost`, `MVFindImages`,
`CollectionQuery` — the five finders above.

`TogglePoIMakeSureToEdit` — the POI flag toggle. Its Retool name is a warning that it was edited in
place and easy to get wrong; ported as an explicit action.

`GetBulkRemoveImageUserIdsForNotifs` — the distinct owners of a removed batch, so one notification per
affected user rather than one per image.

### equivalent (17) — shipped, name the winner

| Query | Covered by |
| --- | --- |
| `RemoveImages`, `RemoveImages2`, `RemoveArrayOfImages` | `/api/mod/remove-images` (a `WebhookEndpoint`), which owns the block side effects |
| `RestoreImages`, `RestoreArrayOfImages` | `/api/mod/restore-images` |
| `nukeUser`, `nukeUser3` | `purgeAllContent` → `/api/mod/remove-all-content`, ported in cluster B |
| `InsertStrike`, `LogStrike`, `UserStrikes` | `addUserStrike` / `getUserStrikes` |
| `SendNotification2`, `PostNotification`, `SendCorrectNotif` | `sendModNotification` |
| `UserQuery`, `UsernameQuery`, `UserQuery5000` | `resolveUserId` resolves id / username / email in one |
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

## Note on the export

Extracted 2026-08-06, **before `extract.mjs` emitted widget option sets**. With 60 components this is
a real gap — the violation-type and reason dropdowns that `remove-images` accepts
(`violationType`, `violationDetails`) are exactly what that section would carry, and they are not in
any query. **Re-extract before trusting the action set**; the removal reason may be a fixed list
rather than free text.
