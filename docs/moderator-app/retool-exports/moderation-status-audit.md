# Moderation Status — coverage classification

All 77 queries bucketed per the migration skill's §2.

> **Rewritten 2026-08-10 after the export-vs-build fidelity review.** The previous version was wrong in
> two load-bearing ways and those two errors hid most of this app. They are recorded here rather than
> deleted, because both are mistakes the next classification could repeat:
>
> 1. **"Group E is 35 backfill jobs and timers, not UI."** There is **no `Timer` plugin in the export
>    at all**. Every one of the 35 is fired by a button click. They are not jobs; they are a manual
>    acknowledgement protocol (see group E below).
> 2. **"This export predates the extractor upgrades, so it carries no layout and no option sets."** It
>    carries both. Acting on that sentence is why nobody noticed that **three of the four top-level
>    tabs are unported**.
>
> The old summary table also said group A was "3 | built" while its own body correctly described six
> queries including three producers. Where a doc disagrees with itself, believe the body.

**What the app is.** A **board**, not a lookup tool: several unrelated surfaces share one Retool page.
Splitting it is still right. But "split it" was read as "most of it is already covered elsewhere", and
that does not survive contact with the SQL.

**Fidelity verdict: 8 present, 4 partial/divergent, 4 correctly omitted, 61 absent.** 3 of 77 built.

| Group | Queries | State |
| --- | --- | --- |
| A. Help requests | 6 | Consumer built; **all three producers absent** |
| B. Queue stats / throughput | 21 | Counts exist; the comparison they sat in does not |
| C. Report triage | 6 | 2 confirmed covered, 2 partial, 2 absent |
| D. Rating / tag review | 12 | 2 confirmed covered, 2 had count bugs (fixed), rest absent |
| E. Task acknowledgement protocol | 35 | **Not cron.** Absent, and misclassified |
| Dead in Retool too | 5 | Correctly omitted — no widget binds them |

## Tabs — the structural finding

`tabbedContainer1` has four panes and **one is ported**:

| Pane | State |
| --- | --- |
| Moderation Status | The board itself — counts, lag indicators, `AutoBlockedUsers`. **Absent** |
| Image Help | Built as `/retool/image-help` |
| Graphs | `button43` "Load Graphs" → `HourlyImages`, `HourlyModels`, `RRatingStats`, `ResearchRating`. **Absent** |
| Who is who? | `textArea1` + a nested 3-tab `tabs13`. **Absent, and unscopable from the export** |

Three of the app's six `TableWidget2`s are unaccounted for. `Who is who?` needs a screenshot before it
can be estimated — do not guess from the query list.

## A. Help requests — 6 queries, consumer only

`/retool/image-help` reads `ModerationImageHelp` and marks rows handled. **Nothing writes it.**

| Producer | Batch it files |
| --- | --- |
| `GetMinors` → `StoreMinors` | `Image WHERE needsReview = 'minor' AND ingestion IS NOT NULL` |
| `GetPoI` → `StorePoI` | `Image WHERE needsReview = 'poi' AND ingestion IS NOT NULL` |
| `GetReported` → `StoreReported` | reported images awaiting review |

Each `Get*` is a plain button (`button39`/`button40`/`button41`, `runWhenModelUpdates: false`) whose
success handler runs its `Store*` with the changeset
`{createdBy: current_user.fullName, imageIds: JSON.stringify(Get*.data), createdAt: moment(), type: 'minor'|'poi'|'reported'}`,
then re-runs `GetHelpers`.

**This is why the slice cannot be called done.** After Retool is switched off the 37 open rows drain and
nothing creates a 38th. The `retool_db` migration does not fix it — the data moves, the producer does
not. Per the skill's attribution rule, `createdBy` takes `locals.user.username`.

## B. Queue stats — 21 queries

The counts exist on the dashboard. What does not exist is **the comparison they were embedded in**, and
that was the point of the board:

