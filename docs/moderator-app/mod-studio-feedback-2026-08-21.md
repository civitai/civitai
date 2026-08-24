# Mod Studio feedback — round 2026-08-21

The moderation team reviews the app in a feedback channel and reports as they go. This file is the single
place to see what this round asked for and whether it is done.

**Scope:** the "highest priority before the weekend" list raised on 2026-08-21, PLUS everything still
open from earlier rounds, carried into the second half of this file.

**This is no longer the live list.** Everything still open when the 2026-08-24 round opened moved to
[`mod-studio-feedback-2026-08-24.md`](mod-studio-feedback-2026-08-24.md), so there is one live list
rather than boxes to tick in two files. They keep the date they were first raised. What stays here is
the record of what this round reported and what shipped — moved items appear below as plain bullets
with their reasoning intact, and no checkbox. Earlier rounds:
[`mod-studio-feedback-2026-08-19.md`](mod-studio-feedback-2026-08-19.md),
[`mod-studio-feedback-2026-08-17.md`](mod-studio-feedback-2026-08-17.md).

Reporter identities, message links, quotes and the account ids used as examples are deliberately absent:
this repo is public (CLAUDE.md → Security). The private triage keeps attribution.

> **Update this file in the same commit as the fix**, with a one-line outcome and the sha. An unticked box
> with no note reads as "nobody looked", which is the failure mode this file exists to prevent.

---

## This round

- [x] **Bulk Image Manager capped at 1,000 images.** Accounts hold tens of thousands and the page could
      only reach the first `limit`. It pages now: `offset` rides the URL beside `source`/`q`/`limit`, the
      header reads "Images 1,001–2,000 of 41,207", and Previous/Next walk the whole source at the chosen
      page size. The size picker stays 200/500/1,000 — that is what one grid renders comfortably, and
      paging is what gets past it rather than a bigger page.

      Offset paging, not a keyset cursor, for two reasons: the window has to be addressable backwards as
      well as forwards, and the post source orders by the author's own `index` rather than by id.
      `MAX_OFFSET` bounds the rows Postgres will walk and discard for one request.

- [x] **"Remove all images" sat where a mis-click lands.** It was a large red panel *above* the grid,
      one mis-aimed click from the per-selection buttons a moderator uses all day. It is below the grid
      now, behind an outline trigger rather than a destructive one, and still typed-to-confirm. Reaching
      it costs a scroll past the work.

- [x] **New Post Reports section.** `/retool/post-reports`, the User Reports screen for posts: the same
      queue, filters, paging, history panel and account-history block, with the drill-down showing the
      reported **post's** images plus the owner's strikes, notes, mod activity and prior account reports.
      Removing, restoring, flagging, notifying and striking all work from the page.

      Two differences that fall out of the entity rather than being choices: a post report names content,
      so the owner is a second lookup (the report row carries a post id and nothing else); and a report
      outlives its post, so both the queue row and the empty panel say "post deleted" rather than
      rendering blank. The queue also marks rows whose post is already entirely blocked — those are
      resolved by the content, which is what `actionResolvedPosts` sweeps in bulk.

      **The page is unreachable until it is granted on `/admin`** — a new page has no `AppPageAccess`
      row, so only `moderator:admin` can see it. That is a handover step, not a bug.

- [x] **Action / Unaction, and no more claiming.** Both report queues say "Unaction" where they said
      "Dismiss", and the Claim button is gone. `Processing` is no longer a status either queue can set;
      it remains a status they FILTER on, because reports carrying it predate the removal.

- [x] **Post Lookup on the main site links to Bulk Image Manager** — already shipped in the 08-19 round
      (`NEXT_PUBLIC_MODERATOR_APP_URL` + `moderatorBulkImageManagerPath('post', postId)` on the post
      context menu). Verified, not rebuilt. Re-reported because it is a recent change; no code needed.

- [x] **"Delete" is "Remove" on the image queues, and the report queue speaks in report statuses.**
      Every image queue's removal button and bulk button now say Remove, and the optimistic verdict on a
      handled card reads "Removed". On the **reported** queue specifically, Accept is "Unaction" and the
      verdict "Unactioned" — that queue rules on a report, and the button now says what it does to it.

