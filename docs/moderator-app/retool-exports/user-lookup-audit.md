# User Lookup v2 — full coverage audit

Every one of the 170 queries in the export, classified. Written after moderators showed screenshots of
Retool capabilities the port did not have.

**The export is not stale.** Re-pulled from ClickUp `868kn6x1b` on 2026-08-07 and re-extracted: 170
queries, byte-identical query set to the committed inventory. Everything missing was missed by the port,
not hidden by a bad export.

## Two method failures this audit exposed

1. **`extract.mjs` only reports queries.** "Stripe Chargeback Retrieval" — the button a moderator asked
   about — is not a query. It is one of five *preset labels* in a dropdown that populates the `BuzzSend`
   form (`Stripe Chargeback Retrieval`, `Stripe Refund`, `1st/2nd/3rd Place Stream Bingo`), each carrying
   a canned amount, buzz type and description. **Canned workflows are functionality and the extractor
   drops them.** Other label sets it dropped, all of which are real UI behaviour:
   - Timed-mute durations: `6 Hours / 12 / 24 / 48 / 72 / 1 Week` — ported as a free-text hours box.
   - `Submitted Reviews / Received Reviews` — only submitted was ported.
   - `Bounties / Bounty Entries` — neither ported.
   - `Model Comments / Other Comments`.
   `extract.mjs` now emits widget option sets under **"tabs & option sets"**. Re-running it on the same
   export immediately surfaced the app's real table of contents, none of which was visible before:

   | Widget | What it shows |
   | --- | --- |
   | `tabbedContainer8` | Submitted Reviews / **Received Reviews** |
   | `tabbedContainer9` | **Bounties / Bounty Entries** |
   | `tabbedContainer10` | Reports Received / Reports Submitted |
   | `tabbedContainer12` | **Buzz Transaction** |
   | `tabbedContainer13` | Reactions Given |
   | `buzzSendAction` | **Send Buzz to User / Deduct Buzz from User** |
   | `buzzType` | Yellow / Blue / Green buzz |
   | `buzzSendEntityType` | Collection / Image / Model |
   | `presetMutes` | 6 / 12 / 24 / 48 / 72 / 168 hours, with values |
   | `segmentedControl1` | Model Comments / Other Comments (`Comment` vs `CommentV2`) |
   | `select12`, `select13` | Report filters: Actioned/Unactioned/Pending; Admin Attention/NSFW/TOS Violation/Ownership/Claim |

   **Retool splits its apps with tabs, so the tab bar is the spec's table of contents.** A tab that was
   never ported is a capability that was never ported, and nothing in a query list says so.

2. **A ticket aside was treated as a decision.** The ClickUp description says of add/subtract buzz
   "maybe this should be a separate app". The tracker recorded that as settled and skipped it. It is a
   capability moderators use daily. Same error dismissed `CreatorClub`/`CreatorClubBuzz` as "a different
   domain from moderation".

## Status as of 2026-08-07 — the 97 is stale, and it was never 97

Four clusters shipped after this audit was written. Re-reading the list against what is now in the
app, **the "97 genuine gaps" figure overstated the work in three separate ways** and should not be
used for planning.

**Shipped since the audit** (commits `f0f7de93b3`, `c5689dedce`, `1e0ec57362`):

| Cluster | Queries closed |
| --- | --- |
| E1 | `FindPreviousBans`, `SimilarIpStrikes` — ban/mute/strike history on linked accounts, on the social list too |
| E2 | `ReceivedReviews`, `BountyList`, `BountyEntryList` |
| E3 | `CuratorStatus`, `CuratorStatus2`, `UserRank`, `GetModelVersions`, `GensPerResource`, `ClickhouseUserActivities`, `GetNotifications`, `ViewNotifications` |
| D1 | `ClearCache`, `RefreshSession` — confirmed never blocked on an API key |
| D2 | `UpdateUserDeets`/`UpdateUserProfile` (profile text), `InsertNewSocial`, `NullSelectedSocial`, `RemoveDeserveMute` |

**Counted as missing but already ported when the audit was written:** `UserCosmetics` (read),
and the whole mute/ban surface — `Mute`, `Unmute`, `MuteUnmute`, `ToggleMute`, `BANAPINOREASON`,
`ForceLogout` — which the port had covered locally rather than by the Retool query name.

**Counted as missing but deliberately not ported, with the reasoning already in the code:**

- `ReactionsAll` — unbounded raw rows; `ReactionsGrouped` answers the question they were scanned for.
- `GeneratorCount` — an all-time COUNT over 1.08B rows; `UserStat.generationCountAllTime` is free.
- `UserChats`, `WarrantChatLog` — transcripts belong to Chat Audit; User Lookup carries the contact
  banner instead.
- `ToggleMod` — granting moderator needs the role-tier decision still open in the tracker.