- `listView1` was bound to `ReportTransformer`, a `Function` joining `Reports` (per-type pending counts)
  to `RecentReports` (last resolved report per entity type, a 12-way UNION) to emit
  `{type, count, color, modname, time}` — *"images: 312, last touched by `<mod>` 14 minutes ago"* —
  coloured against a per-type `thresholds` table (`csam: [10,6,4,2,0]`, `minors: [1000,700,400,200,0]`).
  That threshold table is a **hardcoded operating standard that appears in no query**.
- `RecentRating` / `RecentTagger` / `RecentReportImage` are the same idea for the rating and tag queues.
- `HourlyImages` / `HourlyModels` / `RRatingStats` / `ResearchRating` are the **Graphs tab**, not this
  surface.

`RRatingStats` **did** render (`table1`); `TaggerRatio` never did — its on-screen partner was
`ResearchRating`. The tracker had that pairing backwards.

## C. Report triage — 6 queries

- `UrgentReports` — **PRESENT**, predicate-for-predicate (`reports.service.ts`).
- `ActionReport` — **PRESENT** via `setReportStatus`.
- `Reports` / `OLDReports` — **PARTIAL**. Counts covered; the colour/threshold and "who last, how long
  ago" are not (group B). Retool excluded only `Automated`; our badges counted every reason, which is
  effectively the whole badge — on the dev clone (2026-08-12) 238,531 of 238,621 pending model reports
  were Clavata's, and no queue but images was under 99%. Restored 2026-08-12 as `DEFAULT_REPORT_REASONS`,
  shared by the badges, `/reports/[slug]`, User Reports and Chat Audit.
- `RecentReports` / `RecentReportImage` — **ABSENT** (group B).
- `ActionAllPostReports` — **ABSENT**. Selects pending post-reports where *every* image in the post is
  already `nsfwLevel = 32`, i.e. reports the content has already resolved. `/reports/[slug]` actions one
  at a time; the **batch selector** is what is missing, not the verb.

## D. Rating / tag review — 12 queries

- `ReviewGrouped` — **PRESENT**. Its seven buckets (`poi`, `reported`, `csam`, `minor`, `tag`,
  `newUser`, `appeal`) are split across `getImageReviewCounts` + `appeals` + `reported`, and all three
  UNION arms match.
- `ErrorRatingQueue` — **PRESENT**, identical window and predicates.
- `TagQueue` — **was DIVERGENT, fixed.** The count dropped Retool's `JOIN "Image" … nsfwLevel < 32`
  while the queue page kept it, so blocked images inflated a badge that could never reach zero.
- `RatingQueue` — **was DIVERGENT, fixed.** Dropped Retool's second admission branch
  `OR (irr.total <= -5 AND irr."createdAt" < NOW() - INTERVAL '10 hours')` — the *disagreement* case.
- `GetSplitQueue` / `SplitCurrent` / `SplitCatchup` — **ABSENT, and not rating review.** `button69`
  "Split", tooltip **"Only do this if it's 4 or more hours behind"**, forks the front-page sweep into a
  current and a catch-up stream by writing `FrontPageTimers` and `FrontPageTimers_catchup`. The tooltip
  is an operating rule that exists in no query.
- `UnpublishingReasons` — **ABSENT**, and it is **Models**, not articles.
- `LookUpTags` — correctly omitted (five hardcoded ids, no binding).

## E. Task acknowledgement protocol — 35 queries, NOT cron

Every `*Insert` / `*Check` / `pg` / `pg13` / `r` / `x` / `xxx` / `*_catchup` is `runWhenModelUpdates:
false`, fired from a button (`button32 → ArticleCheck`, `button55 → ModelInsert`, `button13 → pg`, …).
Each changeset is `{task: '<name>', lastUpdate: moment(), lastUpdateBy: current_user.firstName}` into
`Mods_TaskTimers`.

It is a **coordination protocol**: *"I have swept this queue up to now."* The paired `*Timer` query reads
it back and the `Function`s (`PGTime`, `FPATimer`, `newUserValue`, `CatchupTime`) turn it into the "N
behind" indicator on the board. Same mechanism the Front Page Audit slice already recorded as unported
(`FrontPageTimers`).

Routing this to the Workflows/cron slice would build a scheduler for something no scheduler ever ran,
and still leave the indicators unbuilt.

