# Retool migration tracker

Every Retool app handed to us for migration, and how far it has got. **Update this file as part of the
work, not afterwards** — add the app when the export arrives, tick slices as they ship.

Status: `not started` · `in progress` · `partial` (shipped, deliberately incomplete) · `done` (nothing
left worth porting) · `dropped` (agreed not to port)

## Apps

| App | Subtask | Queries | Components | Route | Status |
| --- | --- | --- | --- | --- | --- |
| User Lookup v2 | `868kn6x1b` | 170 | 433 | `/retool/user-lookup` | in progress (8/11) |
| Moderation Status | `868kn5zg1` | 77 | 197 | `/retool/moderation-status` | not started |
| Bulk Image Manager | `868kn76au` | 40 | 60 | `/retool/bulk-image-manager` | not started |
| User Reports | `868kn78hc` | 34 | 57 | `/retool/user-reports` | not started |
| Chat Audit | `868kn7m9r` | 20 | 50 | `/retool/chat-audit` | not started |
| Front Page Audit | `868kn82bf` | 16 | 19 | `/retool/front-page-audit` | not started |
| Image Lookup | `868kn7q2v` | 10 | 21 | `/retool/image-lookup` | not started |
| Article Lookup | `868kn7t8d` | 3 | 9 | `/retool/article-lookup` | not started |
| Workflows (2) | `868kn80u9` | — | — | cron, not a page | not started |

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

## Moderation Status

Resources: `Replicated_Read_Prod`, `retool_db`, REST.

A queue/stat board rather than a lookup tool. Roughly four things live in it, and they are separable —
port them independently rather than as one page.

- [ ] **Help requests** — `GetHelpers`, `GetImageData`, `UpdateHelpRequest`. **Unblocked** —
      `ModerationImageHelp` is reachable through `getModeratorDb()` (37 open rows). `imageIds` is a
      jsonb array; `GetImageData` then reads those images from the main database.
- [ ] **Queue stats / throughput** — `HourlyImages`, `HourlyModels`, `MinorTimers`, `PoITimers`,
      `TagTimer`, `ModelTimer`, `ArticleTimer`, `FPATaskTimers`, `RRatingStats`, `TaggerRatio`,
      `MuteStats`. Charts and counters; overlaps the dashboard already built.
- [ ] **Report triage** — `Reports`, `RecentReports`, `UrgentReports`, `ActionReport`,
      `ActionAllPostReports`. **`UrgentReports` is already shipped** as the dashboard's "Most reported".
- [ ] **Rating / tag review** — `RatingQueue`, `ErrorRatingQueue`, `TagQueue`, `ResearchRating`,
      `LookUpTags`, `ReviewGrouped`, `blockedTagInsert`.
- [ ] **Insert/backfill jobs** — `MinorInsert`, `PoIInsert`, `ModelInsert`, `newUserInsert`,
      `*_catchup`, `*Timer`. These are Retool **workflows**, not UI. Most likely belong as cron jobs (or
      are already covered) — confirm before porting any of them.

## User Lookup v2

Resources: `Replicated_Read_Prod`, `Prod`, `Clickhouse`, `retool_db`, `BuzzTemp`, `Notifications DB`,
`MongoDB`, REST.

The big one, and the moderation team's primary console. **Do not attempt as a single page.** Slices below
follow the ClickUp design doc (868kkxqpn §1.2) — see
[`docs/moderator-app/retool-migration-tasks.md`](../../../docs/moderator-app/retool-migration-tasks.md).

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
      add, edit-own) and strikes (read-only) against the live moderator database, served from
      `/api/user-memory/[userId]` with writes as form actions on the page.
      **This is the reference example for a moderator-database slice** — see
      `moderation-memory.service.ts`.
      Writes put `locals.user.username` in `lastUpdateBy`, so the column now holds two naming schemes
      (Retool display names historically, Civitai usernames going forward). Edit-own is enforced by
      the `lastUpdateBy` predicate in the UPDATE, not in the handler.
      Not ported: issuing a strike (needs the user notification, still blocked) and the
      `deservedMute`/`spamWhitelist` flags.
- [x] **Security signals** — `RegistrationIP`, `SimilarIps`, `PotentialSpammerV2`. Served from
      `/api/user-signals/[userId]`, not the page load: ~250ms for the IP roll-up plus ~750ms for the
      shared-IP scan over a 31M-row table.
      **Use `targetUserId`, never `userId`** — on Login/Registration rows `userId` is empty ~95% of
      the time (30M of 31.5M logins), so filtering on it silently returns nothing. The main app's
      `csam.service.ts` has this wrong and is worth a look.
      `PotentialSpammer` (v1) not ported — V2 supersedes it.