**Not User Lookup's job at all.** These have no `userId` filter — they are site-wide admin lists that
happened to live in the same Retool app, and porting them into a per-user lookup would be wrong:
`MutedList`, `BannedList`, `ModeratorList`, `CuratorList`, `SubscriberList`, `MostFollows`,
`UsersWithNotes`, `HolidayTeams`, `HolidayTeamCounts`, `UsersCreatedCurrentDay`,
`DistinctUsersWithSocialLinks`, `SubTiers`, `SubTierStatus`, `TopBuzzKoenQuery`, `TopBuzzUsernames`.
They want their own tool; track them there.

**Not portable as written:** the `CreatorClub` group reads `UserStripeConnect`, which is not in the
Prisma schema this app types against.

### Closed since, and two deliberate refusals

**Cosmetic Shop** is now a section: `GetPurchases`, the refund flow
(`DeleteUserCosmetic` + `UpdateShopTransaction`), and `UnlockCosmetics` +
`AvailableCosmeticList` as a badge grant. Two corrections to Retool's versions, both load-bearing:

- Retool deleted the cosmetic by `claimKey` **alone**. `UserCosmetic.claimKey` defaults to the literal
  `'claimed'` for anything not bought from the shop, so that statement was one mistyped key away from
  deleting every claimed cosmetic on the site. Ours is scoped by `userId` and cosmetic.
- Retool's `GetPurchases` joined `UserCosmetic` → `CosmeticShopItem`, which matches any owned cosmetic
  that merely has a shop listing — including granted ones — and cannot see `refunded`. Reading
  `UserCosmeticShopPurchases` instead means an already-refunded purchase is visibly refunded, which is
  the one fact a refund flow needs to avoid doing it twice.

The refund does **not** return the Buzz. Retool's did not either, and an amount decided by the tool
rather than the moderator is the wrong default on a money path — the Buzz section does it explicitly.

**`transactionTypes` — deliberately not ported.** It populated a picker whose value fed the buzz
transaction's `type`. Ours does not send one, so the service assigns it. Offering a moderator a free
choice of `type` from `SELECT DISTINCT` would let a grant be filed as any category in the ledger,
which is worse than a consistent default.

**The Paddle account-linking workflow (`tabbedContainer14`) — not ported.** Three tabs, no queries
behind them, and Civitai no longer uses Paddle (confirmed 2026-08-07). Recorded here so the next
audit does not rediscover it as a gap.

### What is actually left

- **Report detail lists.** `ReportsReceived`, `ReportsSubmitted`, `ReportOnUser`, `ActionReport` — the
  panel still shows only counts where Retool showed rows with status and who set it. **This is the
  largest remaining gap.**
- **`SendNotification`** — an arbitrary moderator-authored notification, separate from the strike
  notification that now fires. `CommentsWithLinks` (a spam-detection read over comment bodies).
- **`SubmittedReviewImageCount`**, and `GetSuccesfulPromptsUpdated` (MongoDB, no connection).
- **Bulk Image Manager** — ticket 1.3, absent from the section nav until it has a panel.

Clusters A, B and C are otherwise done. The `ReToolActions` vs `ModActivity` question below is **not**
a blocker for them and was not treated as one: this is a 1:1 port, and reconciling two audit tables is
a separate decision. Everything written here logs to `ModActivity`.

## Classification of all 170

### Ported (42)

Shell/identity, counts, stats, reports-filed, moderator activity, notes, strikes, security signals,
account actions, timed mutes, subscription, yellow buzz balance, buzz history, reviews, comments,
cosmetics (read), Freshdesk, socials, reactions, trainings, scores, bio, blocked prompts, mod contact.

### Not portable — Retool plumbing (14)

`darkmode`, `enableedit`, `CurrentUTCTime`, `query150`, `query152`, `query153`, `PaymentsGroup`,
`ReceiptsGroup`, `BuzzTransferPopulate`, `BuildClickhouseLog`, `RequireAuthList`, `alternateAccount`,
`UserPhotoList`, `AvailableCosmeticList` (the last two feed Retool-side pickers).

These are table grouping, state setters and UI glue with no server-side meaning.

### Covered by an equivalent (17)

Retool ran one COUNT per content type; the port runs them from one `COUNT_SOURCES` list. Superseded and
duplicate queries are here too.

`ArticleCount`, `ImageCount`, `ModelCount`, `ModelCount2`, `ModelCountsUnion`, `PostCount`,
`CommentCount`, `ImageComments`, `ModelComments`, `CollectionCount`, `ReviewCount`,
`ReportedCountUnion`, `ReportsSubmittedUnion`, `FollowerCountUnion`, `PotentialSpammer` (v1, superseded
by V2), `InsertUpdateUserNotes2` (duplicate), `MuteStatus`.

### MISSING — genuine capability gaps (97)

Grouped by cluster, with what each needs.

#### A. Buzz and commerce — the cluster moderators are asking for

