# Mod Studio feedback — round 2026-08-21

The moderation team reviews the app in a feedback channel and reports as they go. This file is the single
place to see what this round asked for and whether it is done.

**Scope:** the "highest priority before the weekend" list raised on 2026-08-21, PLUS everything still
open from earlier rounds, carried into the second half of this file.

**This is the live list.** A round gets its own dated file so it is clear when something was first asked
for, and unfinished items move to the newest file rather than being ticked across several — so the
newest file is the only one with open boxes. Earlier rounds:
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

- [ ] **Legacy strikes migrated into the main database.** ⚠️ **The script is written; the migration has not
      been run anywhere.** The decision is settled and the write side was already correct — this
      app has written only `UserStrike` since `d0820283c0`. What was outstanding is the ~12.9k Retool-era
      rows, and there is now one typed script for them:
      `apps/moderator/moderator-db/migrate-legacy-strikes.ts` (dry run by default), with the reasoning in
      [`legacy-strike-migration.md`](legacy-strike-migration.md).

      It started as five hand-written `.sql` files — CSV export, a staging schema inside the main
      production database, raw SQL over untypechecked identifiers. That shape existed only because the
      moderator database had no schema and no generated types. It has both now, so the migration is one
      script over two Kysely connections, checked by `pnpm run typecheck:scripts`.

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

Verified by `typecheck`, the new `typecheck:scripts`, and the app's own suite (81 tests) — which, as this app's
`CLAUDE.md` says, means the report queue still passes and nothing else was covered by a test. The new
Post Reports queue reuses `getReports`, which those tests do cover.

---

# Carried forward from earlier rounds

Everything still open when this round opened, moved here so there is one live list. Each keeps the date
it was first raised.

## P0 — operational, nothing to build

- [ ] **Finish the environment and database steps** *(08-17)* — handover blockers
      [#1–#4](retool-migration-handover.md). `CIVITAI_MOD_API_KEY` is retired and must NOT be
      provisioned, and `RETOOL_DATABASE_URL` is retired too — the Retool and moderator databases were
      consolidated, so `MODERATOR_DATABASE_URL` is the only name. What remains is the `FRESHDESK_TOKEN`
      rename, and verifying two of the three SQL migrations.
- [ ] **Tick the action grants on `/admin`, then check as a non-admin** *(08-19)*. There are no default
      roles, so until this pass happens the actions are held by nobody. The pass itself is
      [`action-grants-review.md`](action-grants-review.md). **Add Post Reports to it** — the new page is
      admin-only until granted.

## P1 — reported defects

- [ ] **Comment highlighting does not work on article comments** *(08-19)*. Read end to end and not
      reproduced from the code; needs a live repro with the URL in hand.
- [ ] **User Lookup unavailable for the staff role** *(08-17)*. Not a defect — part of the `/admin` pass.
- [ ] **`reportedUser` renders greyed out on reports** *(08-18)*. Suspected downstream of the above.
- [ ] **Comment rows are "funky" to read** *(08-18)*. Needs the reporter to say what is wrong.
- [ ] **Why are banned users' comics queued for review at all?** *(08-18)*. Predicate known, volume not
      measured, decision not made.

## P2 — decisions

- [ ] **A paged list has no "load more"** *(08-19)*. Two panels have since been paged — the one fixed in
      the 08-19 round, and the account image grid (numbered paging, 08-21) — so the reporter needs to
      confirm which they meant rather than anything needing building.
- [ ] **`ReToolActions` vs `ModActivity`** *(08-17)* — two mod-action logs that nothing reconciles.
- [ ] **`aiNsfwLevel` / `aiModel` exist in production but not in `schema.full.prisma`** *(08-17)*.
- [ ] **`RatingChanges`** *(08-17)* — the one Front Page Audit write still unported.
- [ ] **How queue sweeps get tracked** *(08-17)* — a new table, or an extension of `ModActivity`.

The "two strike systems" P2 from 08-19 is **closed by this round** — see the strike item above. What is
left of it is applying the migration, which is an operational step, not a decision.

## P3 — improvements, after parity

- [ ] **Show "recently worked" and "time sweeps" beside the queues they describe** *(08-17)*.
- [ ] **Whether the `/images/*` triage queues join the sweep tracking** *(08-17)*.
- [ ] **Link a report to the site it originated from** *(08-17)* — forward-only is possible via
      `Report.details`; the retroactive half is not.
- [ ] **The "Admin Attention" report reason is too vague to action** *(08-17)*.
- [ ] **The mod changelog modal disappears once a model is unpublished** *(08-17)*.
- [ ] **Unpublished articles have no republish path** *(08-17)*.
- [ ] **A model marked as depicting a minor can still receive a new version containing X-rated images**
      *(08-17)*.
