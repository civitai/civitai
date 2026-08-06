# Retool migration tracker

Every Retool app handed to us for migration, and how far it has got. **Update this file as part of the
work, not afterwards** — add the app when the export arrives, tick slices as they ship.

Status: `not started` · `in progress` · `partial` (shipped, deliberately incomplete) · `done` (nothing
left worth porting) · `dropped` (agreed not to port)

## Apps

| App | Export | Queries | Components | Route | Status |
| --- | --- | --- | --- | --- | --- |
| Moderation Status | `Moderation%20Status.json` | 77 | 197 | `/retool/moderation-status` | not started |
| User Lookup v2 | `User%20Lookup%20v2.json` | 170 | 433 | `/retool/user-lookup` | in progress |

Counts are from `extract.mjs` and measure the Retool app, not the work — most apps carry dead queries,
duplicates and Retool plumbing (`Function`, `State`, `Timer`).

---

## Moderation Status

Resources: `Replicated_Read_Prod`, `retool_db`, REST.

A queue/stat board rather than a lookup tool. Roughly four things live in it, and they are separable —
port them independently rather than as one page.

- [ ] **Help requests** — `GetHelpers`, `GetImageData`, `UpdateHelpRequest`. Reads
      `ModerationImageHelp` in **`retool_db`**, which does not exist here → needs a data migration
      before this can move.
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
- [ ] **Moderation memory** — `SelectUserNotes`, `InsertUpdateUserNotes`, `UserStrikes`. Lives in
      **`retool_db`** → data migration required.
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
- [ ] **Mutes** — `ActivateSystemMute`, `RevokeTimedMutes`, `RemoveDeserveMute`, `CurrentUTCTime`
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