| Query | What it does |
| --- | --- |
| `BuzzSend` | POST `buzz.civitai.com/transaction` — **award or remove buzz**, any type, with description |
| `transactionTypes` | Populates the type picker from ClickHouse |
| `BuzzTransferPopulate` + the 5 presets | Canned transactions: Stripe Chargeback Retrieval, Stripe Refund, Stream Bingo 1st/2nd/3rd |
| `LogTransaction`, `LogProtectBuzz`, `LogRemoveBuzz` | Audit rows in `ReToolActions` |
| `GetGenBuzz`, `GetGreenBuzz` | Blue and green balances — **only yellow was ported** |
| `CreatorClub`, `CreatorClubBuzz`, `CreatorImages`, `CreatorModel` | Creator Club status and balance |
| `GetPurchases` | Cosmetic-shop purchases with amounts |
| `DeleteUserCosmetic`, `UpdateShopTransaction`, `LogShopRefund` | **Shop refund flow** |
| `UpdateBuzzEligible` | `/api/mod/set-rewards-eligibility` |
| `UnlockCosmetics` | Grant cosmetics |
| `TopBuzzKoenQuery`, `TopBuzzUsernames` | Top buzz holders |

**This is a write-heavy cluster against the Buzz service and shop tables — a different risk profile from
everything ported so far, which was read-only or delegated to the main app.**

#### B. Content moderation actions

`DeleteComments`, `ToSComments`, `CommentsWithLinks`, `DeleteReview`, `ExcludeOrIncludeReview`,
`LogCommentDelete`, `LogDeleteReviews`, `LogToClickhouse`, `PURGEAPI`, `LogPurge`, `LogRemovePG13`.

Comment/review deletion and ToS-flagging, plus purge-all-content. Previously deferred as "destructive".

#### C. Strikes and notifications

`InsertStrike`, `LogStrike`, `InsertStrikeNotif`, `LogStrikeNotif`, `SendNotification`,
`LogNotificationSent`, `RetoolNotes`, `RetoolActions`.

Issuing a strike and notifying the user. Needs the notification system.

#### D. Account actions not ported

`BANAPINOREASON`, `ForceLogout` (Retool's REST version), `Mute`, `Unmute`, `MuteUnmute`, `MutedList`,
`BannedList`, `RemoveDeserveMute`, `RevokeSystemMute`, `ToggleMod`, `LogToggleMod`, `LogToggleMute`,
`LogBan`, `UpdateUserDeets`, `UpdateUserProfile`, `LogUpdateUserDeets`, `RefreshSession`, `ClearCache`,
`InsertNewSocial`, `NullSelectedSocial`, `LogSocialChange`.

Includes **editing bio/socials** and **cache/session refresh**, both previously recorded as blocked on an
API key. `ClearCache` and `RefreshSession` are plain webhook-token endpoints and are **not** blocked.

#### E. Reads not ported

`ReceivedReviews`, `SubmittedReviewImageCount`, `BountyList`, `BountyEntryList`, `UserCosmetics`,
`GetModelVersions`, `GensPerResource`, `GeneratorCount`, `ClickhouseUserActivities`, `FindPreviousBans`,
`SimilarIpStrikes`, `UsersWithNotes`, `ReportsReceived`, `ReportsSubmitted`, `ReportOnUser`,
`ActionReport`, `UserChats`, `WarrantChatLog`, `GetNotifications`, `ViewNotifications`, `UserRank`,
`SubTierStatus`, `SubTiers`, `SubscriberList`, `UserSubscriptionStatusAnnual`, `CuratorList`,
`CuratorStatus`, `CuratorStatus2`, `LogCurator`, `ModeratorList`, `MostFollows`, `HolidayTeams`,
`HolidayTeamCounts`, `UsersCreatedCurrentDay`, `DistinctUsersWithSocialLinks`, `ReactionsAll`,
`GetSuccesfulPromptsUpdated`.

Notable: **`FindPreviousBans` and `SimilarIpStrikes` enrich the shared-IP panel** — they show whether the
linked accounts were themselves banned, muted or struck. The port shows the accounts without that, which
is the part that makes the panel actionable. **`CuratorStatus`** matters because curators have elevated
permissions.

## Recommended order

1. **Fix `extract.mjs` first**, then re-audit Image Lookup and Chat Audit. Both were ported with the same
   blind spot, so both may be missing canned workflows the same way this one was.
2. **Buzz and commerce (A)** — what moderators are actually asking for.
3. **Ban/mute/profile gaps (D)**, starting with the ones that turn out not to be blocked.
4. **Read enrichment (E)**, prioritising `FindPreviousBans` + `SimilarIpStrikes`.
5. **Destructive content actions (B)** and **strikes/notifications (C)** last — they need the decisions
   that have been deferred all along.

## Open question for the team

Retool logs every action to `ReToolActions` in the moderator database. The port logs to `ModActivity` in
the main database instead. Both are defensible, but **they are different tables and nothing reconciles
them** — a moderator auditing "who did what" gets different answers depending on which tool was used.
Decide before porting the write-heavy Buzz cluster, because that is where the audit trail matters most.