Two members are not protocol at all and are misfiled here:

- `BlockedImagesTask` — images `ingestion = 'Blocked'` whose `blockedFor` is **not** one of
  `moderated`/`Moderated`/`CSAM`/`AiNotVerified` since the last sweep: blocked for an *unusual* reason,
  needing a look.
- `CivitModelsData` — `Model WHERE userId = -1 AND status = 'Published'` updated since the last check
  (official-account publishes), opened as a modal (`button57 → modalFrame1 → table5`).

## Correctly omitted — nothing binds them

`HolidayPostsBulbs` (bound to a `textInput1` that does not exist), `LookUpTags`, `RatingTaggers`,
`TaggerRatio`, `MuteStats`. Verified against every widget's `dataBindings`, `options` and `label`.

Also broken **in Retool**, so not gaps: `button78` renders a nonexistent `Inquisitor1Queue`; `button59`
renders `TagQueue.data.id.length` where `TagQueue` selects only a COUNT; `table11` binds a nonexistent
`query1`; `button45` has `hidden: "1"`.

## Other absent capabilities

- `AutoBlockedUsers` — `ModActivity WHERE activity = 'autoMuteScam'` joined to the muted user
  (`table10` on the main board): the audit trail of automatic scam mutes. `autoMuteScam` appears
  nowhere in `apps/moderator`.
- `ModelReview`, `TrainingCount`, `UnpublishingReasons` — three model-side surfaces. **There is no
  models route in this app at all.**
- `FindSHA` / `LogSHA256` — a takedown-hash ledger into `ModerationSHA`. The interactive half was
  ad-hoc (`FindMatchingHash` hardcodes one hash), but the ledger write has no counterpart.

## Build order

Ticked items shipped 2026-08-10.

1. [x] **The three help-request producers.** `GetMinors`/`GetPoI`/`GetReported` → `Store*`, as one
   `file` action on `/retool/image-help`. Batch capped at 500 with the cap disclosed; an empty result
   is refused rather than filed.
2. [x] **The board**, on the DASHBOARD rather than a new route — a second page showing the same counts
   is how two surfaces come to disagree. Threshold colouring (`queue-thresholds.ts`), queue sweeps from
   `Mods_TaskTimers` **with the acknowledge write**, `AutoBlockedUsers`, and `RecentReports` as a
   "Recently worked" card.
3. [x] **`ActionAllPostReports`** as a batch selector on `/reports/post`, plus `BlockedImagesTask` and
   `CivitModelsData` as since-last-sweep counts.
4. [x] **Graphs tab** and the **split control**, as `/retool/queue-stats`. Its own route because Retool
   put them behind a "Load Graphs" button — they are unindexed aggregates. Inline SVG, no charting
   dependency. Recovering the split also recovered the `FrontPageTimers` column list that the Front
   Page Audit slice recorded as unknown.
5. [x] **`FindSHA`/`LogSHA256`** — built as `/retool/takedown-hashes`: a SHA256 lookup ("has this file
   been taken down before?") plus a record action that diffs against the ledger first. The export could
   not supply the ledger's columns — `LogSHA256` is a GUI BULK_INSERT with an EMPTY changeset, the same
   gap as the Front Page Audit rating logs — so they came from `retool-db.mjs --describe ModerationSHA`:
   `SHA256 text`, `ModelVersionId integer`. **Retool's finder selected the MODEL id while the ledger
   column is `ModelVersionId`**; the port follows the column, since a hash belongs to a file and a file
   hangs off a version. Worth checking the existing 30k rows before anything depends on them.
6. [ ] **`Who is who?`** — BLOCKED on a Retool screenshot. Its panes are not enumerated in the export
   and three of the app's six tables are still unaccounted for. Do not estimate it from the query list.
7. [ ] **Model-side surfaces** (`ModelReview`, `TrainingCount`, `UnpublishingReasons`) — BLOCKED on
   there being no models route in the app at all. That is a new section, not a port.

**A new route needs granting on `/admin`** before anyone but a `moderator:admin` can reach it —
`/retool/queue-stats` is the one added here.
