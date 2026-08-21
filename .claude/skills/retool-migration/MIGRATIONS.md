# Retool migration tracker

Every Retool app handed to us for migration, and how far it has got. **Update this file as part of the
work, not afterwards** — add the app when the export arrives, tick slices as they ship.

Status: `not started` · `in progress` · `partial` (shipped, deliberately incomplete) · `done` (nothing
left worth porting) · `dropped` (agreed not to port)

## Apps

| App | Subtask | Queries | Components | Route | Status |
| --- | --- | --- | --- | --- | --- |
| User Lookup v2 | `868kn6x1b` | 170 | 433 | `/retool/user-lookup` | **partial** — everything unblocked is built (unverified in a browser); what is left is blocked, not pending: see below |
| Moderation Status | `868kn5zg1` | 77 | 197 | `/retool/image-help` (group A) | **in progress** — [audit rewritten](../../../docs/moderator-app/retool-exports/moderation-status-audit.md) 2026-08-10 and now trustworthy; the three help-request producers are built. A fidelity review (2026-08-10) walked all 77: **8 present, 4 partial/divergent, 4 correctly omitted, 61 absent**. 6 of 77 are built. The old audit's two load-bearing claims are both false: group E is **not** cron (there is not one `Timer` in the export — all 35 are button-triggered), and the export **does** carry layout and option sets, so "three of four tabs unported" was invisible. Two rank-1 count bugs found and fixed. **Group A is now complete** — `GetMinors`/`GetPoI`/`GetReported` → `Store*` are built as a `file` action, so the queue no longer dies at cutover. Remaining work is in the audit's build order. |
| Bulk Image Manager | `868kn76au` | 40 | 60 | `/retool/bulk-image-manager` | **ported, not verified** — 40/40 classified ([audit](../../../docs/moderator-app/retool-exports/bulk-image-manager-audit.md)). Reviewed by all three agents; findings fixed. **Not run against a live page, and needs granting on `/admin`.** Deliberate divergences: batches cap at 200 with a truncation warning (Retool's `UserQuery` was uncapped, `UserQuery5000` capped at 5000), and POI/minor flags can be CLEARED as well as set — Retool hardcoded `value=true`, so **the clear path has no Retool behaviour to compare against and is the first thing to exercise**. A fourth, **export-vs-build fidelity** review then found four real gaps the three code reviews structurally could not: `UserQuery5000` (the already-removed view) absorbed into a row about `resolveUserId`; the pasted-id-list entry point classified by endpoint rather than entry; prompt/POI/minor fetched but never rendered; `nukeUser` mis-mapped to the broader `remove-all-content`. All fixed or recorded as open gaps in the audit. Re-extracted 2026-08-10; raw export committed under retool-exports/raw/. |
| User Reports | `868kn78hc` | 34 | 57 | `/retool/user-reports` | **ported, not verified** — 34/34 classified ([audit](../../../docs/moderator-app/retool-exports/user-reports-audit.md)): 4 ported, 14 already shipped elsewhere, 16 Retool glue. Reviewed by all three agents; findings fixed. **Not run against a live page, and needs granting on `/admin`.** Re-extracted 2026-08-10 with the current extractor (layout + widget options); the raw export is committed at docs/moderator-app/retool-exports/raw/. |
| Chat Audit | `868kn7m9r` | 20 | 50 | `/retool/chat-audit` | **built** — all 20 queries ported and reviewed, unverified in a browser, Retool still live |
| Front Page Audit | `868kn82bf` | 16 | 19 | `/retool/front-page-audit` | **ported, not verified** — 16/16 classified ([audit](../../../docs/moderator-app/retool-exports/front-page-audit-audit.md)): 7 port, 4 already shipped, 2 superseded, 3 plumbing. A proactive sweep (pick a rating + ordering + media, re-rate what is wrong), distinct from `/images/ratings` which is reactive. Re-rating reuses `updateImageNsfwLevel`. **Which of its three Retool writes exist is recorded in one place — [Front Page Audit: port state](../../../docs/moderator-app/retool-exports/parity-findings.md#front-page-audit-port-state-canonical). Do not restate it here; this row said something false twice on 2026-08-20 by doing exactly that.** Two schema findings: Retool selects `i."aiNsfwLevel"`, which exists in production but not in `schema.full.prisma`, and `ImageRank` is an unmodelled view — both read through raw `sql`. Retool's `ByReactions` filtered on the deprecated `i.nsfw` enum while its newest views used the `nsfwLevel` bitmask; the port uses the bitmask for both so the orderings agree. |
| Image Lookup | `868kn7q2v` | 10 | 21 | `/retool/image-lookup` | **built** — all 10 queries ported, unverified in a browser, Retool still live |
| Article Lookup | `868kn7t8d` | 3 | 9 | `/retool/article-lookup` | **ported, not verified** — 3/3 queries classified ([audit](../../../docs/moderator-app/retool-exports/article-lookup-audit.md)): 2 ported, 1 plumbing (`query1` is an `information_schema` scratch query with a literal `'your_table'` placeholder). Reviewed; findings fixed. **Not run against a live page, and needs granting on `/admin`.** Re-extracted 2026-08-10; the raw export is committed under retool-exports/raw/. |
| Bulk Ban | `868kn87qj` | 15 | 12 | `/retool/bulk-ban` | **ported, not verified** — 15/15 classified ([audit](../../../docs/moderator-app/retool-exports/bulk-ban-audit.md)): 9 port, 2 already shipped, 3 ad-hoc scratch, 1 not ported (`deleteComments`, whose input query is absent from the export and which writes Prod directly). The ninth app, missed because the tracker listed 9 of the parent ticket's 13 subtasks. Ban loop keeps Retool's 5-consecutive-failure abort; the ban-evasion half (registration IPs, email-domain histogram, accounts-per-IP) is ported as shapes with inputs rather than Retool's hardcoded case data. Gated on `isSenior`. **Fidelity review 2026-08-10** found three defects and two absent capabilities, all now fixed: the ban confirmation promised a content purge that only happened for `SexualMinor` (`removeMedia` was never passed — checkbox added); `parseIdList` truncated silently at 1001 so a 2,000-id list reported 1,001 banned (`parseIdListStrict` refuses instead); the reason picker preselected `Other`; **`query15` domain expansion** and **`GetUsers` tip-farm finder** were both absent and are now built. Its audit was wrong in three rows — `query15` is not covered by the domain histogram (that one is scoped to ids already pasted, so it counts a ring but cannot grow one), `GetUsers` is a workflow not plumbing, and `query13` was filed unported when it is covered. The `textArea2` copy-out is now a details block. **15/15 accounted for; nothing left unported.** One deliberate divergence: the 5-failure abort counts **ids** where Retool counted **attempts**, so a single permanently-failing id no longer halts the run. |
| Workflows (2) | `868kn80u9` | 2 SQL | — | alerting, not a page | **done — deliberately not ported.** Decision and evidence: [`retool-workflows-decision.md`](../../../docs/moderator-app/retool-workflows-decision.md). Both are alerting wrappers, and the Retool implementation is inert four ways over: `crontab` is `null`, `isEnabled` is `false`, the only trigger is a webhook, and the **Discord block is orphaned** — it has no inbound edge of either kind, so only the PagerDuty leg was ever reachable. They also name `daily-challenge-pick-winners`, a job that no longer exists here (it is `challenge-completion`), and carry a stale *"If the leaderboard isn't populated"* comment showing they were cloned from a leaderboard alert. The **condition** was worth keeping: `createJob` reports *thrown* failures to Axiom + `jobErrorsCounter`, but the challenge pipeline fails by silent no-op (three unlogged early returns in `createUpcomingChallenge`, `result.failed` swallowed in `challenge-auto-queue`, both no-op when `CHALLENGE_PLATFORM_ENABLED` is off) — so nothing alerted on it. Reimplemented as `src/server/jobs/challenge-health-check.ts` (`0 */6 * * *`), both predicates in one query, alerting to Axiom + the existing `DISCORD_WEBHOOK_MOD_ALERTS` webhook. **No PagerDuty** — the repo has no integration and adding one is an infra decision. Raw exports committed under retool-exports/raw/, **sanitized before their only commit** — re-verified 2026-08-11: the Discord webhook, the PagerDuty routing key, the `run-jobs` token and the job-scheduler host are all placeholders in every version in history, so **nothing here needs rotating**. Re-sanitize the same four if the exports are ever refreshed. |

**The exports are attached to the ClickUp subtasks of 868kkxqpn** — one subtask per app, listed above.
That is the authoritative source; local folders go stale. To pull them:

```bash
cd /c/work/civitai/.claude/skills/clickup
node query.mjs get 868kkxqpn --subtasks --json      # subtask ids
node query.mjs get <subtaskId> --json               # attachment urls
```

Raw exports live **outside the repo** (`~/Downloads/Retool/`) because they contain live credentials —
see [`docs/moderator-app/retool-exports/README.md`](../../../docs/moderator-app/retool-exports/README.md).
Committed inventories (every query + SQL) sit in that folder and are the thing to read.

**Check the subtasks before assuming this list is complete.** Five of these eight apps were only found
by looking at subtask attachments; the first three were handed over piecemeal and the rest were sitting
in ClickUp unnoticed.

Counts are from `extract.mjs` and measure the Retool app, not the work — most apps carry dead queries,
duplicates and Retool plumbing (`Function`, `State`, `Timer`).

---

## What's left

Consolidated 2026-08-20 from the per-app sections below, which stay authoritative for detail. Most of the
*porting* is done; **most of the remaining work is verification and cutover**, and that is the work that
decides whether any of it counts — Rule 6: nothing is `done` until the Retool app is switched off.

### A. Unported functionality — 2 items, both in Moderation Status

Every other app is either fully ported or blocked. These two are genuinely unbuilt:

- [ ] **`Who is who?` tab** (Moderation Status) — one of four top-level tabs; three of the four are built.
      Contents are not enumerated by the layout section, so **it cannot be scoped from the committed
      inventory** — needs the raw export or a screenshot first. Blocked on information, not on effort.
- [ ] **Model-side surfaces** — `ModelReview`, `TrainingCount`, `UnpublishingReasons` (Moderation Status).
      There is no models route in the spoke at all, so this is a new page, not an addition to one.
      `/moderator/models` is also an open item on the *main-app* migration checklist — **check whether
      these belong on that page before building a Retool-namespace one.**

### B. Verification and cutover — 9 apps, and the largest block of remaining work

Five apps are marked **"ported, not verified"** and two **"built"**: written, reviewed, typechecked, and
**never run against a live page**. User Lookup v2 (`partial`) and Moderation Status (`in progress`) need
the same walk-through over the parts that are built. None has been granted on `/admin`, so nobody but
`moderator:admin` can open them, and Retool is still live for all of them.

For each app: open the page → grant it on `/admin` → walk the workflows → then switch Retool off.

- [ ] **Bulk Image Manager** — highest risk of the nine. Two deliberate divergences to exercise first:
      batches cap at 200 with a truncation warning (Retool was uncapped), and **the POI/minor CLEAR path
      has no Retool behaviour to compare against** — Retool hardcoded `value=true`, so clearing is new
      code that has never run.
- [ ] **Bulk Ban** — destructive and irreversible at scale. Confirm the ban loop's 5-failure abort, the
      `parseIdListStrict` refusal on >1000 ids, and that the removal checkbox actually purges.
- [ ] **User Reports** — verify the strike + notify + image-removal actions end to end.
- [ ] **User Lookup v2** — the moderation team's primary console; verify before it becomes the default.
      `GetFreshdesk` **needs `FRESHDESK_API_KEY`** and is the one piece never exercised against the real
      service (unset, it reports "no contact found" rather than erroring — so a broken key looks normal).
      Timed mutes were **built to the schema, not to observed usage: the table is empty.**
- [ ] **Front Page Audit** — two writes were built 2026-08-20 and have never run; a third is unported.
      Which is which: [Front Page Audit: port state](../../../docs/moderator-app/retool-exports/parity-findings.md#front-page-audit-port-state-canonical). Exercise the two built ones, then decide
      whether the unported audit trail blocks switching Retool off.
- [ ] **Chat Audit** — reads private DMs. Confirm the grant list is deliberate before granting it.
- [ ] **Image Lookup** — **not read-only**: it sets and clears POI/minor. Exercise the **Clear** direction
      first, as with Bulk Image Manager — Retool only ever set these ON.
- [ ] **Article Lookup** — read-only, lowest risk.
- [ ] **Moderation Status** (`/retool/image-help`, `/retool/queue-stats`) — group A and the dashboard are
      complete; verify alongside the two open items in §A.

### C. Export-vs-build parity — open findings, and the one app never swept

**Coverage is better than it looks from the per-app sections.** A fourth-pass parity sweep ran
2026-08-08 → 08-10 and its results are in
[`parity-findings.md`](../../../docs/moderator-app/retool-exports/parity-findings.md), which has a section
for **Bulk Image Manager, User Lookup v2, User Reports, Chat Audit, Image Lookup** and **Article Lookup**,
plus layout-parity and ticket-screenshot passes. 53 findings fixed, **6 still open**. Read that file
before concluding a slice was never checked.

Two caveats on it, both stated in the file itself: nothing there is verified in a browser, and **the
boxes have gone stale once already** — fixes landed in two commits without being ticked, so it read as 19
open findings when 16 were done. Check the code before acting on an unticked box.

**A second pass ran 2026-08-20** — `retool-fidelity-review` on all six apps that had no agent run on
record (User Lookup v2, Chat Audit, Image Lookup, Article Lookup, User Reports, Front Page Audit),
closing the Front Page Audit gap. Results are appended to the same file: **7 fixed on the spot, 1 needing a
decision, 13 gaps opened — of which 11 were closed the same day and 1 did not survive verification.**
What is still open from that pass is `RatingChanges`, `numberOfImages` on `FrontPageTimers`, and
scheduled mute start (`parity-findings.md` → "Still open"). Every ported app has now had at least one
export-vs-build pass. Two findings worth knowing here because they change other rows in this file:

- **Image Lookup is not read-only** — it sets and clears POI/minor. Its §B verification entry moved out
  of "lowest risk".
- **User Lookup's chat-report count was scoped to the chat's creator** — wrong in both directions, and
  fixed. Copying Retool (any message author) would have been worse: it always includes the reporter, so
  every harassment report would also mark the victim. The answer is the participant who is **not** a
  reporter, in a two-party chat — `chatReportSubject` in `report-entities.ts`, used by both the count and
  the rows. 99.0% of human-filed reports resolve to exactly one account; group chats match nobody. The
  old version also counted `Automated` reports the rows list hides, over-counting 11,056 accounts.

- [x] ~~Front Page Audit has no section~~ — covered by the 2026-08-20 pass.
- [x] ~~**`UserRestriction` is read nowhere** (User Lookup)~~ — **fixed in `e40e93106e`**, before this
  section was written. `user-lookup.service.ts` reads status/type/id, and `resolveRestriction` runs the
  Overturn path (restriction resolved, subscription reinstated, user told) as a form action on
  `AccountActionsPanel`.
- [ ] **The 5 open findings from the first pass**, most severe first:
  - **Two `tabbedContainer14` panes WRITE** and were deliberately not built pending a decision.
  - Image-only account nuke absent; counts report rows *found*, not rows *changed*; remove+strike not
    ported (Bulk Image Manager).
  - `table53`/`table54` — the **grouped** receipt/payment views, not the flat ones (User Lookup Buzz).
  - The `Check Buzz` button, After-date picker and three filters from the ticket screenshots.
  - LoRA training metadata clickthrough to the orchestrator dashboard.

The `retool-fidelity-review` agent postdates most of that sweep (both landed 2026-08-10), and on Bulk
Image Manager it found four gaps the three code reviews had structurally missed. A slice with a section
in `parity-findings.md` has been swept **once, by hand**; re-running the agent on it is cheap and has
found things before.

### D. Blocked — needs a decision or infrastructure, not porting

Listed so they are not rediscovered as oversights. None is "next up".

- [x] ~~**`/api/mod/retool/user` capabilities** — editing bio/socials, `ToggleMod`, `UpdateUserDeets`.~~
      **BUILT, corrected 2026-08-20.** The premise was wrong: `callModEndpoint` uses `auth: 'session'`,
      forwarding the acting moderator's own session, so no user API key was ever required.
      `updateUserIdentity` and `toggleModerator` delegate through it (gated at the endpoint on
      `retoolUpdateIdentity` / `retoolToggleModerator`), while `addSocial`, `removeSocial` and
      `clearProfileText` are direct Kysely writes. All five are wired as form actions behind grants.
- [ ] **Destructive content actions from User Lookup** — bulk delete / ToS of comments, purge all
      content, cosmetics removal. **Not blocked on ownership — corrected 2026-08-20.** Both side effects
      that were cited as "the spoke does not own them" are already solved here:
      - **Cache busting**: `cache.ts` writes the same Redis keys the main app reads
        (`bustCachedObject`, `bustCacheTag`, and the per-domain helpers).
      - **Search index**: `syncSearchIndex` already calls `/api/internal/search-index-update`.
      The bulk prerequisite is **done** (2026-08-20): `syncSearchIndexBulk` posts a whole id array in
      one round trip, deduped and chunked at the endpoint's 1,000-id cap, and the endpoint accepts
      `entityIds` beside `entityId`. The actions themselves are built too (see the User Lookup section);
      this row is closed.
- [x] ~~**Timed-mute expiry** — needs a cron job.~~ **NOT BLOCKED — the cron already existed, corrected
      2026-08-20.** The main app drains `User.muteExpiresAt` hourly via `processTimedUnmutesJob`
      (`0 * * * *`), re-evaluating strike escalation before lifting so an account still carrying points
      stays muted. The spoke now writes only that column: the moderator DB's `TimedMutes` duplicated the
      capability with **no consumer**, so a mute recorded there alone never lifted. Nothing reads or
      writes that table any more and it can be dropped at cutover (it held 0 rows).
      Still unbuilt: scheduled mute **start** — there is no `muteStartsAt`, so it is a schema change plus
      a second job, not a missing cron. Worth confirming anyone wants it.
- [x] ~~**Add / subtract Buzz, rewards eligibility**~~ — **BUILT, corrected 2026-08-20.** `sendBuzz`
      (behind the `user.buzz.send` grant) and `setRewardsEligibility` are in `user-actions.service.ts`,
      wired as form actions and rendered by `BuzzTransactionPanel` and `AccountActionsPanel`. The
      "maybe a separate app" ticket aside was recorded here as a blocker and outlived the work that
      closed it — the second time this row has misled, and the reason Rule 7 exists.
- [x] ~~**Notification history** (`GetNotifications` / `ViewNotifications`) — a seventh datasource.~~
      **BUILT, corrected 2026-08-20.** The premise was wrong: `queryNotifications` is a method on the
      same `@civitai/notifications` client that sends, not a separate connection. `getUserNotifications`
      calls it and `NotificationsPanel` renders it, with a 25/50/100/200 depth picker.
- [ ] **Attribution backfill and ID consolidation** — nine free-text attribution columns across eight
      tables, plus a `ReToolActions` with no subject column at all. (`TimedMutes.userId` was a third
      case; that table is dead as of 2026-08-20 and gets dropped rather than cast.) Tracked separately,
      with the inventory and ordering:
      [`moderator-db-backfill-tasks.md`](../../../docs/moderator-app/moderator-db-backfill-tasks.md).
- [~] **Chat message-text search performance** — **mitigated 2026-08-20; the index is deferred, not
      blocked.** `pg_trgm` is **already installed in production**, so there was never an extension to
      request. Measured: 1.4s for a common term and **2.6s for a miss** — proving a negative reads the
      whole table, which is exactly what probing an unknown spam string does. The search is now bounded
      to 90 days (1.25s worst case) and says so on the page, matching what `SPAMDetect` already does.
      The real fix is a **partial** GIN trigram index on the same window: 90 days is 258k rows and 26MB
      of text, so ~50-90MB against the 208MB already on `ChatMessage`. Deferred on judgement — nothing
      is blocked on this search and a FULL index would cover 457MB of text for a query on no hot path.
      Build it if a moderator complains.

⚠️ **Four entries below were stale; each now carries its own correction inline.** User Lookup lists "issuing a strike" and
"notifying a user" as blocked on the notification system. Both are now **built** — User Reports issues
main-app strikes through `issueStrike` (`createStrike` sends the typed notification and its email in the
same call) and has a `notify` action. What remains on User Lookup is wiring its own panel to them.

### E. Deliberately not ported — closed, listed to stop re-litigation

`UserRank`, `ReportsSubmitted`, `PotentialSpammer` v1, `SubTierStatus`, `CreatorClub`/`CreatorClubBuzz`,
`GeneratorCount`, `ReactionsAll`, `DistinctUsersWithSocialLinks`, `TopChats`, `Reactions` (raw rows),
`deservedMute`/`spamWhitelist` flags, the chat transcript on User Lookup (Chat Audit owns it), `BANAPI`/
`SetNote`/`LogBan` on Chat Audit (User Lookup owns enforcement), the App enable/disable plumbing on User
Reports, and both **Workflows** (inert four ways over; reimplemented as `challenge-health-check`).

---

## Moderation Status

Resources: `Replicated_Read_Prod`, `retool_db`, REST.

A queue/stat board rather than a lookup tool.

> ⚠️ **Fidelity review, 2026-08-10: 61 of 77 queries are ABSENT and the audit's grouping is unsound.**
> Do not treat the buckets below as settled. The audit must be rewritten before more is built.

**The two claims that hid everything else:**

1. **"Group E is 35 backfill jobs and timers, not UI."** There is **not one `Timer` plugin in the
   export**. All 35 are fired by button clicks (`button32 → ArticleCheck`, `button55 → ModelInsert`,
   `button13 → pg`, …) writing `{task, lastUpdate, lastUpdateBy}` into `Mods_TaskTimers`. They are a
   **manual acknowledgement protocol** — "I have swept this queue up to here" — read back by the paired
   `*Timer` query and rendered as a per-queue "N behind" indicator. Filing them as cron would build a
   scheduler for something no scheduler ever ran, and still leave the indicators unbuilt. Same
   mechanism the Front Page Audit slice already recorded as unported.
2. **"This export predates the extractor upgrades, so it has no layout or option sets."** It has both.
   Acting on that sentence is why three of the four top-level tabs were never noticed as unported:
   `tabbedContainer1` is `Moderation Status` / `Image Help` / `Graphs` / `Who is who?`, and only
   **Image Help** exists here. Three of the six tables in the app are still unaccounted for.

**Fixed on the spot** (both were screens stating something false):

- `TagQueue` — the sidebar badge counted without Retool's `JOIN "Image" … AND i."nsfwLevel" < 32`
  while the queue page filtered on it, so blocked images inflated a badge that could never reach zero.
- `RatingQueue` — the queue and its count kept only `irr.total >= 3`, dropping Retool's second
  admission branch `OR (irr.total <= -5 AND irr."createdAt" < NOW() - INTERVAL '10 hours')`. That is
  the *disagreement* case: strongly-negative rating requests aged 10h. Nothing else picked them up.

**Confirmed genuinely covered** (predicate-by-predicate): `UrgentReports`, `ActionReport`,
`ErrorRatingQueue`, `ArticleReview`, `ReviewGrouped` (its seven buckets are split across
`getImageReviewCounts` + `appeals` + `reported`, and all three arms match).

**Confirmed dead in Retool too**, so not gaps: `HolidayPostsBulbs`, `LookUpTags`, `RatingTaggers`,
`TaggerRatio`, `MuteStats` — no widget binds them. Note this corrects the row above: `RRatingStats`
**did** render (as `table1` on the Graphs tab); `TaggerRatio` never did. Its on-screen partner was
`ResearchRating`.

**The real open work, in rough value order:**

- [x] **`/retool/image-help` is a consumer with no producer.** BUILT 2026-08-10 — three buttons file the current backlog, capped at 500 with the cap disclosed. Original text: `GetMinors`/`GetPoI`/`GetReported` are
      buttons whose success handlers write `ModerationImageHelp` (`{createdBy, imageIds, createdAt,
      type}`). Nothing in `apps/moderator` writes that table — it only reads and marks handled. Once
      Retool is switched off the queue drains to empty permanently. **This blocks calling group A done.**
- [x] **Queue-lag indicators + the `Mods_TaskTimers` protocol** — built on the dashboard, with the acknowledge ("Mark swept") write so the mark actually advances.
- [x] **Who is working a queue** — `RecentReports`/`RecentRating`/`RecentTagger` gave each dashboard row
      "last touched by `<mod>`, N minutes ago", coloured against a per-type threshold table that exists in
      no query. The board here is count-only.
- [x] **The `Graphs` tab** — built as `/retool/queue-stats`, its own route because Retool put it behind a "Load Graphs" button. Inline SVG rather than a charting dependency. `RRatingStats` is bounded to 30 days (Retool was unbounded over ModActivity) and the window is stated on the page.
- [ ] **The `Who is who?` tab** — contents not enumerated by the layout; needs the raw export or a
      screenshot before it can be scoped.
- [ ] **Model-side surfaces with no page at all** — `ModelReview`, `TrainingCount`,
      `UnpublishingReasons`. There is no models route in the app.
- [x] **`ActionAllPostReports`** — sweeps pending post-reports where every image is already blocked.
      `/reports/[slug]` actions one at a time; the batch *selector* is what is missing, not the verb.
- [x] **`GetSplitQueue`/`SplitCurrent`/`SplitCatchup`** — built on `/retool/queue-stats`; both tables written in one transaction, and button69`s tooltip rule is on the page. This also recovers the FrontPageTimers column list the Front Page Audit slice recorded as unknown. Original note: forks the front-page sweep into current and
      catch-up streams when it falls behind. Tooltip: "Only do this if it's 4 or more hours behind".
- [x] **`BlockedImagesTask`** (images blocked for an *unusual* `blockedFor`) and **`CivitModelsData`**
      (`userId = -1` official publishes) — review counts misfiled as jobs.
- [x] **`AutoBlockedUsers`** — `ModActivity WHERE activity = 'autoMuteScam'`; the automatic-scam-mute
      audit trail. Nothing in the app mentions `autoMuteScam`.
- [x] **`FindSHA`/`LogSHA256`** — built as `/retool/takedown-hashes`. Columns came from
      `retool-db.mjs --describe`, since the export's BULK_INSERT changeset is empty. **Retool's finder
      selected the MODEL id while the ledger column is `ModelVersionId`** — the port follows the column;
      check the existing 30k rows before depending on them.
- [x] **Report reason set** — decided 2026-08-10: badges count every reason and the queue page lands unfiltered to match. Original note: badges counted only `DEFAULT_REPORT_REASONS`, so pending
      **NSFW, CSAM and StickerPlacement** reports show nowhere. Retool excluded only `Automated`.

## User Lookup v2

Resources: `Replicated_Read_Prod`, `Prod`, `Clickhouse`, `retool_db`, `BuzzTemp`, `Notifications DB`,
`MongoDB`, REST.

The big one, and the moderation team's primary console. The checklist below tracks coverage against the
ClickUp design doc (868kkxqpn §1.2) — see
[`docs/moderator-app/retool-migration-tasks.md`](../../../docs/moderator-app/retool-migration-tasks.md).

**The checklist is a coverage list, not a delivery schedule.** An app is ONE slice: build the whole page,
then review it. Earlier guidance here said the opposite and it was wrong — delivering a panel at a time
meant the page was reviewed six times, defects were found in already-shipped panels months after they
landed, and every pass paid the cost of re-reading the same service. Ship a page when it is whole.

- [x] **Shell + resolver + counts + stats** — `/retool/user-lookup`. Covers `UserIDByUsername`,
      `UserIDByEmail`, `UserContent`, `AllCountsUnion`, `UserStats`, and folds in the per-type counts
      that were a separate slice. One resolver handles id / username / email.
      Not ported: `UserRank` (leaderboard positions) — deferred, low value for triage.
      **Retool's `UserStats` is stale**: it selects `ratingAllTime`, which no longer exists on
      `UserStat`. Replaced with thumbs up/down + generations.
- [x] **Content counts** — folded into the slice above.
- [x] **Reports** — `ReportCount`, `ReportedImageCount`, `ReportedModelCount`,
      `ReportedCommentCount`, extended to posts/articles/image-comments.
      Reports filed by the user (with the actioned share, computed over *resolved* reports so a
      pending backlog does not read as unreliability) and their content that drew reports.
      Counts distinct content, not report rows — Retool counted rows, so ten reports on one image
      read as ten. Not ported: `ReportsSubmitted`, the per-report detail list.
- [x] **Prior moderator activity** (ticket §1.2e, not a Retool query — Retool only ever *wrote*
      `LogModActivity`). Served from `/api/user-mod-activity/[userId]`. ModActivity keys content
      actions by CONTENT id, so this is two shapes: rows pointing at the user (`user`,
      `impersonate`) and rows reached by joining their images/models/articles (~67ms each).
      Needs the append-only migration; history only accrues from it forward.
- [x] **Moderation memory** — `SelectUserNotes`, `InsertUpdateUserNotes`, `UserStrikes`. Notes (read,
      add, edit-own) against the live moderator database, served from `/api/user-memory/[userId]`
      with writes as form actions on the page.
      **`moderation-memory.service.ts` is the reference example for a moderator-database slice**; the
      endpoint itself is not — it also fetches the MAIN app's `UserStrike` rows (`getLiveStrikes`),
      because "Issue strike" writes there and the moderator DB's `UserStrikes` is Retool-era history
      nothing writes. That call is caught separately so a main-DB failure cannot take the notes down
      with it, and `liveStrikes: null` means "could not check", not "clean".
      Writes put `locals.user.username` in `lastUpdateBy`, so the column now holds two naming schemes
      (Retool display names historically, Civitai usernames going forward). Edit-own is enforced by
      the `lastUpdateBy` predicate in the UPDATE, not in the handler.
      Not ported here: issuing a strike — **no longer blocked.** User Reports built it against the main
      app's strike system (`issueStrike`, which sends the typed notification itself), so this panel needs
      wiring to it rather than a decision. Also not ported: the `deservedMute`/`spamWhitelist` flags.
- [x] **Security signals** — `RegistrationIP`, `SimilarIps`, `PotentialSpammerV2`. Served from
      `/api/user-signals/[userId]`, not the page load: ~250ms for the IP roll-up plus ~750ms for the
      shared-IP scan over a 31M-row table.
      **Use `targetUserId`, never `userId`** — on Login/Registration rows `userId` is empty ~95% of
      the time (30M of 31.5M logins), so filtering on it silently returns nothing. The main app's
      `csam.service.ts` has this wrong and is worth a look.
      `PotentialSpammer` (v1) not ported — V2 supersedes it.

> **Reviewed 2026-08-06** by the three `moderator-review` agents, after the slice had already shipped and
> passed an ad-hoc review. It found that **muting did not work**: session revocation landed but nothing
> busted `session:data2`, which caches `muted` for 4h and which the hub's login path reads cache-first —
> so a muted user logged back in and kept posting. Also: the ban reason code was free text against an
> endpoint that parses a strict enum (any typed reason = 500 and no ban); no destructive submit had an
> in-flight guard, and because the ban endpoint toggles, a double-click unbanned; timed mutes logged as
> plain `mute`/`unmute`; and unmute/revoke could leave the account and the moderator database disagreeing.
> Run the review on a slice even when it has already shipped.

- [x] **Account actions** — `BANAPI`, `UNBANAPI`, `ToggleMute`, force logout.
      `user-actions.service.ts`, gated on `/users` (investigating an account and acting on it are
      different permissions), with confirmation on ban.
      **Mute and force-logout are spoke-owned**: Kysely update plus `invalidateUserSessions` through
      `@civitai/auth`'s session registry on the shared sysRedis — mirroring `apps/auth`'s wiring. Without
      the revocation a mute does nothing until the session refreshes.
      **Ban delegates** to `/api/mod/ban-user` (it also purges media/models, notifies and busts caches).
      Two of its behaviours are worked around rather than fixed: it *toggles*, so the service re-reads
      `bannedAt` and refuses a request that already matches; and it answers 200 before doing the work,
      so the UI re-reads instead of trusting the response. It attributes internally to `userId: -1`, so
      every action here also writes ModActivity with the real moderator.
      `ToggleMod` and `UpdateUserDeets` are built — `toggleModerator` / `updateUserIdentity`, delegating
      through `callModEndpoint` (`auth: 'session'`, the acting moderator's own). No API key was needed.
- [x] **Mutes** — `ActivateSystemMute`, `RevokeTimedMutes`, `ViewMutes`. **Rebuilt onto the account,
      2026-08-20.** A timed mute is `User.muteExpiresAt` plus `meta.{muteReason, mutedBy}`, with `mutedAt`
      marking it as a moderator's rather than the strike engine's;
      the moderator DB's `TimedMutes` is read and written by nothing here, and its schema model says so.
      `getTimedMute` returns one nullable mute — a single column cannot hold
      two, which is why `hasOtherActiveTimedMute` no longer exists. Expiry is not missing:
      `processTimedUnmutesJob` (`0 * * * *`) drains `muteExpiresAt` hourly, and strike escalation will
      neither lift nor shorten a mute whose `mutedAt` is set — that column, not a `meta` flag, is what
      marks a mute as a person's decision. Not ported: scheduled **start** — there is no `muteStartsAt`,
      so that is a schema change plus a second job.
- [x] **Subscription + Buzz** — `UserSubscriptionStatus` (Postgres, in the page load) plus the Buzz
      balance from `GetAccountBuzz`, served via `/api/user-account/[userId]` since it is an external
      HTTP call. Buzz failures degrade to "Balance unavailable" rather than blanking the panel.
      Not ported: `SubTierStatus` (a site-wide roll-up, not per-user), `CreatorClub`/`CreatorClubBuzz`
      (Stripe-Connect payouts — a different domain from moderation).
- [x] **Reviews / comments** — `ReviewList`, `ComboComments` as read-only lists in
      `/api/user-account/[userId]`, with ToS/excluded/nsfw flags and links to the model.
      **Bulk delete and ToS actions are NOT ported** — destructive, and the delete path carries
      search-index and cache side effects the spoke does not own. Blocked behind the same decision as
      account actions.
- [x] **Cosmetics** — owned cosmetics with type and equipped state. `RemoveCosmetics` not ported for
      the same reason (destructive; the main app also refreshes entity caches and search indexes).
- [x] **Support context** — `GetFreshdesk`. Contact lookup by email in `freshdesk.service.ts`, shown in
      the account-actions panel with a link to the Freshdesk record.
      **Needs `FRESHDESK_API_KEY` to return anything** — unset, it shows "no Freshdesk contact found"
      rather than erroring, so a missing key never blocks a lookup. Documented in `.env.example`; this
      is the one piece that has not been exercised against the real service.

### What is left, and what blocks it

Everything unblocked on this page is now built. The remainder needs a decision or infrastructure, not
more porting — none of it is "next up":

- ~~**Editing bio and socials**, **`ToggleMod`**, **`UpdateUserDeets`**~~ — **BUILT.** They call
  `/api/mod/*` as the acting moderator (`auth: 'session'`); the "needs a user API key" premise was wrong.
- ~~**Bulk delete / ToS of comments**, **purge all content**, **image removal**, **cosmetics removal**~~
  — **BUILT.** `bulkCommentAction`, `purgeAllContent`, `removeImages`/`restoreImages`, `grantCosmetic`/
  `removeCosmetic`, all wired as form actions. The "side effects the spoke does not own" premise was
  wrong — see §D.
- ~~**Issuing a strike**, **notifying a user** — need the notification system.~~ **UNBLOCKED** — both are
  built on User Reports (`issueStrike`, and a `notify` action over `@civitai/notifications`). What is left
  on *this* page is wiring its own panel to them: porting work, not a blocker.
- ~~**Add / subtract Buzz**, **rewards eligibility**~~ — **BUILT.** `sendBuzz` behind `user.buzz.send`, and `setRewardsEligibility`.
- ~~**Notification history**~~ — **BUILT.** `queryNotifications` is a method on the `@civitai/notifications`
  client the app already had; `getUserNotifications` + `NotificationsPanel`, 25/50/100/200 depth picker.

### Asked for in the ticket

The slices above were scoped from the Retool export. `868kn6x1b`'s description is a **wishlist**, and it
asked for eight things the export-driven slices never covered. Four are now built (profile & reputation
slice); the four left are unbuilt rather than blocked.

- [x] **LoRA trainings** — `NewSubmittedTrainsBrett`, in `/api/user-account` (0.5ms). Retool selected
      `ModelFile.*` plus ~20 hyperparameters (batch size, LR schedule, network dim); those debug a failed
      train rather than moderate an account, so what is ported is what a moderator acts on — what was
      trained, base model, status, epoch progress, image count, Buzz cost, dataset-shared.
      Retool filtered `type = Training Data OR type IS NULL` in the WHERE, which drops a version whose
      only files are of another type; moved into the JOIN so the run stays visible.
- [x] **Buzz history** — `Receipts` + `Payments` merged into one timeline (they differ only in which
      side of the transaction the account is on), plus `ReceiptsUsers`/`PaymentsUsers` for counterparty
      names. Its own endpoint: `buzzTransactions` is **1.5B rows sorted by date ASC**, so even bounded to
      90 days a descending read measures ~2.5s. The window bound is mandatory, not tuning — Retool bounded
      it too. Account id 0 is Civitai itself (generation spend, purchases, rewards).
      Not ported: "add / subtract buzz", which the ticket itself flags as probably a separate app.
- [x] **Reactions** — `ReactionsGrouped` as "reactions given, by creator reacted to", in
      `/api/user-account`. The concentration is the signal; a normal account spreads reactions over
      hundreds of creators.
      **`UserStat.reactionCountAllTime` is NOT this number** — it counts reactions *received*
      (measured: 51,775 received against 312 given on the same account). The total comes from a
      `sum(count(*)) over ()` window instead, which totals every group before `LIMIT` trims them.
      `ImageReaction` is 744M rows but indexed on `userId`: ~47ms at 49K reactions, ~605ms for the
      heaviest account on the site (6M). Off the page load for that reason.
      `ReactionsAll` (every raw reaction row) not ported — unbounded, and the grouped view answers
      what the raw rows were being scanned for.
- [x] **Civitai score** — `SocialScore`, in the page load, rendered in `ReputationPanel`.
      **The `meta->scores` keys are sparse**: ~49% of users have no scores object at all, and most
      that do carry only `total` plus one component. A missing key is "not scored", not zero, so
      absent components are omitted rather than rendered as 0.
      `ReputationPanel` no longer hides behind `{#if result.stats}` — a user can have a score and no
      `UserStat` row.
- [x] **Bio, profile message and location** — `UserBio` over `UserProfile`, in the page load, shown in
      `IdentityPanel` only when non-empty. Retool also selected the cover image; not ported, the panel
      links to the profile.
      Not ported: **editing**. That is `/api/mod/retool/user`, which needs a user API key the spoke
      should not hold — the same blocker as `UpdateUserDeets`.
- [x] **Socials** — `AccountSocialQuery` plus the cross-user matching, in `/api/user-signals` beside
      the shared-IP signal rather than in the profile. The most-shared single URL in the table is held
      by 55 accounts and they are spam networks, which is exactly the intended signal.
      Retool's `UsersWithSocials` SELECTs the **entire** `UserLink` table and matches in the browser.
      Matching in SQL as a self-join is worse — 21s for a link-heavy user, because it drives a
      sequential scan per link. Two statements instead (collect this user's URLs, then one scan
      matching all of them): ~36ms. `url` has no index; `lower()` keeps casing from hiding a match.
      `DistinctUsersWithSocialLinks` not ported — a site-wide count, not per-user.
      **`UserLink` has no uniqueness on (userId, url)** — one account holds the same link 19 times — so
      every read dedupes. Undeduped it produced a duplicate `{#each}` key, which Svelte throws on **in
      production**, from inside the `:then` branch where the `{:catch}` cannot catch it: the panel broke
      on precisely the spam-network accounts it exists to find.
      The cap counts accounts, not rows. Capping rows let one account holding 25 shared links fill the
      window and report "25+ accounts" for a single alt, hiding every other one.
      Matching normalises scheme, `www.` and trailing slash: one domain is held by 35 accounts with a
      trailing slash and 25 without, **disjoint sets** — exact matching reported 24 alts on a 60-account
      ring.
- [x] **Blocked prompts + generation abuse** — `GetBlockedPrompts` and `GenRateLimited`, in the security
      signals panel where they belong. `prohibitedRequests` is small (777K); `textToImageJobs` is 1.08B
      sorted by createdAt, so the 24h bound keeps it on the sort key.
      **`GeneratorCount` deliberately not ported** — an all-time COUNT would scan 1.08B rows, and
      `UserStat.generationCountAllTime` already carries the same number for free on the Reputation panel.
- [x] **"Has this user talked to a mod before?"** — `FindChats` + `FindChatsWithMods`, as a banner on the
      signals panel: the ticket asks for a warning on lookup, not a chat browser.
      **Retool hardcoded sixteen moderator user ids inline**; derived from `User.isModerator` instead. The
      hardcoded list was already stale (there are 24) and would silently under-report as the team changes
      — a failure a moderator could never notice. 60ms.
      Not ported: the transcript (`UserChats`, `WarrantChatLog`) — that is the **Chat Audit** app
      (`868kn7m9r`), and the ticket's "DMs sent" is the same data.
- [ ] **Notification history** — `GetNotifications` / `ViewNotifications` against the Notifications DB,
      which the spoke has no connection to. Not in the ticket text; noting it so the export's use of a
      seventh datasource is not rediscovered later.

## Image Lookup

Resources: `Replicated_Read_Prod`, `Clickhouse`. All 10 queries ported in one slice.

⚠️ **NOT read-only — corrected 2026-08-20.** This page writes: POI and minor flags via
`/api/mod/update-image-flag`, which Retool carried too (`Toggle Minor ON` / `Toggle Poi ON`). Retool could
only set them ON, so **the Clear direction is new code with no Retool behaviour to compare against** — the
same caveat recorded for Bulk Image Manager, and it is the first thing to exercise here. The write was
also gated on this page's own path, which `hooks.server.ts` has already checked, so it was no gate at all;
now `/users`, matching Bulk Image Manager and User Reports. The old "read-only" claim is why §B filed this
app as lowest-risk with no verification item.

- [x] **Image detail** — `GetImageData` (Retool's `SELECT *`), narrowed to the moderation-relevant
      columns, and the image itself rendered with `EdgeMedia` (`Image.url` IS the Cloudflare key).
- [x] **Resolver** — `GetIdFromUrl` folded into one input. Retool had an id box and a separate URL box.
      **The UUID is the SECOND path segment of a CDN URL, not the last** (the last is a filename) —
      taking the last segment made every pasted CDN link, the case the feature exists for, return "no
      image matches". Site URLs (`/images/<id>`) resolve too. Ids are bounded to int32, or an over-long
      paste errors the query instead of missing.
- [x] **Tags + shadow tags** — `Tags` (the `TagsOnImageDetails` view) and `ShadowTags`. Shadow tags are
      why an image can be flagged without visibly carrying the tag.
- [x] **Reports** — `query9`. **Note the divergence from `image-review.service.ts`**, which answers the
      same question for Appeals with an INNER join to `User`, silently dropping reports whose reporter
      was deleted. Two pages, same image, different lists.
- [x] **Moderator activity** — Retool ran `SELECT * FROM "ModActivity" WHERE "entityId" = <id>` with
      **no entityType**. Entity ids are per-type, so it showed actions taken on unrelated reports and
      models. Filtering `entityType = 'image'` is also what puts it on the
      `(entityType, entityId, createdAt)` index.
- [x] **Vote-ring detection** — `ReactionsIP` + `ReactionsIP2`, which Retool rendered as two tables for
      the moderator to join by eye. Grouped by IP, returning only addresses carrying more than one
      account. **This is the reason the page is worth having.**
      **`default.reactions` is 825M rows sorted by TIME, not entityId** — filtering on the image id
      alone scans the table (2.0s, 5.3s cold). A reaction cannot predate its image, so the image's
      `createdAt` is passed as a lower bound: 203ms.
      **That bound must be read with `to_char`, never as a JS Date.** `Image.createdAt` is `timestamp
      without time zone` with no pg parser registered, so node-pg reads it as local time and
      `toISOString()` adds the offset. On a UTC-6 host the bound landed six hours into the image's life
      and hid 60% of a live ring — 25 accounts and 37 reactions rendered as 13 and 16, and any ring
      firing in the hour after upload disappeared entirely under "nothing suggesting a ring".
      `Image_Create` only: `Image_Delete` is a reaction being *removed*.
- [x] **Lifecycle log** — `ImageTOs` (`default.images`), the only place a removal's `tosReason` and
      `violationType` are kept.
      **A ToS deletion removes the Postgres row and leaves this log**, so the page has a deleted-image
      path that renders the log alone. Gated on the log actually having events: an id is just digits,
      and a transposed one would otherwise be reported as a confirmed ToS removal. Reaction clustering
      is skipped there — no `createdAt` means no bound.

Not ported: `Reactions` listed every row (capped at 100 with the cap disclosed).

## Chat Audit

Resources: `Replicated_Read_Prod`, `retool_db`, REST. All 20 queries ported in one slice.

READS PRIVATE DIRECT MESSAGES. Grant-based access means the page is admin-only until someone grants it
on /admin — keep that deliberate.

- [x] **Search** — one box for Retool's three inputs (`SearchMessages`, `SearchUser`, chat id).
      **Every branch orders before it limits.** `SELECT DISTINCT chatId ... LIMIT 50` with no ORDER BY
      is satisfied by a sort/unique, so it returned the 50 LOWEST ids — the OLDEST chats — which the
      summary step then re-sorted by recency, so the list READ as newest-first. `discord.gg` matches
      4,620 chats.
      **All-digit terms above int4 are usernames, not chat ids.** `Chat.id` is `integer`, so a larger
      value ERRORS the query and 500s the page; 978 users with a 10+ digit numeric username have chat
      messages. `@` forces username mode, and an all-digit term that is also a real username surfaces
      a banner offering the other reading — 88 short numeric usernames sit inside the live chat-id
      range, and guessing wrong shows two strangers their private conversation.
      `%` and `_` are escaped: unescaped, `100%` matched 31,606 messages instead of 5,563.
- [x] **Chat list** — `FindChats`. Retool joined member names with `string_agg` and split on `,`,
      corrupting any username containing one; a real array avoids inventing a delimiter.
      **`array_agg(username)` must be cast `::text`** — username is citext, node-pg has no parser for
      citext[], and the driver returns the raw literal as a STRING that the panel's `.join()` throws on.
      `coalesce` keeps purged accounts visible: 8,589 users with a NULL username hold 34,147 membership
      rows, and dropping them made the list and the member panel disagree about who was in a chat.
- [x] **Transcript + members** — `FindChatById`, `FindChatMembers`. Newest 300, reversed for reading
      order, cap disclosed. System rows excluded: 274,106 are `Embed` type whose content is raw JSON,
      rendered verbatim attributed to "civitai".
- [x] **Chat reports** — `ChatReport`, served by the SHARED `reports.service.ts` rather than a third
      hand-written join. That also settles a policy split: this page and `/reports` previously
      disagreed about which chat reports are open, so one actioned on `/reports` stayed here forever.
- [x] **Platform stats** — `ChatsTotal`, `Chats24`, `MessagesTotal`, `Messages24`, `TopChatters`.
      Grouped by userId and resolved after, so a rename cannot split one person into two rows.
      ~~`TopChats` NOT ported~~ — **wrong, corrected 2026-08-20**: `TopChats` *and* `TopChats24` are both
      built (`chat-insights.service.ts`) and rendered as "Busiest chats". `TopChatters24` is built too and
      is missing from the list above. Both directions of this row were wrong.
- [x] **Spam detection** — `SPAMDetect`, the most useful thing on the page: the same text sent by one
      account into several chats. Retool ran it UNBOUNDED: 5.3s and a **429MB external merge sort
      spilling to disk**, because it groups 4.2M rows by full message text. 30-day window is 630ms with
      no spill. Message bodies are collapsed by default, matching the blocked-prompt decision on User
      Lookup.

Not ported: `BANAPI`, `SetNote`, `LogBan`. Every username links to User Lookup, which owns enforcement
with confirmation and an audit trail — duplicating a ban button here means two gates and two places to
get it wrong.

Bounded, not unbounded: message-text search covers the last **90 days** as of 2026-08-20 (1.25s worst
case, and the page says so), down from a full scan at 1.4s for a hit and 2.6s for a miss. The real fix is
a **partial** `pg_trgm` GIN index over the same window — `pg_trgm` is already installed in production, so
it is deferred on judgement, not blocked on infra. Rationale and sizing: §D.

## User Reports

Resources: `Replicated_Read_Prod`, `retool_db`, ClickHouse, REST. The smallest of the three, and the
most action-heavy — 17 of its 57 components are buttons.

A report-triage console centred on one user: pull their reports, review the offending images inline,
then action them and strike the user. Overlaps `/reports` and the dashboard's "Most reported", so check
both before building.

> The bullets below were written while scoping and left unticked after the slice shipped. Corrected
> 2026-08-20 against `routes/retool/user-reports/+page.server.ts` — **all four buildable items are built**,
> as four scoped form actions (`report`, `strike`, `notify`, `images`). The table row above was right and
> this section was stale; the app still needs *verifying*, which is §B, not porting.

- [x] **Reports against a user** — `GetReports`, `ReceivedReports`, `ReportHistory`, `GetImageCount`.
      Postgres, read-only. `ReceivedReports` is the per-entity-type union (model/image/post/…) with a
      link to the content; `ReportHistory` is who set each status and when. Built as the queue, history
      and suspect panels, loaded together. Overlaps the User Lookup reports panel and `/reports` by
      design — this one is centred on a single user.
- [x] **Image review inline** — `TOSImages`, `RemoveImages`, `RemoveImages2`, `RestoreImages`. The
      `images` action, via `bulk-image.service.ts`. **A failed removal must not strike anybody** — the
      strike runs only after the removal succeeds, matching the flag path's ordering.
- [x] **Strikes** — `UserStrikes`, `InsertStrike`, `LogStrike`. Writes the **main app's** strike system
      through `issueStrike`, not the moderator database's legacy `UserStrikes` table: that one is written
      by nothing, so a panel reading it showed 0 on an account carrying ten live strikes. The legacy rows
      are still read alongside, so history is not lost. Escalation, points, expiry and the void path come
      free with the main-app system.
- [x] **Notifications to the user** — `SendNotification2`, `PostNotification`, `SendCorrectNotif`. The
      `notify` action. **This unblocks the "needs the notification system" item on User Lookup** —
      `createStrike` sends the typed notification and its email inside the same call, so there is no
      separate half-failing step.
- [x] **Report actioning** — `ActionReport`. Shipped on the dashboard ("Most reported") and reused here,
      using the same `setReportStatus` path.
- [x] **App enable/disable** — `DisableApp`, `EnableApp`, `DisableAppRestore`, `EnableApp2`. Retool
      UI plumbing (locking the app while a batch runs), not functionality. **Not portable, not needed** —
      ticked as decided, not as built.

Note: 13 of the 34 queries are `JavascriptQuery` — Retool-side batching and selection glue
(`query30` loops in batches of 10, `UnselectAll`, `log`). These are not data sources and have no
equivalent here; a SvelteKit form action does the same job.

---

## Rules

1. **Add the app here when the export arrives**, before writing code — even if it stays `not started`.
2. **Scope from the subtask description as well as the export.** They are different sources and they
   disagree. The export says what Retool *does*; the description says what the mod team *asked for*,
   and it includes things the Retool app never had. Reading only the export produced a User Lookup that
   looked complete and was missing eight requested features.
3. **Tick a slice only when it is shipped and verified** (typecheck + build + a look at the real page).
   A slice that is written but unverified is still unticked.
4. **Record what you deliberately skipped** under the app, with the reason. "Not ported" and "not needed"
   look identical six months later.
5. **`retool_db` slices are blocked on a data migration**, not on UI work. Do not tick them because a
   page renders; the data still lives in Retool.
6. **Nothing is `done` until the Retool app is switched off** — otherwise moderators keep using the old
   one and the two diverge.
7. **State a per-query fact ONCE, and link to it.** This file carries an app's *status*; which individual
   queries are ported belongs in `parity-findings.md` beside the evidence. Front Page Audit's three
   writes were described in four places, and on 2026-08-20 two of the four still called a write unported
   after it had been built — twice in one day, because each copy had to be found and edited by hand. The
   [canonical block](../../../docs/moderator-app/retool-exports/parity-findings.md#front-page-audit-port-state-canonical)
   is the shape to copy: one table, and a line in every other file saying not to restate it.
