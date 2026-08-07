# Retool migration tracker

Every Retool app handed to us for migration, and how far it has got. **Update this file as part of the
work, not afterwards** — add the app when the export arrives, tick slices as they ship.

Status: `not started` · `in progress` · `partial` (shipped, deliberately incomplete) · `done` (nothing
left worth porting) · `dropped` (agreed not to port)

## Apps

| App | Subtask | Queries | Components | Route | Status |
| --- | --- | --- | --- | --- | --- |
| User Lookup v2 | `868kn6x1b` | 170 | 433 | `/retool/user-lookup` | **partial** — everything unblocked is built (unverified in a browser); what is left is blocked, not pending: see below |
| Moderation Status | `868kn5zg1` | 77 | 197 | `/retool/moderation-status` | not started |
| Bulk Image Manager | `868kn76au` | 40 | 60 | `/retool/bulk-image-manager` | not started |
| User Reports | `868kn78hc` | 34 | 57 | `/retool/user-reports` | not started |
| Chat Audit | `868kn7m9r` | 20 | 50 | `/retool/chat-audit` | **built** — all 20 queries ported and reviewed, unverified in a browser, Retool still live |
| Front Page Audit | `868kn82bf` | 16 | 19 | `/retool/front-page-audit` | not started |
| Image Lookup | `868kn7q2v` | 10 | 21 | `/retool/image-lookup` | **built** — all 10 queries ported, unverified in a browser, Retool still live |
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
      Not ported: `ToggleMod` and `UpdateUserDeets` (privileged, and `/api/mod/retool/user` requires a
      user API key the spoke should not hold).
- [x] **Mutes** — `ActivateSystemMute`, `RevokeTimedMutes`, `ViewMutes`. Timed mutes read/created/revoked
      against `TimedMutes` in the moderator database, each also applying or lifting the account mute so
      the schedule and the account cannot disagree.
      Built to the schema, not to observed usage: **the table is empty**, so nothing here has run against
      real rows. `userId` is cast to text, matching the column.
      Not ported: expiry. Nothing expires a timed mute automatically — Retool had no scheduler either
      (`CurrentUTCTime` was compared client-side). Needs a cron job to be more than bookkeeping.
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

- **Editing bio and socials**, **`ToggleMod`**, **`UpdateUserDeets`** — all go through
  `/api/mod/retool/user`, which needs a user API key the spoke should not hold.
- **Bulk delete / ToS of comments**, **purge all content**, **image removal** — destructive, with
  search-index and cache side effects the spoke does not own. Same decision as account actions.
- **Issuing a strike**, **notifying a user** — need the notification system.
- **Add / subtract Buzz**, **rewards eligibility** — the ticket itself suggests a separate app.
- **Notification history** — needs a Notifications DB connection the spoke does not have.

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

Resources: `Replicated_Read_Prod`, `Clickhouse`. Read-only — every action Retool's version could take
lived in the other apps. All 10 queries ported in one slice.

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
      `TopChats` NOT ported — nothing rendered it and it is another full-table GROUP BY.
- [x] **Spam detection** — `SPAMDetect`, the most useful thing on the page: the same text sent by one
      account into several chats. Retool ran it UNBOUNDED: 5.3s and a **429MB external merge sort
      spilling to disk**, because it groups 4.2M rows by full message text. 30-day window is 630ms with
      no spill. Message bodies are collapsed by default, matching the blocked-prompt decision on User
      Lookup.

Not ported: `BANAPI`, `SetNote`, `LogBan`. Every username links to User Lookup, which owns enforcement
with confirmation and an audit trail — duplicating a ban button here means two gates and two places to
get it wrong.

Deferred: message-text search is ~3s over 4.2M unindexed rows. A pg_trgm GIN index on
`ChatMessage.content` would fix it, but that is a large index and an extension — an infra decision, not
a migration one.
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
