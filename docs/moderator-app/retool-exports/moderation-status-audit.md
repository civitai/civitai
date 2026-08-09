# Moderation Status — coverage classification

All 77 queries bucketed per the migration skill's §2, before any code.

**What the app is.** Not a lookup tool — a **board**. Five unrelated things share one Retool page
because Retool made tabs cheap, and the tracker already says to port them independently. Grouping them
here is the point of this pass: as one page it is 77 queries, as five it is five small slices, three of
which are already largely built.

| Group | Queries | State |
| --- | --- | --- |
| A. Help requests | 3 | **Unblocked and built in this slice** |
| B. Queue stats / throughput | 21 | Overlaps the existing dashboard |
| C. Report triage | 6 | Largely shipped |
| D. Rating / tag review | 12 | Largely shipped |
| E. Backfill jobs and timers | 35 | **Not UI** — Retool workflows, cron decision |

## A. Help requests — port (3)

The only group with no counterpart anywhere in the app.

| Query | Notes |
| --- | --- |
| `GetHelpers` | `SELECT * FROM "ModerationImageHelp" WHERE "isHandled" = false` — the open queue. `retool_db`, already typed in `moderator-db-types.ts` (37 rows). |
| `GetImageData` | The images behind the selected request: `WHERE i.id = ANY(<imageIds>)`, returning `needsReview`, `blockedFor`, `ingestion`. `imageIds` is a **jsonb array**, so the port unpacks it rather than trusting a client-supplied list. |
| `UpdateHelpRequest` | GUI-mode write → `ModerationImageHelp`. Marks handled. |

⚠️ `GetImageData` hardcodes `https://civitai.red/images/` — the wrong site, the same defect found in
Bulk Image Manager's `PostQuery`. Links come from `$lib/entity-url` instead.

⚠️ `createdBy`/`handledBy` are **text names, not user ids** — a documented quirk of the Retool schema.
The port preserves it (writing the moderator's username) rather than silently changing the column's
meaning; changing it is part of moving these tables off Retool's database.

## B. Queue stats / throughput — equivalent, mostly (21)

`HourlyImages`, `HourlyModels`, `ArticleCount`, `ArticleTimer`, `BountyCount`, `BountyTimer`,
`ModelCount`, `ModelTimer`, `TrainingCount`, `MinorTimers`, `PoITimers`, `TagTimer`, `FPATaskTimers`,
`RRatingStats`, `TaggerRatio`, `MuteStats`, `RatingTaggers`, `RecentRating`, `RecentTagger`,
`ArticleCheck`, `BountyCheck`.

Counters and two Plotly charts. The moderator dashboard already owns this surface. **Two are worth
lifting because they measure the moderators rather than the queue**, and nothing else does:

- `RRatingStats` — `COUNT(*) FROM "ModActivity" WHERE activity = 'setNsfwLevel' GROUP BY user`: who is
  actually re-rating. Directly meaningful now that Front Page Audit writes exactly that activity.
- `TaggerRatio`, `RatingTaggers` — agreement rate between taggers.

The rest are `COUNT(*) … GROUP BY date_trunc('hour', …)` over the last 200 hours; port only if the
dashboard is missing that view, and as dashboard cards, not a new page.

## C. Report triage — equivalent (6)

`Reports`, `OLDReports`, `RecentReports`, `RecentReportImage`, `UrgentReports`, `GetReported`,
`StoreReported`, `ActionReport`, `ActionAllPostReports`.

`/reports/*` and the dashboard's "Most reported" own this. `UrgentReports` is already shipped.
`ActionReport`/`ActionAllPostReports` remain deliberately un-ported — actioning lives on `/reports`,
which owns the side effects (recorded in the handover).

## D. Rating / tag review — equivalent (12)

`RatingQueue`, `ErrorRatingQueue`, `TagQueue`, `ResearchRating`, `LookUpTags`, `ReviewGrouped`,
`blockedTagInsert`, `blockedTagTimer`, `GetSplitQueue`, `SplitCurrent`, `SplitCatchup`,
`UnpublishingReasons`.

`/images/ratings`, `/images/tags`, `/images/downleveled` and `/blocklists` cover this. **Check before
building anything here** — `ReviewGrouped` and `GetSplitQueue` are the two whose shape I could not
match to an existing page from the SQL alone.

## E. Backfill jobs and timers — NOT UI (35)

`MinorInsert`, `PoIInsert`, `ModelInsert`, `CivitModelInsert`, `newUserInsert`, `newUserTimer`,
`ImageSfwData`, `ImageSfwDataCatchup`, `ImagePG13Data`, `pg`, `pg13`, `pg_catchup`, `r`, `x`, `xxx`,
`FPATaskTimers_catchup`, `TagTimerCatchup`, `StoreMinors`, `StorePoI`, `GetMinors`, `GetPoI`,
`FindSHA`, `LogSHA256`, `BlockedImagesTask`, `TaskCheckerBlocked`, `AutoBlockedUsers`,
`CivitModelCheck`, `CivitModelsData`, `HolidayPostsBulbs`, `ComicReview`, `ModelReview`,
`ArticleReview`, `blockedTagTimer`, and the remaining `*_catchup` variants.

**These are scheduled work, not a page.** They write Retool-only tables (`Mods_TaskTimers`,
`ModerationSHA`) or backfill main-app columns on a timer. Several look like duplicates of existing
main-app jobs.

They belong to the **Workflows decision**, not to this slice — see the handover. Porting any of them
into a page would be building a UI for a cron job.

## Decisions taken without asking

**This slice ports group A only.** B, C and D are already served; E is not UI. Building a
"Moderation Status" page that reproduces Retool's board would mean five unrelated tools behind one
route, which is why the tracker said to split it. Help requests gets its own page, named for what it
does.

**`imageIds` is unpacked server-side.** Retool passed the array through the client
(`select1.data.find(…).imageIds.id`). The port reads the row by id and expands the jsonb itself, so a
moderator cannot be handed a request for one set of images and act on another.

## Open

- `ReviewGrouped` and `GetSplitQueue` (group D) — confirm against `/images/*` before assuming covered.
- Group B's two moderator-performance queries are worth a dashboard card; not built here.
- This export predates both extractor upgrades, so its 197 components carry **no** option sets and
  **no** layout. 51 of them are buttons. Re-extract before trusting that group A is the only gap.