- [x] **A username on Image Reports opens User Lookup.** Both the image owner and the reporter, on the
      reported queue only. The other image queues rule on one image, where the profile is the useful
      page; a report is the start of an investigation.

- [x] **No way back on the account image grid.** The suspect grid paged forward only — Next, and no
      Back or First — so overshooting an account meant reloading the drill-down. It is numbered now
      (`imgPage` in the URL, page count off the `matched` total the heading already computed), and the
      cursor grids that remain gained First/Back from a trail of visited cursors carried in the URL
      (`$lib/paging.ts`). An empty page past the first renders a "Back to the first page" button rather
      than a dead end.

- [x] **Turning the page threw the selection away.** Any URL change cleared the grid's selection, so a
      batch assembled across two pages was impossible. Selection now clears only when the *batch*
      changes — a new subject or a new filter — not when the page turns, keyed on the non-paging part
      of the query string. The action bar carries the consequence: "Select all N **on screen**", and
      "N selected but not on screen" when the selection reaches past the current page.

- [x] **The "banned" flag was buried behind long usernames.** It sat in the same wrapping run of badges
      as the status, reason and username, so on a long name it wrapped to a second line — and banned is
      the flag a moderator scans a whole queue for. Account state (banned / muted / deleted) is now
      pinned to its own top-right column on the row.

- [x] **Account history was capped at 8, full of KONO ratings, and its ids were not links.** All three:
      the preview is 8 with an expand over the whole set, the load is 100 rather than 20, ratings and
      tagging (Knights of New Order crowd votes, `setNsfwLevel`, `ratingReview`, tag activities) are
      filtered out of the default view behind a toggle rather than dropped, and every entity id links to
      the thing it names — "was this already removed, and when" is answered by opening it, which is what
      Retool did.

- [x] **"Reports received" only covered reports against the account.** Reports against the account's
      *content* — the thirty-odd-join query — are now a second block in the same panel, client-fetched
      (`/api/user-reports/[userId]?only=received&human=1&limit=20`), filtered to human-filed reasons
      because `Automated` is ~99.9% of that table. The endpoint grew `only` so a caller pays for one of
      its three lists instead of all three, and omits the lists it did not run rather than sending empty
      arrays — a caller must not be able to read "no reports" out of a query nobody ran. Its grant list
      widened from `/retool/user-lookup` alone to also accept the two report queues, which render the
      same panel.

