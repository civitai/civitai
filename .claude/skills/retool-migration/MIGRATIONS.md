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
- [ ] **Reports** — `ReportCount`, `ReportsSubmitted`, `ReportedImageCount`, `ReportedModelCount`,
      `ReportedCommentCount`
- [ ] **Moderation memory** — `SelectUserNotes`, `InsertUpdateUserNotes`, `UserStrikes`. Lives in
      **`retool_db`** → data migration required.
- [ ] **Security signals** — `RegistrationIP`, `SimilarIps`, `PotentialSpammer`, `PotentialSpammerV2`
      (ClickHouse)
- [ ] **Account actions** — `BANAPI`, `UNBANAPI`, `ToggleMute`, `ToggleMod`, `UpdateUserDeets`,
      `LogPurge`, `LogBan`. All hit `/api/mod/*` — reuse those endpoints, do not re-implement.
- [ ] **Mutes** — `ActivateSystemMute`, `RevokeTimedMutes`, `RemoveDeserveMute`, `CurrentUTCTime`
- [ ] **Subscription + Buzz** — `SubTiers`, `SubTierStatus`, `UserSubscriptionStatus`, `CreatorClub`,
      `CreatorClubBuzz`
- [ ] **Reviews / comments** — `ReviewList`, `LogDeleteReviews`, `ComboComments`, `ImageComments`,
      `ModelComments`
- [ ] **Cosmetics** — `RemoveCosmetics`
- [ ] **Support context** — `GetFreshdesk`

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