- [ ] **Account actions** — `BANAPI`, `UNBANAPI`, `ToggleMute`, `ToggleMod`, `UpdateUserDeets`,
      `LogPurge`, `LogBan`. **Needs a decision before building** — investigated 2026-08-05:
      - `/api/mod/ban-user` attributes every ban to `userId: -1` ("civitai user"), so it cannot record
        WHO banned — which defeats §1.2e. It is also a *toggle* (a stale page could unban by accident)
        and returns 200 *before* awaiting the work, so failures look like successes.
      - Mute is not just a row update: `setUserMuted` also calls `invalidateSession`, which in the main
        app is ~100 lines of sysRedis token-hash work, signal notifications, session-cache clearing and
        fail-open deadlines. A spoke-side mute without it leaves the muted user posting until their
        session refreshes — a silent failure a moderator would blame on the tool.
      - `@civitai/auth` exposes `invalidateUserSessions`, but not the signal/cache half.
      So: either route these through `/api/mod/retool/user` (explicit mute/unmute/forceLogout actions,
      Bearer mod API key — but breaks the spoke-owns-its-mutations pattern), or lift session
      invalidation into a shared package first. Not a slice-sized piece of work either way.
- [ ] **Mutes** — `ActivateSystemMute`, `RevokeTimedMutes`, `CurrentUTCTime`. The `TimedMutes` rows are
      reachable through `getModeratorDb()`, but the table is **empty** — confirm the feature is still
      used before building. Actually applying a mute to the account stays blocked on session
      invalidation (see account actions).
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
- [ ] **Support context** — `GetFreshdesk`. **Blocked**: no `FRESHDESK_*` credentials in the
      moderator app's env, and the Retool query hits `civitai.freshdesk.com/api/v2` directly. Needs an
      API key and a decision on whether the spoke calls Freshdesk or the main app proxies it.

## User Reports

Resources: `Replicated_Read_Prod`, `retool_db`, ClickHouse, REST. The smallest of the three, and the
most action-heavy — 17 of its 57 components are buttons.

A report-triage console centred on one user: pull their reports, review the offending images inline,
then action them and strike the user. Overlaps `/reports` and the dashboard's "Most reported", so check
both before building.

- [ ] **Reports against a user** — `GetReports`, `ReceivedReports`, `ReportHistory`, `GetImageCount`.
      Postgres, read-only. `ReceivedReports` is the per-entity-type union (model/image/post/…) with a
      link to the content; `ReportHistory` is who set each status and when. Closest thing to unblocked
      work in this app — but much of it duplicates the User Lookup reports panel and `/reports`.
- [ ] **Image review inline** — `TOSImages`, `RemoveImages`, `RemoveImages2`, `RestoreImages`.
      **Destructive**; hits `/api/mod/remove-images`. Same blocker as account actions.
- [ ] **Strikes** — `UserStrikes`, `InsertStrike`, `LogStrike`, plus `RetoolActions`/`RetoolNotes`.
      **Unblocked** via `getModeratorDb()`, same as User Lookup's moderation memory. Sending the
      strike *notification* to the user is separate and still blocked (see notifications below).
- [ ] **Notifications to the user** — `SendNotification2`, `PostNotification`, `SendCorrectNotif`.
      Hits `/api/mod/send-mod-notification`; needs the same attribution decision as account actions.
- [ ] **Report actioning** — `ActionReport`. **Already shipped** on the dashboard ("Most reported"),
      using the same `setReportStatus` path.
- [ ] **App enable/disable** — `DisableApp`, `EnableApp`, `DisableAppRestore`, `EnableApp2`. Retool
      UI plumbing (locking the app while a batch runs), not functionality. Not portable, not needed.

Note: 13 of the 34 queries are `JavascriptQuery` — Retool-side batching and selection glue
(`query30` loops in batches of 10, `UnselectAll`, `log`). These are not data sources and have no
equivalent here; a SvelteKit form action does the same job.

---

## Rules

1. **Add the app here when the export arrives**, before writing code — even if it stays `not started`.
2. **Tick a slice only when it is shipped and verified** (typecheck + build + a look at the real page).
   A slice that is written but unverified is still unticked.
3. **Record what you deliberately skipped** under the app, with the reason. "Not ported" and "not needed"
   look identical six months later.
4. **`retool_db` slices are blocked on a data migration**, not on UI work. Do not tick them because a
   page renders; the data still lives in Retool.
5. **Nothing is `done` until the Retool app is switched off** — otherwise moderators keep using the old
   one and the two diverge.