- [x] **Legacy strikes migrated into the main database.** ✅ **Run against production 2026-08-21:
      12,902 rows imported across 10,690 accounts** — exactly the `UserStrikes` row count, so nothing was
      skipped, and no marker appears twice. Verified independently of the script's own `verify()`: zero
      rows are non-Expired, zero carry points, zero have `expiresAt <> createdAt`, and zero are
      `Active AND expiresAt > NOW()` — so nothing an escalation can count. The write side was already
      correct — this app has written only `UserStrike` since `d0820283c0`. The ~12.9k Retool-era rows
      were what remained, and the script that moved them is:
      `apps/moderator/moderator-db/migrate-legacy-strikes.ts` (dry run by default), with the reasoning in
      [`legacy-strike-migration.md`](legacy-strike-migration.md).

      It started as five hand-written `.sql` files — CSV export, a staging schema inside the main
      production database, raw SQL over untypechecked identifiers. That shape existed only because the
      moderator database had no schema and no generated types. It has both now, so the migration is one
      script over two Kysely connections, checked by `pnpm run typecheck:scripts`.

      ⚠️ **The panel has not caught up.** `AccountHistory` still prints "Plus N from the Retool era …
      not part of the counts above", and `getLiveStrikes` has no status filter — so on all 10,690
      accounts those rows now appear in the strike list AND are counted again by that line, which is
      now false. Nothing is truncated (the largest account has 10 strikes against a 50-row cap) and no
      enforcement is affected, but the footnote and User Lookup's `N legacy` badge both need retiring.

      🔴 **Imported rows land Expired and zero-point so escalation cannot count them**, and the
      verification pass after `--apply` fails the run if any is countable. There is no ordering
      requirement against the deploy and no second deploy. Reasoning:
      [`legacy-strike-migration.md`](legacy-strike-migration.md#the-one-thing-that-matters).

- [x] **Generator Restrictions can see previous successful generations again.** The main site's page had
      a "View Generations" drawer; the ported one had nothing, so the question that decides the ruling
      meant leaving the ruling screen. There is a collapsible panel on the restriction detail now,
      showing prompt, workflow, ecosystem and outputs, paged.

      Read through the orchestrator's `/v1/manager/workflows?UserId=` with the service token this app
      already holds — **not** by reproducing the main app's cross-user token mint, which is a main-app
      concern (api keys, sysRedis) and does not belong in a second codebase.

      The endpoint’s grant list names the one page that mounts the panel today. Dropping the same panel
      into User Lookup is a deliberate second entry in `PAGES`, not a free reuse — the read is wider than
      any page’s own content, so the list stays consumers-that-exist.

---

## Not shipped — the one to watch

The **legacy strike migration is written but unapplied**. Everything else in this round is live behind a
deploy; that one needs a human to run the script — once dry, once with `--apply` — per environment, at
whatever point suits.

Verified by `typecheck`, the new `typecheck:scripts`, and the app's own suite (129 tests). Four of this
round's items carry tests: the Post Reports queue reuses `getReports`, the workflow reader has its own
file, the legacy-strike marker protocol is tested on both sides, and `getReports`' raw SQL is now
guarded without a database. Everything else in this round was verified by typecheck and by reading the code.

## Also raised 2026-08-21

Reported after the items above shipped.

- [x] **The new entity-menu lookup links only worked via "open in new tab".** Every one of them —
      image, post, model, model version, article, user — sits in a menu that opens from inside a
      `NextLink` card. Mantine portals the dropdown out of the card, but React still propagates the
      click through the *React* tree, so next/link's handler took it, called `preventDefault()` and
      routed to the card instead. It looked like the links were fine because next/link ignores
      modified clicks, so ctrl-click and right-click → new tab reached the moderator app normally.

      `stopPropagation` on the item is the fix, and there is now one place holding it:
      `ModeratorLookupMenuItem` takes a path from `moderator-paths` and owns the anchor, the target,
      the icon and the stop. The image menu also had a `preventDefault()` on the *dropdown* — a second
      way to cancel any `component="a"` item inside it — reduced to the `stopPropagation` that was
      doing the actual work of keeping clicks off the card.

- [x] **User Lookup's Training runs panel "isn't saving all of them".** It was showing every run it
      had. Each row was labelled with the **version** name, and the training flow names a first version
      `V1` — so a run on a model called "Vash the Stampede" rendered as a bare `V1`, with the model
      name nowhere on the panel. The reporter's own run was on screen the whole time and unrecognisable.
      Rows now lead with the model name and carry the version name beside it.

      Worth writing down because the first two hours of this went the wrong way. The reported account
      held exactly two trained versions and the panel showed two, so the query looked correct and the
      missing runs looked deleted — deleting a training does hard-delete the `ModelVersion` (the list
      calls `modelVersion.delete` whenever the model has more than one version), which is a real
      mechanism and left no trace to contradict. That was inference dressed as a finding. A second
      report naming one version id is what broke it: that row satisfied every predicate, and the query
      returned it — verified against the replica AND by compiling the query onto a Kysely dummy driver
      to rule out the `LEFT JOIN` condition leaking into the `WHERE`. Both facts were true and neither
      was the answer, because nobody had asked what the row looks like once it renders.

      Swept for the same shape: **Image Generation** had the mirror of it — every row labelled with the
      MODEL name and no version, so a creator with several versions of one model got a column of
      identical labels distinguished only by their counts. It carries the version name now too.

      🔴 **Where the missing runs go: `remove-old-drafts` hard-deletes them.** That job runs nightly
      (`43 2 * * *`) and issues `DELETE FROM "Model"` for every model in status `Draft` or `Deleted`
      that has not been updated in 30 days and has under 10 downloads. A training that is submitted and
      never published leaves its model in `Draft` — so 30 days later the model, its version, its
      Training Data file and the whole run record are gone, by FK cascade, with nothing soft-deleted to
      find afterwards.

      This was observed live rather than inferred. The reported account held a second trained version —
      a `Pending` run from 2026-07-22 on a Draft model — which was present in queries run early on
      2026-08-21 evening and **absent from the same queries after that night's 02:43 UTC pass**. Both
      the `ModelVersion` and the `Model` row are simply not there now.

      Scale, measured the following morning: **139 models carrying 145 trained versions** were sitting
      in the reaper's own predicate, i.e. roughly one night's worth. That is the ordinary rate at which
      training history is destroyed, and it fully accounts for "I did ten trainings and see two" without
      the user having deleted anything: what survives is what they published or touched inside 30 days.

      It also explains why the orchestrator is no help — its own window is about 30 days, so both copies
      of the record expire on roughly the same schedule.

      **This corrects two earlier readings in this item.** The user-initiated hard delete
      (`modelVersion.delete`) and the client's cleanup of failed runs #2+ are both real paths, but
      neither is what happened here; the nightly reaper is, and it needs no user action at all.

      ✅ **The count survives in ClickHouse, and the panel now shows it.** `buzzTransactions` keeps one
      `training` row per submission — verified on the reported account, whose surviving run's
      `submittedAt` matches its charge to the second. That account has **24 paid training runs between
      2026-04-01 and 2026-06-18, 12,950 Buzz, no refunds**, against **one** version still in Postgres. So
      the reporter's "about ten" was an understatement, and their expectation was correct: the runs
      happened, and the platform deleted the evidence.

      So the ledger is a run **list**, not a count. The panel renders it as one: the surviving runs as
      before, then **"Runs with no surviving record"** — a row per charge, with its date and cost, for
      every submission no surviving run accounts for. On the reported account that is 1 detailed row and
      23 listed ones, which is the shape the reporter expected to see.

      Matching is by timestamp: a run accounts for a charge within a minute of any of its `Submitted`
      history entries or its `submittedAt` (a retrain reuses the version, so one run legitimately
      answers for several charges). Verified against the reported account — 24 charges, 1 matched,
      23 listed — and the pure part is covered by six tests.

      ⚠️ **The names are gone, and that is what the mod team most wanted.** The ask after seeing this is
      the title each training was given — "tee hee" and the like — because a run's *name* is the
      behavioural signal when reading a training-data investigation. It is not recoverable: the name
      lives only on the `Model`/`ModelVersion` rows the cascade removed. Checked and ruled out —
      `model_names` in ClickHouse is a Postgres-backed dictionary, so it drops with the row;
      `modelEvents`/`modelVersionEvents` carry ids and no names, and cover only 8 of this account's 24
      runs anyway; the completion email carries the name but is not a queryable store; the orchestrator
      has ~30 days.

      What each deleted run does keep is its **workflow id** — `buzzTransactions.details` holds
      `{"workflowId": "<userId>-<timestamp>"}` on 1,382,396 of 1,681,688 training charges, i.e. every one
      since 2024-10. That is now on the row beside the date and cost. It is the run's only surviving
      identity, and it is enough to confirm the account uses the trainer and how often, which the
      reporters said is itself worth having.

      **If names matter, that is the durable-record decision below, not a query.** Capturing the model
      and version name at submit time into a table the cascade cannot reach is the only thing that makes
      this answerable — for future runs only.

      🔴 One trap, pinned by those tests: ClickHouse returns `YYYY-MM-DD HH:MM:SS` with **no zone**, and
      it is UTC. `Date.parse` reads that shape as **local** time, so dropping the `Z` shifts every
      charge by the box's offset, matches nothing, and reports a correct account as having lost every
      run. Note the limit of the test: it fails on any non-UTC machine (verified — the revert reddens
      two of the six) and **cannot** fail on CI's UTC runner.

      It fails soft — the endpoint that calls it is a single `Promise.all` over twelve queries, and a
      ClickHouse blip must not take the other eleven panels down.

      (The moderator database does **not** hold this. Its only training-shaped table is
      `Temp_FailedLoRATrain`, a six-column one-off snapshot, and it has no Buzz ledger at all.)

      **The decision this leaves.** The bytes are not the issue — the training dataset is already purged
      separately at 30 days, and a metadata row costs nothing. So the options are to exempt
      `uploadType = 'Trained'` models from the reaper, to have it soft-delete them instead of issuing a
      raw `DELETE`, or to record a training run in a table the cascade cannot reach. All three are
      product calls with a storage argument attached, so none was made here.

### Contests

Nothing below is built yet; each box carries what the code actually does today, because three of the
four have a root cause that is not what the symptom suggests.

- **`/moderator/contests` is a bare list and should be part of the suite.** It renders every
      `CollectionMode.Contest` collection newest-first with name, created-at, type and the submission
      window — and nothing that says whether a row is an official contest, a daily challenge or a
      user-made one. It predates user challenges entirely.

      The distinction is already in the data and needs no new field: a contest collection may have a
      `Challenge` row pointing at it (`Challenge.collectionId`), and `Challenge.source` is `System`
      (the auto-generated dailies), `Mod` or `User`. A contest collection with no `Challenge` row is a
      plain contest. So "kind" is a left join plus a case, and it is the column the page is missing.

      Port target: `/contests` in this app via
      [`moderator-page-migration`](../../.claude/skills/moderator-page-migration/SKILL.md) — a
      `NAVIGATION` entry, a Kysely load, filters on kind / status / window, and links out to both the
      collection and the challenge. **Unreachable until granted on `/admin`**, like every new page here.

- **Contest bans list caps at 20, and a new ban appears to do nothing.** Both symptoms are one bug.
      `/moderator/contests/bans` calls `user.getAll({ contestBanned: true })`, whose input extends
      `getAllQuerySchema` → `paginationSchema`, where `limit` is `.default(20)`. The page never passes a
      limit, so the query lands `LIMIT 20` and there is no total in the response to say what was cut.

      The "it didn't take" half follows from the same query: `getUsers` emits **no `ORDER BY`** unless a
      search term is present, so which twenty rows come back is whatever Postgres returns. A ban that
      succeeded lands somewhere arbitrary in a set larger than the window. The write is fine — the list
      cannot show it.

      Fix belongs in the port, not in a bigger `limit`: its own load, ordered by `bannedAt` desc, paged
      with a count, searchable, and with unban and edit-reason on the row.

      ⚠️ Latent while we are here: in `getUsers` the `ORDER BY` is spliced **into the middle of the
      `WHERE` clause**, before the `contestBanned` predicate. It is unreachable only because the
      contest-banned path never passes `query`; passing both would emit invalid SQL.

- **User Lookup shows no contest-ban flag.** `getUserLookup` already selects
      `u.meta #>> '{banDetails,reasonCode}'` and `{banDetails,detailsInternal}` off the same row, so
      adding `{contestBanDetails,bannedAt}` costs nothing extra. Render it as a badge in the pinned
      account-state column beside banned / muted — the column that exists precisely so a flag is not
      buried behind a long username.

- **Split contest bans: daily challenges vs everything else.** Most contest-banned accounts were
      farming Buzz on the daily challenge and may still compete fairly elsewhere, and today the ban is
      one flag with one meaning.

      `contestBanDetails` is JSON on `User.meta`, so this is a new optional `scope` on that object with
      absent meaning "everything" — existing bans keep today's behaviour, no backfill, and none of the
      additive-enum deploy ordering applies.

      There are exactly two enforcement points, and both need to read it:
      - `upsertCollectionEntry` (`collection.service.ts`) refuses any account carrying
        `contestBanDetails`. It would resolve the collection's kind first — the same `Challenge` join the
        list page needs — and refuse only within scope.
      - `loadBaseGates` (`contest-score.queries.ts`) folds every contest-banned id into
        `baseDisqualifiedIds`. That is the community-contest scorer, so it takes only the ids whose scope
        reaches contests.

      Open question for the reporters before this is built: is the axis two-valued (challenges /
      contests), or does an explicit "everything" state need to stay selectable in the UI rather than
      only being the legacy default?

---

# Carried forward from earlier rounds

Everything still open when this round opened, moved here so there is one live list. Each keeps the date
it was first raised.

## P0 — operational, nothing to build

- **Finish the environment and database steps** *(08-17)* — handover blockers
      [#1–#4](retool-migration-handover.md). `CIVITAI_MOD_API_KEY` is retired and must NOT be
      provisioned, and `RETOOL_DATABASE_URL` is retired too — the Retool and moderator databases were
      consolidated, so `MODERATOR_DATABASE_URL` is the only name. What remains is the `FRESHDESK_TOKEN`
      rename, and verifying two of the three SQL migrations.
- **Tick the action grants on `/admin`, then check as a non-admin** *(08-19)*. There are no default
      roles, so until this pass happens the actions are held by nobody. The pass itself is
      [`action-grants-review.md`](action-grants-review.md). **Add Post Reports to it** — the new page is
      admin-only until granted.

## P1 — reported defects

- **Comment highlighting does not work on article comments** *(08-19)*. Read end to end and not
      reproduced from the code; needs a live repro with the URL in hand.
- **User Lookup unavailable for the staff role** *(08-17)*. Not a defect — part of the `/admin` pass.
- **`reportedUser` renders greyed out on reports** *(08-18)*. Suspected downstream of the above.
- **Comment rows are "funky" to read** *(08-18)*. Needs the reporter to say what is wrong.
- [x] **Why are banned users' comics queued for review at all?** *(08-18)*. **Measured 2026-08-21 —
      it is moot.** The queue is empty in production for everyone, not just banned authors:

      | | |
      | --- | --- |
      | `ComicPanel` rows | 22,750 |
      | `ComicProject` rows | 2,990 |
      | panels matching the queue predicate | **0** |
      | of those, banned or deleted author | 0 |

      Nothing is `needsReview`, nothing is `tosViolation`, and the 33 unscanned panels do not match
      because the predicate needs `needsReview IS NOT NULL` as well. So there is no volume to weigh a
      `where` clause against, and adding one now would be changing a queue nobody is in. Re-measure
      before deciding if comics review starts filling up.

## P2 — decisions

- **A paged list has no "load more"** *(08-19)*. Two panels have since been paged — the one fixed in
      the 08-19 round, and the account image grid (numbered paging, 08-21) — so the reporter needs to
      confirm which they meant rather than anything needing building.
- **`ReToolActions` vs `ModActivity`** *(08-17)* — two mod-action logs that nothing reconciles.
- **`aiNsfwLevel` / `aiModel` exist in production but not in `schema.full.prisma`** *(08-17)*.
- [x] **`RatingChanges`** *(08-17)* — **ported 2026-08-21, both writes.** Setting a rating and voting a
      moderation tag onto an image each record to `RatingChanges`, the before/after trail
      `recordModActivity` does not keep.

      It was recorded as blocked on "what `originalRating` holds on the tag-vote path". It was not: the
      answer is in the app export we already had, and reading it corrected two things the audit notes
      got wrong — `LogNsfwLevel` upserts by `imageId` rather than inserting, and `originalRating` is the
      sweep's selected rating rather than the image's own previous level. Both facts are now pinned by
      mutation-checked tests. **Unexercised against a database.**
- **How queue sweeps get tracked** *(08-17)* — a new table, or an extension of `ModActivity`.

The "two strike systems" P2 from 08-19 is **closed by this round** — see the strike item above. What is
left of it is applying the migration, which is an operational step, not a decision.

## P3 — improvements, after parity

- **Show "recently worked" and "time sweeps" beside the queues they describe** *(08-17)*.
- **Whether the `/images/*` triage queues join the sweep tracking** *(08-17)*.
- **Link a report to the site it originated from** *(08-17)* — forward-only is possible via
      `Report.details`; the retroactive half is not.
- **The "Admin Attention" report reason is too vague to action** *(08-17)*.
- **The mod changelog modal disappears once a model is unpublished** *(08-17)*.
- **Unpublished articles have no republish path** *(08-17)*.
- **A model marked as depicting a minor can still receive a new version containing X-rated images**
      *(08-17)*.
