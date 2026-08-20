# Retool parity — what must exist before Retool is switched off

**This is the priority list.** Everything here exists in Retool *today* and is either missing from the
port or provably different. Improvements the team has asked for but Retool never had live in
[`post-migration-backlog.md`](post-migration-backlog.md) — keep them out of this one.

Sources: the eight JSON exports, the ClickUp subtasks under `868kkxqpn`, 13 screenshots on the User
Lookup subtask, and two Loom walkthroughs (transcripts, 2026-08-09). Where an item quotes the
walkthrough it is marked 🎥.

Detail and evidence for most items: [`retool-exports/parity-findings.md`](retool-exports/parity-findings.md).

## Two things the exports cannot tell you

**1. A Retool query is often a REST call into the main app, not a database write.** Do not read
`retool_db` and assume the rest is local SQL. Across all nine exports there are **13 distinct main-app
endpoints** — `ban-user`, `remove-images`, `restore-images`, `remove-all-content`,
`send-mod-notification`, `update-image-flag`, `action-report`, `set-rewards-eligibility`,
`reset-user-subscription-caches`, `admin/cache-check`, and the `retool/{user,comment,review}` family.
All are either called by the port or deliberately reimplemented (`action-report` → local
`setReportStatus`, which additionally rewards reporters). **When classifying a query, check the
resource and the URL before deciding where it belongs.**

**2. The export has no event handlers and does not dump frame-level widgets.** So:
- The persistent header (strike chip, *Talked to a mod*, sub tier, Force Logout, the three lookup
  inputs) appears in **no** container in the layout dump — it lives in the app frame. Porting from the
  export alone, you would not know it exists.
- **Every click target is invisible.** The single most load-bearing word on the Basic screen is
  *"Content (click rows!)"*, and nothing in the export records what a row click did.
- `navigation1` is the *designed* section list, not the shipped one — the live nav omits an entry the
  export contains.

A screenshot beats the export for anything in those three categories.

---

## 0. Bulk Ban — a ninth app, export now in hand

Subtask `868kn87qj`, *"Place to easily ban a list of users."* It was missed because the migration
tracker only ever listed nine of the parent's **thirteen** subtasks. Export pulled and inventoried at
[`retool-exports/bulk-ban.md`](retool-exports/bulk-ban.md) (15 queries / 12 components).

- [x] **Port it.** Paste a newline-separated list of user ids → `BANAPI` per user
      (`/api/mod/ban-user`, one call each with a retry counter, capped at 5 consecutive failures) →
      `ListUsers` to confirm `bannedAt` landed → `LogBans` to `retool_db`.
- [x] **It is also a ban-evasion console**, which is the part not to drop: `GetUsers` (buzz
      transactions), `GetIP` and `UsersByIp` (ClickHouse `userActivities` grouped by registration IP),
      `GetEmail`/`getEmails`, `UserNotes`. That is how a list of accounts is assembled in the first
      place.
- [x] `deleteComments` runs against `Prod` as part of the flow — confirm whether banning here is
      expected to remove comments too.
- [ ] 🎥 **Restricted today, and that is a decision to revisit**: *"limited to only some mods… that's
      good for other mods to have access to this too."* Gate it, then widen deliberately.

## 0b. Four subtasks the tracker never listed

`868kne95c` Model Reports · `868kn8aa0` Misc Mod Asks · `868kn67aq` ReTool Database Migration ·
`868kn87qj` Bulk Ban. Only the last is a page to build; the others are covered below and in the backlog.

- [ ] **Model Reports** (`868kne95c`): *"include the link and display the modelId to reduce the amount
      of clicking."* 🎥 the walkthrough says *"we don't need this one, actually"* — **the ticket and the
      video disagree; ask before building or dropping.**
- [x] **ReTool Database Migration** (`868kn67aq`) — **planned and the SQL is written**; a human still has
      to run it. Plan: [`retool-db-cutover.md`](retool-db-cutover.md), scripts:
      `apps/moderator/moderator-db/cutover/`. The tables are already copied into the moderator database;
      what remained was a delta, the sequences, and one collision.
      Two findings that change earlier assumptions: **`Mods_TaskTimers` (+22) and `FrontPageTimers` (+18)
      are drifting too** and were on no list, though the dashboard reads both; and **the id collision has
      already happened** — two `UserNotes` ids were spent locally on 2026-08-07 while Retool spent the
      same two, so id preservation is no longer universal and those two rows are re-idded with the remap
      recorded. Everything else is byte-identical below its watermark (md5-verified, not just counted).
      `ModelNotes` **is** being migrated (935 rows, wanted by `868kn8aa0`); it still needs a
      `moderator-db-types.ts` entry when that feature is built.
      🔒 That ticket body contains a **live Postgres connection string with its password** — rotate it.

## 1. User Lookup — the primary console

Ported but incomplete. The header items are visible on every section in Retool, not buried in one.

### 1b. Widget-by-widget option-source audit, 2026-08-10

All **34** option-bearing widgets in the export (22 Select, 7 Checkbox, 1 RadioGroup, 1 SegmentedControl,
2 Switch, 1 SplitButton) were resolved to their actual `dataBindings` and diffed against the build.

- [x] 🔴 **`StrikeReasons` — the strike modal's reason picker** (2026-08-10 — all eight, with their user-facing messages, in `$lib/moderation-reasons`; the picker fills an editable box so "Other" is simply the empty entry. On BOTH strike forms — User Lookup and User Reports).
- [x] **Buzz *Reason* was wrong in BOTH directions** (fixed 2026-08-10). It is not
      `SELECT DISTINCT type` (that query binds to nothing); it is
      `{{buzzSendAction.value === 'send' ? SendTypes.value : DeductTypes.value}}` — **scoped by
      action**. The first fix shipped all 28 ledger types in both directions, making `deduct + Reward`
      selectable. Now send → Reward/Refund, deduct → Purchase/ChargeBack/AuthorizedPurchase, matching
      the Deduct Types table beside it. Widening either list is a mod-team decision, not a default.
- [x] **Filter rows** (2026-08-10 — shared `ListFilterBar`, client-side over the fetched rows as Retool's were, each showing "N of M" so a filtered-empty list never reads as an empty account). Reviews written: Rating / ToS / NSFW / Excluded / Search content, and the review TEXT now renders — it was fetched and dropped, so reviews were deleted on rating and date alone. Reviews received: Rating / Search. Bounties: Type / Complete / Name / Description. Mod Activity: Action / Type. Reports: Reason / Type on both lists. Caps raised 25 -> 100 so the filters have a corpus.
- [x] **Full name (`name`)** (2026-08-10 — selected in `getIdentity` and editable behind Enable Edits).
- [x] **`onboarding` (Accepted TOS) and `excludeFromLeaderboards`** (2026-08-10 — header chips, shown only when notable).
- [x] **`UpdateBuzzEligible` could not succeed and had no UI.** `setRewardsEligibility` posted
      query-string params to an endpoint that parses `req.body` and requires `modId` — every call 500'd.
      Now a body POST carrying `modId`, with Retool's three buttons (Add Buzz-Block / Remove Buzz-Block
      / Generator Buzz Earnings) on the Admin section.
- [x] **`ToggleMod` was built but unreachable** — no UI posted to it. Now on the Admin section behind
      the senior gate, **plus a local self-action check**: the endpoint's own guard compares against the
      API key's owner, not the moderator clicking, so it never fires from the spoke.
- [x] **`/api/mod/ban-user` accepted three parameters the form never sent.** `detailsExternal` (read by
      the appeal flow) and `removeMedia` are now on the ban form — without the latter a Nudify or
      Harassment ban leaves every image up and needs a separate purge.
- [x] **`presetMutes` was a free-text hours box.** Now Retool's 6h/12h/24h/48h/72h/1 week.

Open, with the evidence each audit produced:

- [x] 🔴 **Timed mutes never expire** (2026-08-12 — decision: a moderator's manual mute overrides the
      strike system). `addTimedMute` wrote the moderator-DB row and set `muted`, but never
      `User.muteExpiresAt` — the only column `processTimedUnmutes` selects on — so a 24-hour mute was
      permanent while the panel rendered it as expiring.
      The blocker was that `muteExpiresAt !== null` carried **two** meanings: "has an expiry" and "came
      from strikes". **Superseded 2026-08-20:** the separator is `mutedAt`, not the `meta.manualMute`
      flag this entry originally described — that flag was written by two apps and read by none, while
      `mutedAt` already meant "a moderator decided this" for `confirm-mutes`, `entity-moderation` and
      `prepare-leaderboard`. `evaluateStrikeEscalation` now skips **and does not shorten** a mute
      carrying it, and both strike unmute paths clear it so it cannot go stale.
      `retool/user → mute` takes an optional `expiresAt` (omitted = today's indefinite mute).
      Verified end to end on 1290051: a 24h mute wrote `muteExpiresAt` exactly 24.0h out; revoke
      cleared mute and expiry. (The `manualMute: true` this originally recorded no longer exists — see
      above.) 58 strike-service tests pass, both apps typecheck.
- [x] **Strikes write a second, disconnected ledger** (2026-08-12 — decision: the main app owns strikes,
      Retool only ever gave mods manual give/revoke on top of it). `addUserStrike` inserted into the
      moderator database's legacy `UserStrikes`, which gets none of what a strike does. Issuing now calls
      `retool/strike → create`, so escalation, points, expiry, the typed `strike-issued` notification and
      the void path all apply. The legacy table stays as Retool-era history: read and shown, never written.
      `ManualModAction` is the reason on purpose — it is both the right classification and the one value
      the endpoint exempts from the 1-auto-strike-per-day limit; any other value silently returns
      `{ skipped: true }` on a moderator's second strike of the day, which a 200 would have hidden. The
      spoke now treats that shape as a failure.
      🔴 **This uncovered a live production outage, fixed in the same change.**
      `evaluateStrikeEscalation` ran `SELECT SUM(points) … FOR UPDATE`, which Postgres refuses outright
      (`0A000: FOR UPDATE is not allowed with aggregate functions`). It is called by `createStrike`,
      `voidStrike`, `expireStrikes` (daily) and `processTimedUnmutes` (hourly) — so **no strike could be
      issued or voided, no strike ever expired, and no timed mute ever lifted**. The two crons catch per
      user and log, so it failed silently: **679 `strike-expired-escalation-failed` events in the last 30
      days of `civitai-prod`**, every one this error. Fixed by locking the rows and aggregating in a
      second statement inside the same transaction — same lock, valid SQL. Note the 55 strike-service
      tests passed before and after: they mock Prisma, so no test could have caught it.- [x] **Local mute / force-logout skip the session SIGNAL** (2026-08-11). Fixed inside
      `invalidateUserSessions` rather than at the four call sites, so mute, unmute, force-logout,
      `unmuteAndClearTimed` and `revokeTimedMute` are all covered and a sixth caller cannot forget it.
      Always sends `invalid`, never `refresh`: the tokens are revoked by the time it fires, so a
      refresh signal would send the client at a dead token. Best-effort like the main app's — a signals
      outage must not fail a mute that is already written — and reads a new `SIGNALS_ENDPOINT`, which is
      **unset in local dev**, so this is a no-op there. Verified by pointing it at a stub, which logged
      `POST /users/1290051/signals/session:refresh {"type":"invalid"}`.
- [x] **Cosmetic grant and shop refund miss the owned-sticker cache bust** (2026-08-11). The audit
      understated it: `grantCosmetic` busted **nothing at all**, so a granted badge stayed invisible on
      the profile for a day as well as unsendable for five minutes. All three keys now go through one
      `bustUserCosmeticCaches` helper (`USER_COSMETICS`, `USER_OWNED_STICKER`, the `COSMETICS` tag),
      shared by grant, refund and removal so a fourth write path cannot pick a subset again. Verified by
      planting sentinel values on all four Redis keys and confirming the action cleared every one.
- [x] **"Remove Badges" (`RemoveCosmetics`) ported** (2026-08-11 — a Remove control per row on the
      Cosmetics panel). Done **locally** rather than via `retool/cosmetic → unassign`, which the audit
      suggested: that endpoint refreshes the sticker cache alone, leaving the profile-level caches stale
      for a day, and attributes to the shared API key's owner instead of the acting moderator. Scoped to
      the exact `(cosmeticId, claimKey)` row clicked, so a cosmetic held twice loses only the claim on
      screen — the endpoint deletes every claim. `user-account.service.ts` carried a comment saying this
      was *deliberately* unported because "the main app's equivalent also refreshes entity caches and
      search indexes"; `unassignCosmetic` does neither, so the stated reason was false and the comment
      is gone.
- [x] **Every `retool/*` call attributes to the API key's owner** — **RESOLVED 2026-08-19** by session
      forwarding instead of minted keys: the spoke relays the acting moderator's own cookie to
      `/api/mod/*`, so the audit row, the `privileged` check and the rate-limit bucket are all per
      moderator. The original plan was to **mint per-moderator keys** so actions are attributable, deferred as its own piece of work rather than
      folded into parity. Until then one shared `CIVITAI_MOD_API_KEY` confers each `privileged:`
      capability on everyone who can reach the page, shares the per-actor rate limits, and puts the key
      owner on every `retoolAudit` row. Note this now matters more, not less: strike issuing moved onto
      this key today, so a strike's `retoolAudit` row names the key owner while `ModActivity` names the
      real moderator. (`updateIdentity` had no local gate either; §12i gave it one — `identity.edit`.)
- [x] **Filter rows missing on five list panels** (2026-08-11 completes this). Reviews, Bounties and
      Reports were done by the 2026-08-10 filter work; **Comments** now has Retool's search on both
      lists, matched against the plain text rather than the stored HTML — searching the markup meant
      "p" hit every row.
      Fixing it exposed a defect in the **existing** filter work, not just the new bar: `ListCard`
      renders its empty state *instead of* `children`, and every filter bar lived in `children` with a
      **filtered** count passed as `total`. So filtering down to zero matches hid the filter bar — the
      only way to undo the filter that emptied the list. `ListCard` now takes a `controls` snippet
      rendered above that branch, and all four panels pass their bar there. Verified on an account with
      zero model comments: `Model comments (0) | Search content | 0 of 0 | None.`
      (`ReportsPanel` was already safe — it passes the unfiltered count.)
- [x] **Prompt Audit filters** (2026-08-11 — Retool's Filter Prompt and # of Prompts, 25/50/100/500).
      The count was hardcoded at 25, which is the wrong default for the one question this panel answers:
      whether a pattern repeats. The filter searches the negative prompt too — a blocked term sitting in
      the negative is the same finding, and Retool's matched both. The collapsed-by-default behaviour is
      kept: these are prohibited prompts, so reading them stays a deliberate act.
      Also fixed a truncation lie: the footer compared the server cap against itself, so a server-capped
      list reported its cap as the total. It now says "N of M loaded from the server", which is a
      different fact from the count control's cap.
      ⚠️ **Typecheck only — not exercised in a browser.** Blocked prompts come from ClickHouse and no
      account reachable from local dev has any (every one tried renders "0 blocked prompts"), so the
      filter, the count control and the new footer are all unrun.
- [x] **Bulk review/comment deletion has no confirmation step** (2026-08-11 — shared `ConfirmSubmit`,
      used at all four destructive bulk sites: reviews delete, and delete + Remove-as-ToS on both comment
      lists). The confirm button is the **only** real submit — the first click is `type="button"` and
      posts nothing — so the form cannot fire before the count has been read back. Zero selected disables
      it outright, which also kills the silent no-op of acting with nothing ticked. Verified in a browser:
      disabled at 0, enabled at 1, "Delete 1 comment?" with Yes/Cancel, and no navigation on first click.
- [x] **`notificationLink`** (2026-08-12). `sendModNotification` already accepted a `url`; only the form
      and the action never sent one, so every notification shipped as dead text while the receiving end
      was ready for it. The field is **validated to relative paths and civitai.com/.red URLs** — this
      renders as a click-through in the user's tray, so an unrestricted field is a moderator-authored
      redirect to anywhere. Verified: the send form posts `userId`, `message`, `url`.
- [x] **"Number of Notifs" control** (2026-08-12 — 25/50/100/200, on its own
      `/api/user-notifications/[userId]?limit=` endpoint so changing it does not refetch the other
      twelve queries; server-clamped to 200). ⚠️ **Not exercised**: the notifications service is
      unreachable from local dev, so the list renders "service unavailable" and the control never
      appears. The endpoint is confirmed firing at `?limit=25`.
- [ ] 🚧 **Delete Notification — BLOCKED, needs a new endpoint.** Not a wiring gap. The
      `@civitai/notifications` client exposes no per-notification delete; its only delete is
      `cleanupNotifications({ before })`, an **age-based bulk purge across every user**, which is not
      this action. Shipping it needs a route on `apps/notifications` plus a client method, then the
      moderator-app wiring — a cross-app change, not a panel change.
- [x] **`GensPerResource` look-back days hardcoded to 30** (2026-08-11 — Retool's selector, 7/30/90/365).
      Moved to its own `/api/user-generations/[userId]?days=` endpoint rather than a parameter on the
      account bundle, so changing the window does not refetch the other thirteen queries — and this app's
      only ClickHouse read now fails on its own instead of taking Reviews, Comments, Bounties and
      Cosmetics with it (the reason it needed a `softly` wrapper there). `days` is **clamped** in the
      endpoint: it is interpolated into the ClickHouse query, not bound. The control is deliberately
      **outside** `ListCard` — that component renders its empty state instead of the body snippet, so a
      control nested inside vanishes on exactly the accounts where you need to widen the window to find
      anything. (Caught by looking at the page; it typechecked fine either way.)
- [x] **Cover image and profile picture not shown** (2026-08-11 — a Profile media block on Basic:
      avatar, cover, and the SFW cover, each with its browsing-level badge). Linking out was the wrong
      trade: it makes a moderator load the profile of an account they may be about to act on.
      Two things the port had wrong underneath: `getIdentity` selected `u.image`, which is the **legacy**
      avatar URL and is rendered nowhere — the real avatar is an Image row behind `profilePictureId`,
      and only that carries the `nsfwLevel` being checked. And `UserProfile` has **two** covers
      (`coverImageId` and `sfwCoverImageId`); both are shown, because an account can pass on the SFW one
      and fail on the real one, and a moderator asked about a cover needs the one that was reported.

- [x] **Header: the strike chip, subscription tier and Force Logout** (2026-08-11). The first two were
      already there; **Force Logout** is now in the header too, where Retool had it — it is the thing
      you reach for while reading something else, and it was a section away. `?/forceLogout` resolves
      against the current section route, so it works from every section. Sessions only: it does not
      mute, ban or change the account, so it needs no confirmation.
      Mute / ban / purge stay under Admin deliberately — see the Placement item below, which is about
      those three and is still open.
- [x] **Paddle account linking** (2026-08-12). Retool's three steps are one form on the Subscription
      panel: enter a customer id → if another account holds it the submit comes back **refused (409)
      naming that account**, and only a second, explicitly-labelled submit ("Unlink there and link
      here") moves it. Taking a customer id off another account is the destructive half, so it is never
      automatic. Unlink is there too.
      The holder is re-checked **at submit time**, not trusted from the rendered page — it can change
      between the two clicks, and the moderator's confirmation was about a specific account. Both sides
      get their own `ModActivity` row (`paddleUnlink` on the old account, `paddleLink` on the new), and
      the subscription caches are reset afterwards or the panel keeps rendering the pre-link state and
      invites a second link.
      Written directly rather than through a main-app endpoint: the column has no mod endpoint, and it
      is a plain pointer — Paddle's webhooks resolve the account BY it, which is exactly why a mis-link
      matters and why this needed fixing.
      Verified end to end on dev: conflict refused and named (`Maxfield already holds that customer
      id`), take-over moved it with both audit rows written, panel re-rendered with the new id. Both
      accounts restored afterwards.
- [x] **"Content (click rows!)" is a drill-down, and ours goes somewhere else** (2026-08-11). Rows now
      prefer an in-app destination: Images → Bulk Image Manager, both comment rows → the Comments
      section, Reviews → Reviews, Chat Messages → Chat. Those last four linked **nowhere** before, and
      the public profile hides exactly the deleted / unpublished / TOS'd content a moderator came for,
      so a row reading 40 could open a page showing 12.
      ⚠️ Models, Posts, Articles and Collections still link out to the public profile — the app has no
      in-app list for those content types yet, so the count-vs-page mismatch survives on those four.
- [x] **A ninth Content row, Chat Messages** (2026-08-11). `AllCountsUnion` does not produce it, which
      is exactly why an export-driven port could not see it — and a moderator judging harassment is
      counting DMs.
- [x] **Placement** — **deliberate divergence, not a gap** (decided 2026-08-12). Retool put mute / ban /
      purge / freshdesk / refresh-session / clear-cache in a bar on the landing section; here they stay
      one section away under Admin, and that is the intended shape.
      Reasoning: ban and purge are the two actions that got confirmation steps *because* they are
      dangerous, and a destructive bar on the first screen of every lookup undoes that care — the landing
      section is where a moderator arrives to *read*, often about an account they will not act on. What
      Retool actually bought with that bar was **immediacy of state**, and that is now on the landing
      section anyway: ban reason, CSAM chip, strike counts, restriction status, subscription tier, open
      reports and who filed them are all header chips visible from every section.
      The one genuinely reach-for-it-mid-reading action, **Force Logout**, was moved into the header —
      it touches sessions only and needs no confirmation. Revisit if moderators report the extra click
      on mute specifically; that is the only one of the six with a real argument for promotion.
- [x] **`sections.ts` is inverted against the live nav**: it ships *Content Overview* (which the live
      sidebar does **not** show) and omits *Bulk Image Manager* (which it does). That page now exists.
- [x] **"Talked to a mod"** (2026-08-12). The header chip is now the button Retool had: clicking it
      drops the chat ids under the header, each linking straight to that transcript in Chat Audit, with
      "+N more" pointing at the Chat section. Collapsed by default — the chip is the signal, the ids are
      what you want once it has fired.
      🔴 **Found while wiring it: every existing chat link on this page 404'd.** `ChatContactPanel`
      linked to `/retool/chat-audit/search?q=<id>`, and `search` is not one of the four tabs — the tab
      param is validated with `error(404)`, so following the ids the ticket asked for landed on Unknown
      tab. Both places now use `/retool/chat-audit/chats?chat=<id>`, the form `$lib/reports` already
      used. Verified on 43555: seven chat links, all resolving.
- [x] **Report banner** (2026-08-12 — the header placement was already there; **the action was the
      missing half**). Its link went to `/reports/user`, the whole 533-row queue, which leaves the
      moderator to find the account again. It now points at `/retool/user-reports?user=<id>` — that
      account's own drill-down, where the report can be actioned with their content and history in
      front of you. Verified on 2271388: `1 open report against this account. → Work this account's
      reports` resolving to `/retool/user-reports?user=2271388`.
- [x] **CSAM banner** (2026-08-09 — `getIdentity` counts `CsamReport` and the layout header carries a
      `CSAM report ×N` chip on every section).
- [x] **Mute state must distinguish system from manual** (2026-08-12 — the Overturn path is the half
      that was missing). The header chip has read `<type>: <status>` since 2026-08-09; what a moderator
      could not do was *rule* on it. Unmute clears `muted` and nothing else: the row stays **Pending**,
      the subscription cancelled by the restriction stays cancelled, the prohibited-request count stays
      where it was, and the user is never told which way it went.
      `resolveUserRestriction` in the main app is the single write path that does all of that, and it
      was reachable only from the tRPC moderator router — i.e. not from this app at all. So this needed
      **a new main-app endpoint**: `POST /api/mod/restriction/resolve`, built on
      `defineModeratorEndpoint` (originally the `defineRetoolEndpoint` family, deleted with Retool on
      2026-08-19). The Admin section shows Overturn / Uphold
      with an optional message **above** the mute toggle whenever the latest restriction is Pending, and
      says why unmuting alone is not the same thing.
      Verified end to end against a seeded Pending row on 1290051: `status = Overturned`, `resolvedBy`
      and `resolvedAt` set, the message stored, `muted = false`, and a `restriction:overturned`
      ModActivity row. (Seeded row deleted afterwards; the write path also reinstates the subscription
      and emails the account, which is why it was not exercised on a real user's restriction.)
- [x] **Reports: a Status filter, and the 50-row cap** (2026-08-09 — status chips filter server-side and
      the cap is 200 per list; the filter is part of the derived fetch, so changing it refetches).
- [x] `getReportsSubmitted` drops the commonest kind (2026-08-09 — `UserReport` and `ChatReport` are
      both in the submitted query now, so the tile and the rows agree).
- [x] **Report coverage is 6 of 11 entity types** (2026-08-09 — Bounty, BountyEntry, Collection and
      ResourceReview joined the shared `REPORT_SOURCES`; Chat is fetched beside it because it owns by
      `ownerId`, and it was added to the count tiles at the same time so counts and rows still agree).
- [x] **Buzz: Payments and Receipts side by side**, each with its own type filter, plus a Description
      filter and an *After date* picker. Ours is one merged list on a fixed 90-day window with no
      filters. 🎥 buzz is actively used to grant and deduct.
      (The per-transaction **Color** is already rendered — that sub-claim was stale.)
- [x] **A second row of aggregate tables** (2026-08-11 — counterparty × total, per side, top 10 by
      total). The transaction list answers "what happened"; this answers "who with, and how much in
      total", which is the farming question a 200-row list of individual movements actively hides.
      Aggregated over the **same filtered rows** the table above renders, so the totals always agree
      with what is on screen rather than silently summing a different set. Verified in a browser:
      `Paid to, by counterparty (1) | 2,268 | Civitai | across 13 transactions`.
- [x] **The send form is missing `EntityType` / `EntityId`**, which Retool's `buzzSendEntityType` carries.
- [x] **Deduct Types reference table** beside the send form (which types lower lifetime balance, which
      can go negative).
- [x] **Moderation activity omits the Retool era** (2026-08-11 — a `Retool era (N)` list under the
      current one). The panel previously said this history "cannot be queried per-account"; that was
      wrong. `ReToolActions` has no subject column, but the account id is present **inside the free-text
      action** (`BAN: User tipclub5org1 12895025`, `Strike 1 on user 674388`), so matching the id with a
      word boundary recovers it — format-agnostic, because the phrasing varies by app and year and a
      prefix parser misses the older rows. ~80ms seq scan over 131k rows; no index helps a substring
      match, which is why it is its own call and not part of the account bundle.
      Kept as a separate list, not merged: these rows have no entity link and their `User` is a Retool
      **display name** (only 5 of 37 map to an account), so interleaving would imply a continuity the
      data does not have.
      WARNING on how this nearly shipped broken: the pattern was written with a single backslash in a
      template literal, where it is an unrecognised escape that collapses to a bare letter — so it
      searched for `y<id>y`, matched nothing, typechecked, returned 200, and rendered an empty section
      that reads as "this account has no Retool history". Only comparing the endpoint against the same
      query run directly caught it.
- [x] **Model/comment breakdowns** — already built and ticked on evidence (2026-08-11): `getModelFlags`
      returns NSFW / ToS / POI / locked / deleted and `getCommentFlags` returns ToS / hidden, rendered
      beside each count and hidden when zero. Stale entry, no new work.
- [x] **Review text (`details`) is never shown** (2026-08-11). Half of this was already stale — the
      filter-row work rendered it on *Reviews written*. **Reviews received still dropped it**, while its
      own Search filter matched against it, so a moderator could search for text the page would not show.
      Now rendered on both.
- [x] **Review text rendered as raw markup** (2026-08-11 — found while verifying the item above, not
      previously listed). `details` is stored as HTML, and Svelte escapes it, so moderators read literal
      `<p>` tags; the Search filter matched the tags too, making a search for "p" hit every row. A shared
      `plainText` helper now strips tags for both display and search. Deliberately not `{@html}` — this is
      hostile user input, and the safe thing is to stop treating it as markup.
**Four entries below were already built and are ticked on evidence (2026-08-11), not on new work** —
each duplicated an item ticked in §1b, so the open list was over-reporting what is left. Verified in a
browser as user 1290051, not by reading the code.

- [x] **Notification bodies dropped** — `NotificationsPanel` has `notificationBody()`, walking
      `message`/`details`/`content`/`reason`/`body` out of the raw payload. ⚠️ The only one of the four
      **not** confirmed on screen: the notifications service is unreachable from local dev, so the panel
      renders "Notifications service unavailable". Confirmed in code only — worth one look wherever that
      service is reachable.
- [x] **`setRewardsEligibility` has no UI** — the Admin section posts `?/setRewardsEligibility` and
      renders Retool's three buttons (Add Buzz-Block / Remove Buzz-Block / Generator Buzz Earnings).
      Duplicate of the ticked `UpdateBuzzEligible` entry in §1b.
- [x] **Timed-mute presets** — the Timed mute toggle reveals `6h / 12h / 24h / 48h / 72h / 1 week`.
      Duplicate of the ticked `presetMutes` entry in §1b.
- [x] **Bulk Image Manager is a section of User Lookup's sidebar** — `sections.ts` carries it as a
      cross-link (`Bulk Image Manager ↗`), and it renders in the sidebar.
- [x] Balance **and lifetime** for Yellow/Blue/Green (fixed 2026-08-09).
- [x] Moderator name on each activity row; per-transaction buzz colour; the shared-IP / alt-account
      view (`AddressesPanel`) — all already built. Listed so nobody rebuilds them from a screenshot.
- [x] **Confirmed built, from the editor capture — do not rebuild any of these:** Account Notes with
      add/edit (ours is a list plus strikes and flags, ahead of Retool's single textarea), Paddle and
      Stripe customer deep links, Mute/Unmute, Ban (with reason code and internal details — richer than
      Retool's two-button modal), Purge Content, Freshdesk lookup, Refresh Session, Clear Cache,
      Profile link, the alt-account id count, Followers/Following, and Reports Received — where ours
      counts **distinct content items** across all six sources while Retool counted report rows over
      three types.

### Found by the screenshot audit, absent from every earlier list

- [x] 🔒 **Buzz sending was Senior-Mod-gated in Retool** (`tabbedContainer12`'s second pane carries
      `current_user.groups.some(i => i.name === "Senior Mod")`). Ours gates it on the general `/users`
      permission — **a restricted capability silently widened**. Highest priority in this block.
- [x] **The account-edit capability** (closed 2026-08-12). **Full Name** was stale — it is in the
      *Enable Edits* form and in `updateIdentity` since 2026-08-10.
      The **Quick Info checkbox block** is now on Basic: Accepted TOS (`onboarding` — a bitfield, so
      nonzero, not truthy-object), Excluded from leaderboards, Buzz-blocked (`rewardsEligibility =
      Ineligible`, which is exactly what the Add Buzz-Block button writes), FP curator, Shows mature
      content and Blurs mature content. The last two needed selecting at all — `showNsfw`/`blurNsfw`
      reached no query; `browsingLevel` was already a header chip and stays there, since it is the
      ceiling and these two are whether mature content is shown and whether it arrives blurred.
      **Read-only, deliberately**: the gap was *seeing* these, and editing an account's own TOS
      acceptance or viewing preferences is a different capability from correcting a mistyped username.
      (The mechanism that would guard such edits now exists — see §12i — and correcting a username sits
      behind `identity.edit`. Making these fields editable is still a separate decision.)
      Verified on 1290051: `☑ Accepted TOS  ☐ Excluded from leaderboards  ☐ Buzz-blocked  ☐ FP curator
      ☑ Shows mature content  ☐ Blurs mature content`.
- [x] **Admin actions**: Make/Remove Moderator, Add/Remove **Buzz-Block**, Generator Buzz Earnings
      (2026-08-09 — all three on the Admin section; see 1a).
- [x] **Notifications: Link field** (2026-08-12 — see the `notificationLink` entry above; the send form
      posts `url` and it is validated to relative paths and civitai URLs). The **Delete** half of this
      entry is the same item as the BLOCKED one above — it needs an endpoint on `apps/notifications`
      before anything here can call it, and is tracked there rather than duplicated.
- [x] **Browsing level shown** (2026-08-11 — a `Viewing: <label>` header chip off `User.browsingLevel`,
      labelled with the shared `getBrowsingLevelLabel` so it matches the rest of the site).
- [ ] **Comment Spammer alert** in Quick Info — **parked 2026-08-12: nobody is sure what it should
      measure.** Nothing computes this signal today, and Retool's own definition is not in the export, so
      building one would be inventing a moderation heuristic rather than porting it. Needs a rule from
      the mod team (rate? duplicate text? ratio to other activity?) before it means anything.
- [ ] **Timed mutes: Mute Start / Notify User** — **parked 2026-08-12**: `TimedMutes` is **0 rows in
      both databases**, so the feature was most likely never used. The underlying expiry bug is fixed
      regardless (see the 🔴 item above) — this is only about the two extra controls, which are not worth
      building onto a table nobody writes until someone confirms the feature is wanted.
- [x] **Banned for CSAM** (2026-08-11). The ban badge now carries its reason code, and a separate
      **CSAM ban** chip appears for the `SexualMinor*` codes — a Nudify ban and a SexualMinor ban are
      not the same next conversation, and the reason was a section away under Admin. Verified against
      both a `SexualMinor` account (both chips) and a `SexualPOI` one (reason only, no CSAM chip).
- [x] **Copy Retool URL / Profile pair** (2026-08-11). "Copy Retool URL" has no meaning in the app that
      replaces Retool, so the useful half is ported: Copy profile URL, and Copy lookup URL — `?q=` is the
      whole address of a lookup, which is what gets pasted into a ticket or a thread. Verified: clicking
      it puts `…/retool/user-lookup/basic?q=1290051` on the clipboard.
- [x] **UserReport by \<mod\>** (2026-08-12). Rendered into the existing open-report banner rather than
      as a separate chip: an open report filed by a **moderator** means a colleague is already working
      the account — the anti-overlap case the ticket asks for (§1.1) — and a bare count cannot say so.
      Verified in a browser: `5 open reports against this account. Filed by moderator civitai — someone
      is already on this.`

## 2. Bulk Image Manager

- [x] 🔴 **`TosReasons` — the removal reason picker, and its user-facing messages.** Found 2026-08-10
      by re-extracting the raw export; it appears in **no** committed inventory because it is typed
      `Function`, which the skill said to bucket as plumbing. `tosReasonsRadio` is a radio group over
      eleven reasons, each carrying **the message the user is sent** and, for three of them, the flag
      to set:

      | Label | Message sent to the user | Sets |
      | --- | --- | --- |
      | Depicting Real People | Depicting real people is not allowed. | `poi` |
      | Minor displayed in mature context | Minors displayed in mature context is not allowed. | `minor` |
      | NSFW potential minor in a school environment | NSFW potential minors in a school environment is not allowed | |
      | Realistic minor | Realistic images of minors is not allowed. | |
      | Bestiality | Bestiality is not allowed. | `tag` |
      | Rape/Forced Sex | Depicting rape and domestic abuse is not allowed. | |
      | Scat/Fecal matter | Fecal matter, gaseous emission, object or lifeform being ejected from an anus is not allowed | |
      | Graphic Violence/Gore | Graphic Violence and/or gore is not allowed | |
      | Non AI content | CivitAI is for posting AI-generated images or videos, go here to start generating some https://civitai.com/generate | |
      | Likeness/DMCA | Person depicted has requested to have images taken down | |
      | Other | free text from the box beside it | |

      Shipped in `ImageActionBar`, so both this page and User Reports get it: all eleven chips fill the
      reason box with the message the user is sent, pre-select the `violationType` the removal is filed
      under, and carry the `poi`/`minor` flag as `alsoFlag` — applied only **after** the removal lands,
      so a failed removal cannot flag anything. `tag` is offered by the list but is not an image flag,
      and the action says so rather than dropping it silently. Verified in a browser 2026-08-12.
- [x] 🎥 **Strike the user as part of the TOS action** (2026-08-12). *"TOS, affect the reason, also
      strike the user."* Retool's `strikeCheckbox` is now on the remove form in the shared
      `ImageActionBar`, so it is on **both** pages. Owners are resolved **server-side** from the image
      ids (`strikeBatchOwners`), not from the grid: a selection outlives the page in front of the
      moderator, and on Bulk Image Manager it can span accounts — every distinct owner is struck once.
      The strike is the main app's (`issueStrike` → `retool/strike`), and its description is the canned
      message, which is what makes one gesture out of two: the same wording the removal was filed under
      is what the account is told.
      Two failure modes closed deliberately: a ticked box with an empty reason **blocks the submit**
      rather than disabling the checkbox — a disabled checkbox does not post, so emptying the reason
      would have removed the images and dropped the strike silently — and the server refuses the same
      case *before* removing, since afterwards the images are gone and the other half cannot be retried.
      Verified end to end on 1290051 from both pages: `Removed 1 images … Struck 1 owner.`, a real
      `UserStrike` row carrying the canned text with `reason = ManualModAction`, and at three active
      points the strike system's own escalation muted the account — the whole point of not writing the
      legacy table. Test strikes voided and the mute cleared afterwards.
- [x] 🔴 **User Reports issued strikes into the dead legacy table** (found and fixed 2026-08-12 while
      wiring the checkbox above). §1b records this being fixed for User Lookup; the same defect was
      still live on the other page, so its Strike button wrote the moderator database's Retool-era
      `UserStrikes` — no escalation, no points, no expiry, no typed notification, no void path. It now
      calls `issueStrike` like User Lookup does, and the writer function is **deleted** rather than left
      exported with no callers, so a third page cannot reach for it again.
      The panel's strike LIST had the mirror-image bug: it read that same legacy table, so it showed
      **`Strikes (0)` on an account carrying ten live ones** — the worst possible number to be wrong
      about on the screen where the next strike is issued. It now lists the main app's rows with points,
      expiry, and voided/expired badged distinctly from active, with the legacy count kept as a
      one-line footnote.
- [x] 🔴 **`violationType` / `violationDetails` are never sent on removal.** `/api/mod/remove-images`
      accepts a `violationType` **enum** plus a details string and forwards both to the ClickHouse
      `DeleteTOS` event; the port sends only free-text `reason`. **Every removal from this page is
      logged with an empty violation classification** — silent and permanent. The endpoint's own zod
      schema is the authoritative list, so this needs **no re-extract**; the BIM audit's "re-extract
      before trusting the action set" was the wrong conclusion for this item.
- [x] 🎥 **Filter by rating** (2026-08-12). The "never displayed" half was **stale**: the rating badge is
      rendered by the shared `ImageQueueGrid`, so it is on every card on both image pages. The filter is
      now there too — a `ListFilterBar` over the loaded batch with PG / PG-13 / R / X / XXX / Blocked /
      **Unrated**. Unrated is its own entry because `nsfwLevel = 0` means no scanner has judged the image,
      which is a different question from every rating and the one a ticked-everything filter would hide.
- [x] **A toggle to hide or isolate removed images** (2026-08-12 — "Only ToS'd" / "Hide removed" in the
      same bar, so it composes with the rating and prompt filters instead of being a mode).
      Filtering client-side, as Retool did: the batch is one query already paid for, and re-fetching per
      filter change would discard the selection being assembled. Two consequences handled: `Select all`
      counts the **filtered** set, which is the point of filtering to ToS'd before acting; and the action
      bar now says "**N not shown by the current filter**" when the selection includes images the filter
      hides — the removal posts ids, not what is on screen, so without it filtering after selecting is a
      way to remove 40 images while looking at 12.
- [x] **Bulk selection helpers** — Select All / Select 100 / Unselect All (2026-08-09, in the shared
      `ImageActionBar` that Bulk Image Manager and User Reports both use).
- [x] `negativePrompt` is selected and rendered nowhere (2026-08-12 — on the card under the prompt, and
      the bar's prompt search matches it as well as the positive: a prohibited term sitting in the
      negative is the same finding, and Retool's search matched both).
- [x] **Image-only account nuke** (2026-08-12 — `remove-images` with `userId` and no id list, on the
      user-shaped sources only). It exists precisely because it is *not* the selection: the page caps at
      200 images, so on a prolific account "select all" and this are different sizes.
      Armed behind **typing the account's username**, and the expected name is resolved **server-side**
      from the id being acted on rather than compared against what the page rendered — this is the one
      action here whose blast radius is not visible on screen. Distinct from Purge Content in User
      Lookup, which also takes models, posts and articles; the copy says so.
      Verified on 1290051: a wrong confirmation refused with "nothing was removed", the real one blocked
      all 5 and wrote one `removeAllImages` ModActivity row against the account. Restored afterwards.
- [x] Remove/restore counts are rows **found**, not rows **changed** (2026-08-12). The endpoint reports
      what it matched, so re-removing a blocked batch came back with a full count. The already-blocked
      share is now counted **before** the write and subtracted, on both pages: `Removed 0 images — 5 of
      the 5 submitted were already blocked`, with an amber "Nothing changed" beside it. Fixed on this
      side rather than in `/api/mod/remove-images` because that is a cross-app change, and subtracting
      here is exact for the same submitted ids.

## 3. User Reports

🎥 *"press the report and then their images load below… previous removals, previous reports… everything
in the same screen instead of having to click around a bunch."*

- [x] 🔴 **`tosReasonsRadio` + `strikeCheckbox`** — both arrived with the shared `ImageActionBar`, which
      is what fixing it there was for. See §2; verified on this page too (`Removed 1 of 1. Struck 1
      owner.`).
- [x] Queue and account side by side (2026-08-09 — was stacked). **The screenshot settles what Retool
      did**: history tabs top-left, queue table top-right, image grid full-width below. So ours is a
      deliberate improvement, not parity. Caveat: the split is `xl:` only, so it still stacks below
      1280px — the exact failure it was meant to fix.
- [x] 🔴 **The image grid's entire filter bar** (2026-08-09). All of Retool's controls are there — Only
      ToS'd, No prompt, rating checkboxes incl. Blocked, From/To, Search prompt, Search negative
      prompt, Clear — filtering **server-side** off the URL, with a match count beside the heading.
      Retool filtered client-side over one fetched batch; this filters the whole account.
- [x] **No image action path at all** (2026-08-09 — multiselect plus remove / restore / POI / minor via
      the shared `ImageActionBar`, with Select all and Select 100. Owner notification is deliberately
      not duplicated: the panel's own Notify already targets this account).
- [x] **`blockedFor` is never shown and blocked images are excluded** (2026-08-09 — blocked images are
      now in the grid, badged `blocked: <reason>`). Still open: **no restore path** from this page,
      tracked under "No image action path at all" below.
- [x] **A "Remaining" column per queue row** (2026-08-09 — every row reads "N of M images left", one
      grouped count over the 50 suspects on the page).
- [x] **`?user=` and `?page=` clobber each other.** Clicking a report on page 3 returns you to page 1;
      paging closes the open drill-down. Small code, hit within a minute of working page 2.
- [x] Report history capped at 100 where Retool used 300; no *Profile* deep link beside User Lookup.
- [x] **Prompt/negativePrompt dropped** from the cards (2026-08-09 — prompt renders on the card, clamped
      to 3 lines with the full text on hover; `negativePrompt` is selected, awaiting the search filters
      above that are the only thing that reads it).
- [x] 60-image cap **with no paging wired** (2026-08-09 — cursor paging wired; the whole account is
      reachable 60 at a time, and the filters narrow it server-side rather than the batch).
- [x] The suspect's history — Retool's three-tab panel **ModActivity / Reports / UserReport History**
      (2026-08-12). Notes were already here; **moderation activity** and **reports received** are now
      beside them, each with actor, reason and date, capped at 20 with the full history in User Lookup.
      Both are server-side in this page's own `load` rather than the client-fetched endpoints User
      Lookup uses: those guard on `/retool/user-lookup`, so a moderator with the reports permission and
      not that one would have got an empty panel instead of a history.
      **Reports received is filtered to human-filed reasons.** `Automated` is ~99.9% of that table —
      one dev account carries **556** of them against **2** human — so the unfiltered list of 20 that
      shipped first was 20 Clavata rows and answered nothing. Filtered, the same account reads
      `Actioned · Child abuse and exploitation · by dcdcdcdcdcdcdc · actioned by CHESHIRE_OS`, which is
      the anti-overlap signal the tab exists for. `getReportsOnUser` grew a `reasons` option to do it.
      ⚠️ Noted while there: the User Lookup Reports **section** applies no reason filter, so it shows
      the same automated flood. Left alone — it has its own status filter UI and a different job — but
      it is the next place this bites.
- [ ] 🎥 **Post reports** — *"Same for post reports."* **Unverifiable from what we hold**: the User
      Reports export has no post-report queue, and there is no separate post-reports export. A generic
      post-report *queue* is shipped at `/reports/post` with filters and actions; the drill-down half
      (the post's images inline, actions on them) certainly is not. **Needs the post-reports export or a
      screenshot of that tab.**

## 4. Image Lookup

- [x] 🎥 **Expose all the columns.** *"you can expose all the columns. Maybe you want to look into the
      hashes or the meta… ingestion, all this stuff."* Retool used `SELECT *`; ours drops `meta` (the
      **prompt**), `hideMeta`, `analysis`, `scanJobs`, `hash`, `pHash`.
- [x] 🔴 **It could WRITE, and our code says otherwise.** A screenshot shows **Toggle Minor ON** and
      **Toggle Poi ON** beside the image data. The export has no mutation query, so it is stale against
      that screen — and `+page.server.ts` asserted "Read-only. Every action … lived in other apps",
      which would have stopped anyone noticing. Comment corrected 2026-08-09; the two actions are still
      unported.
- [x] Report `details` fetched and never rendered (Retool's reports table has an explicit **Details**
      column).
- [x] `hasImageEvents` is an unguarded ClickHouse call in `load`, so ClickHouse being down turns "no
      image matches" into an error page.
- [x] `ImageReaction.updatedAt` and the image row's `updatedAt` are dropped (2026-08-12). The image's
      `Updated` sits beside `Uploaded` and `Scanned` — on a row whose moderation history is a separate
      panel, an `Updated` far from `Uploaded` is the tell that something touched it. A reaction's shows
      **only when it differs from `createdAt`**: that means the reaction was changed rather than first
      given, and printing an identical second timestamp on every other row would bury the one that is
      not identical. (No dev row has a differing pair, so that branch is unexercised.)

## 5. Chat Audit

- [x] **The reports tab Status filter** — **already built; this entry was stale** (verified 2026-08-12).
      `rstatus` is in the query schema, the service call reads it, and `ReportsPanel` renders a chip per
      status with a Clear.
      The `select2` half was **misread**: it is not a second report filter. Its `change` event calls
      `setFilter` on **`chatTable`** (`columnId: username`), so it filters the open transcript to one
      participant's messages — which is the "From" control `TranscriptPanel` already ships, beside the
      content search. Both halves are present; nothing to build.
- [x] Content search reachable for spam terms; "Open reports" actually filtered (both fixed 2026-08-09).
- [x] The reporter's `details->>'comment'` is fetched and never rendered — for a chat report that
      comment is the entire substance.
- [x] `TopChatters` capped at 25 where Retool showed 50 (surfaced, so not silent).
- [ ] **A sixth tab, "Send Mod Chat"** — a moderator-initiated DM from this screen. **The re-extract is
      done and it does not help** (checked 2026-08-12): `tabbedContainer1` carries **six** slots whose
      labels are `["Chats","Chat Reports","Stats","Newest","",""]` — the two extra slots are real but
      **unlabelled, with no queries bound to them**, and the export holds no `sendChat`/`SendMessage`
      query of any name. So the export can confirm two tabs existed and can say nothing about what they
      did. Sizing this needs the screenshot or a decision, not another extract.
- [x] **"SPAM Detector" is already built** — it is `SpamGroupsPanel` on the stats tab. Recorded so
      nobody builds it from the screenshot.
- [ ] Retool also had **Ban Reason + "Ban and Set Note"** here. Deliberately delegated to User Lookup —
      listed so the decision reads as considered rather than missed.

## 6. Article Lookup

- [x] `unlisted` is selected and rendered nowhere — an unlisted article looks identical to a public one.
      Retool's data table shows an **Unlisted** column.
- [x] `Article.metadata` (2026-08-12). The raw dump was already there; **the open half was the question
      of what is in it, and the answer is: plenty.** Across the 3,392 articles carrying any metadata on
      the dev clone, the keys include `profanityMatches` (2,207), `profanityEvaluation` (1,884),
      `unpublishedBy`/`unpublishedAt` (863), `unpublishedReason` (224) and `customMessage` (223) — who
      unpublished an article, why, and what the author was told.
      So the moderation subset is now lifted out into its own block above the raw JSON, because none of
      it was being read inside a dump: profanity shows the evaluation's own `reason` sentence with the
      match count and first terms, and the metrics stay below. The rest of `metadata` is challenge
      bookkeeping (modelId, prizes, winners) and stays raw. Verified on article 27215.
- [x] `coverId` is declared on `ArticleRow`, never selected — **stale, it is selected** and rendered
      beside the three NSFW levels, which is where it belongs since the cover is usually why the
      effective level is what it is. The `as unknown as ArticleRow` cast remains and is worth removing
      on its own merits: it is what let this go unnoticed.
- [x] **No hidden tab.** The audit doc guessed the container tabs were "Article / Metrics"; the
      screenshot shows a single **Article Info** tab with Data and Stats stacked below. Re-extract
      request closed.

## 7. Front Page Audit

- [ ] **Confirm this is still wanted before finishing it.** 🎥 *"We are reviewing all PG videos. I'm not
      sure if we need to do this anymore… she only does a few a day."* **Split the three unported
      pieces rather than deciding them together:**
      - `FrontPageTimers` (shared resume point) is **arguably moot at that volume** — its whole value is
        stopping two moderators re-checking the same images. The URL sharing already there may suffice.
      - `RatingChanges` is an audit log, **independent
        of volume**, so decide them on their own merits.
- [ ] **The tag chips are a fixed votable vocabulary, not the image's tags.** Every card in the
      screenshot carries the same 11 moderation tags regardless of content, so a moderator could **add**
      a missing tag. Ours renders only tags already assigned, so it can correct one but never add one.
- [ ] Display toggles (*Show Tags*, *Show Ratings*, *Vertical Style*), a Refresh, and the
      "*\<mod\> used the button N hours ago*" readout.
- [ ] 🎥 **Defaults face the wrong way**: the live use is PG **videos**; ours defaults to PG-13 images.
- [x] The rating vocabulary (PG / PG-13 / R / X / XXX) is **confirmed correct** by screenshot — the
      re-extract request for it is closed and the warning comment removed.

## 8. Moderation Status → `/retool/image-help`

- [ ] 🔴 **`/retool/image-help` ships a queue that cannot fill.** `ModerationImageHelp` appears in the
      app only as two reads and one update — **nothing writes a row.** The three producers
      (`GetMinors`/`GetPoI`/`GetReported` → `Store*`) are cron-shaped and scheduled nowhere. The page
      gates, renders and resolves over a table that will stay empty. Either schedule the producers or
      say the page is inert.
- [x] `GetSplitQueue` — **closed, not a queue.** It is
      `SELECT "lastCheckedAt" FROM "FrontPageTimers" WHERE username = 'splitQueue'`, consumed by
      `ImageSfwDataCatchup` as a time bound. Group-E backfill plumbing; there was never a page.
- [x] `ReviewGrouped` — **it is the dashboard, and the dashboard already runs it** (verified
      2026-08-12). `getImageReviewCounts` is exactly `COUNT(*) GROUP BY needsReview` (excluding
      `appeal`, which has its own queue and count), and the pending-report half is the distinct-image
      count beside it in `sidebar-counts.service.ts`. Both feed the Images block's per-queue counts and
      their threshold colours. Nothing to port.
- [x] **`image-help` gates on `/images`**, a group node whose grant is the union of its children — the
      same hazard Front Page Audit documents as its reason for gating on its own path. A moderator
      granted only `/images/to-ingest` gets action rights here.

## 8b. Dashboard — absent from every list until now

Retool's board is the triage entry point, and the walkthrough's colour quote lands here.

- [x] 🎥 **Per-queue severity colour with per-queue thresholds** — **already built; entry was stale**
      (verified 2026-08-12). `$lib/queue-thresholds.ts` carries Retool's own `thresholds`/`colors`
      recovered from the raw export, per queue and descending, and the dashboard colours every count
      through `queueSeverityClass`. A queue with no standard renders plainly rather than borrowing
      another's scale.
- [x] **Who last worked each queue, and how long ago** — **already built** (verified 2026-08-12):
      *Recently worked* (oldest first, so the untouched queue is the visible one) and *Queue sweeps*
      off `Mods_TaskTimers`, including the front-page per-level rows.
- [x] **An "Urgent Content (N)" banner** (2026-08-12). The data was already there — *Most reported* is
      pending reports from the last week with more than one reporter — but it sits below three screens
      of queue counts, and a pile-up on one item is a live incident rather than a long queue. A red
      banner now states it at the top and jumps to the table. The bar is `URGENT_REPORT_COUNT = 5`,
      kept in `queue-thresholds.ts` with the other operating standards so the number is changed in one
      deliberate place.
      Verified both ways on dev: with the real bar nothing renders (the busiest item has 2 reports), and
      with the bar temporarily at 2 the banner reads `Urgent content (1) — one item has 2+ open reports
      in the last week, worst at 2.` Threshold restored to 5.
- [x] **Per-entity report breakdown across all 11 types** — **stale, and it is now more than 11**
      (verified 2026-08-12). The Reports nav is built from `Object.values(ReportEntity)`, so every
      entity type gets its own queue entry, count key and threshold colour — 14 of them, including the
      comic-project and 3D-model types that postdate the list above.
- [~] **A Front Page block and Special Queues.** Mostly present: the front-page per-level rows appear
      in *Queue sweeps* with who claimed each and when (`Front page PG`, `Front page PG-13`, …), and
      Blocked Images, Civitai Models and Appeals are all queues on the board.
      **Still missing, and each needs a decision rather than code:** the *Split* control (Retool's
      `splitQueue` timer — §8 established it is a time bound, not a queue, so what "split" should mean
      here is a question for the mod team), and a **Training Data** queue, which exists nowhere in this
      app's navigation and has no source query in any export.

## 9. Workflows (cron)

- [x] 🎥 **Only one is live: the DALEN challenge runs.** *"I think the only ones that currently are being
      used is the DALEN challenge runs; we would need to move these into Civitai somewhere."*
      Resolved 2026-08-11 — decision and evidence in
      [`retool-workflows-decision.md`](retool-workflows-decision.md). Both exports are **alerting
      wrappers around the challenge jobs, not the runs themselves**, and both are inert: no crontab,
      `isEnabled: false`, webhook-only trigger, and the Discord block orphaned in the graph. The
      underlying work is already ours (`daily-challenge-setup`, `challenge-auto-queue`,
      `challenge-activation`). What was genuinely missing is the **alert**: `createJob` catches thrown
      failures, but the pipeline fails by silent no-op and nothing watched for that. Reimplemented as
      `src/server/jobs/challenge-health-check.ts` (`0 */6 * * *`) → Axiom + `DISCORD_WEBHOOK_MOD_ALERTS`.
      No PagerDuty; the repo has no integration for it.
      **Open**: the 24h "not started" window is Retool's number and nobody has confirmed the intended
      challenge cadence, so it may alert on a deliberate pause.

## 10. Cross-cutting

- [x] **Report `details` — the reporter's own words** (2026-08-12). Audited all five renderers rather
      than assuming: User Lookup, User Reports, Chat Audit and Image Lookup all already rendered
      `details->>'comment'` inline. **The generic `/reports/<type>` queue was the one that did not** —
      its table had no Details column at all, and the words were reachable only by opening the sheet and
      reading them out of a raw JSON dump. Retool had that column, and it is what decides whether a row
      is worth opening. Now a clamped Details cell on every row (full text on hover) and the comment as
      prose above the dump in the sheet. Verified on `/reports/user`.
- [x] `getReports` applies status/reason filters only when passed — **stale, already fixed**:
      `statuses` and `reasons` are required parameters and `'all'` has to be said out loud. Verified
      2026-08-12.

## 11. Operational

- [ ] `FRESHDESK_API_KEY` — see the handover. (`CIVITAI_MOD_API_KEY` is retired, 2026-08-19.)
      **`RETOOL_DATABASE_URL` is superseded**: the cutover retires it in favour of
      `MODERATOR_DATABASE_URL`, which already points at the same database the xguard lab uses. Set that
      one in every deployed environment instead — see [`retool-db-cutover.md`](retool-db-cutover.md).
- [ ] Three SQL migrations, applied by hand.
- [ ] **The database cutover itself** — four scripts in `apps/moderator/moderator-db/cutover/`, run in
      order, with Retool writes frozen from the export until the app is repointed. `04-verify.sql` is the
      gate; a non-zero exit means stop.
- [ ] **Grant the new pages on `/admin`.** A new page has no `AppPageAccess` rows, so only
      `moderator:admin` can see it until someone ticks the boxes — it is invisible rather than broken,
      which is the hard failure to notice. `/models/minor-hash-matches` (2026-08-13) is the newest and
      is **not yet granted to anyone**.
- [x] **Re-extract every export while access remains** — done 2026-08-10; all nine carry option sets
      and layout geometry, and sanitized copies are committed under `retool-exports/raw/`.
- [x] 🔒 **Support-tool credential** — never committed (verified 2026-08-10). Ticket-body hygiene is an
      owner's call; specifics belong in the private infra repo.
- [ ] **Browser verification is partial.** The moderation team is exercising pages as they go and
      feeding findings back per session, rather than this being one gated pass. Treat a slice as
      unverified until someone says otherwise, but do not block porting on it.

## 12. Moderation-team feedback round — 2026-08-12 → 08-13

Three moderators worked the port and filed everything below in the migration thread
(`1534637921829912777`, every message after `1537244774636068885`). Message ids are kept so any line
can be traced back to who said it and what they were looking at; the doc's convention of not naming
individuals in a public repo is kept.

Items already covered by an earlier entry are cross-referenced rather than restated. Asks that Retool
never did are marked → **backlog** and recorded in
[`post-migration-backlog.md`](post-migration-backlog.md); they stay listed here only so the round
reads as one round.

**Every item below was cross-checked against the commits and the code on 2026-08-13**, because two
releases landed inside the round and "filed after a release" is not the same as "still broken". The
timeline that decides it:

| When | What |
| --- | --- |
| 08-12 13:20 | `ccca4572a9` **v0.0.19** |
| 08-12 19:33–19:49 | automated-report filter, `.red` links, chat-report link, membership, error logging, side-effect guard |
| 08-12 19:54 | `b06d6f76fc` **v0.0.20** |
| 08-13 10:43 | `e40e93106e` — the image/strike/user-lookup parity batch |
| 08-13 10:48 / 11:13 | `7a00889e54` **v0.0.21**, `33fc37c60f` **v0.0.22** |

Only the comics-review report predates v0.0.20. Everything else was filed against a shipped build —
the *"Yay no more silly numbers"* in `1537284688509407322` is the v0.0.20 report filter, which pins
that reporter to that build.

### 12a. Reports — links and drill-down

- [x] 🔴 **Comment reports link to nothing.** (`1537284688509407322`, fixed 2026-08-13). Model
      comments, and article and image comments, all render the report row with no path to the comment;
      the display is also "funky" (screenshot on the message).
      `$lib/entity-url`'s `ENTITY_PATH` has no comment entry, and its own comment asserts that types
      with no standalone page *"correctly return null."* That is true of a bare `/comments/<id>` route
      and false of the product — the main app opens a comment **through its parent**, which is what
      `civitai.red/moderator/reports` does today and what the mods were comparing against.
      Resolved in SQL in `getReports` as a new `contextUrl` column, because the parent is a join away
      and the queue already pays for one. Legacy model comments become
      `/models/<id>?dialog=commentThread&commentId=<root>&highlight=<id>` — the reply case opens the
      thread and marks the reply, exactly as the main app's own notification links do. `commentV2`
      resolves its `Thread`'s parent across all nine entity columns.
      Two shapes the naive version would have missed, both found by measuring rather than assuming:
      a **reply**'s thread hangs off the comment above it and carries no entity at all, so resolution
      falls back to `rootThreadId` (6,429 of 6,785 reported replies); and a `bountyEntryId` thread
      never carries the `bountyId` the URL needs — **248 of 248** — hence the join to `BountyEntry`.
      Coverage on the dev clone: **15,892 of 15,892** legacy comments, **33,786 of 37,384** commentV2.
      The remainder is not a mapping gap — 3,519 are orphan `Thread` rows with no parent column of any
      kind (one carries 110 comments), and they render unlinked as before.
      Verified in a browser on both queues: `/articles/33568?highlight=2278242` and
      `/models/2741166?dialog=commentThread&commentId=1280855&highlight=1282861`.
- [x] **Chat report links.** (same message) **Already fixed, and the fix is sound** — `b2b330bdc8`
      shipped in v0.0.20, *before* this message. `getReportItemUrl` special-cases chat to
      `/retool/chat-audit/chats?chat=<id>`; that route exists and its `querySchema` parses `chat`, and
      `reports.service.ts` reads the chat report's entity id from `ChatReport.chatId`, so the id being
      linked is the one the transcript page wants. That commit is itself credited *"Reported by Daz"*
      for the earlier round, so this is most likely the same report restated before the deploy landed.
      **Ask them to re-check rather than reopening it.**
- [x] 🔴 **The report details sheet stays open, empty, after any status change.** (fixed 2026-08-13)
      (`1537298688060428350`) **Confirmed open, and it is broader than reported.**
      `reports/[slug]/+page.svelte` holds `detailsOpen` and `selected` as independent state:
      `detailsOpen` is a `$state` boolean, `selected` is `$derived(data.items.find(r => r.id ===
      selectedId))`. The `?/setStatus` form uses the default `use:enhance`, so a successful write
      invalidates and `data.items` reloads under the queue's status filter — which defaults to
      `DEFAULT_REPORT_STATUSES = [Pending, Processing]`. Setting a report to **Unactioned or
      Actioned** drops it out of that list, `selected` goes null, the `{#if selected}` body renders
      nothing, and `detailsOpen` is still `true`. Result: an empty sheet holding the backdrop over the
      page. It was reported on Unaction; Action does it too.
      Fixed by deleting the second state rather than syncing it: the sheet is now
      `open={!!selected}`, so it is a pure function of whether there is a report to show and the two
      cannot diverge again. Verified in a browser — Unaction on a Pending report closes the sheet,
      leaves 0 dialog nodes in the DOM and the page interactive.
- [x] 🔴 **Comics review → Block → 500.** (`1537245043146883082`, confirmed fixed 2026-08-13.) Filed
      19:42, twelve minutes before v0.0.20, which carries `2002b4bfc7`: `blockImage` ran five side
      effects in a `Promise.all` and three could reject *after* the row was already updated, so the
      moderator got a 500 for work that had succeeded.
      That commit deliberately refused the credit — the comics queue looked empty on the dev clone, so
      the page could not be exercised outside prod, and it shipped as a class fix with
      `9b71561707`'s `handleError` hook to name the failing step next time. **The mod team has since
      confirmed the queue is populated and blocking works**, so the fix is verified and the caveat in
      that commit message is stale.
      The second half of that message is a separate question worth answering: **why do a banned user's
      comics appear in the review queue at all.**

### 12b. Report-queue counts and automated reports — closed, kept for the record

- [x] Inflated queue badges, `.com` links, and every page showing `civitai` as the sole reporter
      (`1537224379002261574`, `1537227376008896552`) — `9d2d67c20d` (automated reports out of the human
      queues) and `60971a4663` (stop content links falling back to `.com`), both in **v0.0.20**. The
      mods' own numbers match the fix's: reviews *"220, all `civitai`"* against 0 human. Acknowledged in
      thread (*"Yay no more silly numbers"*), which is also what dates the rest of that message to a
      v0.0.20 build.

### 12c. Dashboard

- [x] **Move *Most reported* to the top of the page.** (`1537513088067043459`, 2026-08-13.) It sat
      below the whole queue board; §8b's *Urgent content* banner was the same instinct, but the ask was
      for the table itself rather than a jump link to it. Verified in a browser: `Dashboard` (48px) →
      `Most reported` (136px) → the board (1087px).
- [x] 🔴 **Show the reporter count per row** — **it was already built, and wrong by one** (fixed
      2026-08-13). The table's first column *is* the count. But `fetchMostReported` derived it as
      `array_length(t."alsoReportedBy", 1)`, and `alsoReportedBy` **excludes the original reporter** —
      the main app's own arithmetic is `report.alsoReportedBy.length + 1`
      (`src/server/services/report.service.ts:487`, and `[report.userId, ...report.alsoReportedBy]` at
      :500). So an item three people reported reads **2**. Two consequences beyond the column:
      - the query filters `where(reportCount, '>', 1)`, so the table **hides every item with exactly
        two reporters** while its own copy promises *"more than one reporter"*;
      - `URGENT_REPORT_COUNT = 5` is applied to the same undercount, so §8b's urgent banner fires at
        **six** real reporters, not five.
      This is very likely why the count was asked for — it was on screen and did not match what a
      moderator counts by hand. One expression fixes all three:
      `coalesce(array_length(...), 1) + 1`, with the coalesce load-bearing because `array_length` is
      NULL on an empty array rather than 0.
      **Measured on the dev clone, the hidden half was the bigger defect**: the old predicate returned
      **1** row where the corrected one returns **10+**, every one of them a genuine two-reporter
      pile-up that the board had never shown. Verified in a browser: the table now renders 10 rows
      reading 3, 2, 2, 2 … where it previously rendered one.
- [ ] **Put *Recently worked* and *Queue sweeps* next to the queues they describe**, rather than in
      their own blocks. Filed with *"might need a new table to track all of these queues, or
      expand/revise `ModActivity`"* — **answer: no new table.** `Mods_TaskTimers` already carries the
      per-task timestamps and `getSweepAt`/`getSweepCounts` already read them; see §12d.

### 12d. Queues that are missing (`1537513655711825931`, `1537514064580714507`)

- [x] **Unpublished models the user asked to have reviewed** (2026-08-13 — on the dashboard beside the
      sweeps, linking out to `civitai.red/moderator/models`). The page that works them already exists and
      works; what was missing is the count that says to go there, so this is a signal rather than a
      second copy of a page. Verified: **61**, matching the query exactly.
      ⚠️ **It is deliberately NOT in `sidebar-counts.service.ts`**, which every navigation waits on.
      There is no index for the predicate — `Model_status_nsfw_idx` gets the status and then filters
      **43,222 rows to return 61, measured at 2.7s** — so it is fetched on its own and cached, the same
      reasoning that put `getMostReported` behind its own endpoint. A partial index would fix it, but
      migrations here are hand-applied and that is a decision to take deliberately rather than as a side
      effect of adding a count. Query as filed:

      ```sql
      SELECT COUNT("meta"->>'needsReview') AS needsReview
      FROM "Model"
      WHERE "meta"->>'needsReview' = 'true'
        AND "status" = 'UnpublishedViolation'
      ```

      Nothing in the app runs this. `queue-thresholds.ts` already carries a `modelsReview` scale
      recovered from the export, so Retool had the queue — parity, not an addition. ⚠️ **A partial
      index on `meta ? 'needsReview'` will not help this predicate** — `jsonb_exists` has no btree
      opfamily, so the planner reports `predOK=false`; the query has to repeat the literal clause.

- [x] **Timestamp-swept queues — the "I've checked these" pattern.** Some queues are not a backlog but
      a *last-swept* marker: a mod reads the newest 20 articles, presses a button, and the timestamp
      advances. Asked for on **Articles**, **Bounties**, and **models handed to Civitai on account
      deletion** — *"if there's a better way than timestamps, feel free to change the method."*

      **The mechanism already exists and one of the three is already built.** `SWEEP_TASKS` in
      `moderation-board.service.ts` is exactly this pattern — `getSweepAt` reads the bound from
      `Mods_TaskTimers`, the acknowledge write shipped in `b02c065630`, and a task with no
      acknowledgement yet reports *"never swept"* rather than an unbounded count. `countCivitaiModelsSince`
      is the third query below, byte for byte:

      ```sql
      SELECT COUNT(*) FROM "Article"  WHERE "createdAt" > {{ArticleTimer.data.lastUpdate[0]}}
      SELECT COUNT(*) FROM "Bounty"   WHERE "createdAt" > {{BountyTimer.data.lastUpdate[0]}}
      -- already built as countCivitaiModelsSince():
      SELECT * FROM "Model"
        WHERE "userId" = -1
          AND "updatedAt" > {{CivitModelCheck.data.lastUpdate[0]}}
          AND "status" = 'Published'
      ```

      **Articles and bounties shipped 2026-08-13** — and they were not a design question at all: the
      moderator database already holds **2,028 `articles` and 1,213 `bounties` acknowledgements, the
      most recent written the same day**, so both queues are live and worked daily and the port simply
      never rendered them. Two `SWEEP_TASKS` entries and one count function, bounded on `createdAt`
      because that is the column Retool bounded on.
      ⚠️ **The threshold alias was the trap**: the bare `bounties` scale is the bounty-*report* one
      (2 is critical) that `report:bounty` resolves to, so the sweep needed an explicit `bountyTask`
      alias or a routine day would have rendered permanently red — the same mistake the `articles`
      alias comment already documents. Aliases resolve once, so `report:bounty` is unaffected.
      Verified on the dashboard: four sweep rows, *New articles* and *New bounties* reading 0 against a
      2-hour-old mark, which is correct — the same window holds 89 articles and 12 bounties over 7 days,
      so the bound is being applied rather than the query being dead.
      **Not exercised: the *Mark swept* write.** `Mods_TaskTimers` is the live Retool table, and
      advancing a real watermark would tell a moderator articles had been checked when they had not.
      The write path is `acknowledgeSweep`, unchanged and already used by the two existing tasks.

      The models queue below shipped the same day, so this item is closed.
      `queue-thresholds.ts` already carries Retool's own `articleTask` and `bountyTask` scales, recovered
      from the export — which is independent evidence Retool ran both, so these are parity, not additions.
      Same for `modelTask` and `trainingData`, which are also scales with no queue behind them.
- [x] **The three queues from `civitai.red/moderator/minor-hash-matches`** (2026-08-13). Filed here as
      blocked on a main-app count endpoint; that was the wrong call. The right move was to **port the
      page**, which `docs/moderator-app/page-migration-checklist.md` already has a pattern for
      (procedures → `load`/actions, services → Kysely in `$lib/server`), with `comics-review` as the
      nearest precedent. ⚠️ **The page is absent from that checklist**, which is how it was missed.
      Now at `/models/minor-hash-matches`, under a new **Models** nav group between Images and Articles.
      **Reads ported, writes not — that split is the point.** `revert` runs `setModelMinor`, which owns
      the search-index sync, the cache busting and the per-image propagation, then restores five columns
      from the flag snapshot; `resolveAppeal` also closes the `Appeal` row and refuses to uphold against
      a model someone else has since reverted. So the verdicts go to a new
      `/api/mod/minor-flag/*` (one endpoint per action) and the spoke calls it.
      The three predicates are copied **verbatim** and must stay that way — each population is defined
      by exclusions that look like noise (`minorHashDismissed`, the cleared-stamp window, the
      human-confirmation check, the accepted key, the 30-day bound).
      **Verified row-for-row against the main app's own SQL on the same database**: first five model ids
      identical on all three tabs, appeals total exact (28). Tab counts 416 / 296 / 28, fetched
      separately and cached — the Pending count alone is ~10s, which is also why the nav entry carries
      no `countKey`. Offset paging per tab, with the drain hazard stated on the page.
      Three defects found by loading the page rather than by review: `export const TABS` from
      `+page.server.ts` 500s the whole route; a `use:enhance` callback without `applyAction` renders a
      refused verdict as an applied one; and `versionId?:` in an arrow function makes the Svelte script
      parser read the `?` as a ternary and fail the route at a column that does not exist in the file —
      `svelte-check`, `esbuild` and a direct `svelte.compile` all accept it.

- [ ] **Drop the unpublished-articles queue.** (`1537514064580714507`) *"There's no need for
      unpublished articles to be an item/queue."* `src/routes/articles/unpublished` exists in the port;
      removing it is the ask, so confirm before deleting — this is the one item in the round that
      *removes* surface.

### 12e. Bulk Image Manager (`1537516568815083690`)

- [x] 🔴 **Clicking an image opens its link instead of selecting it.** (fixed 2026-08-13, one function.)
      `ImageQueueGrid.svelte`'s card is an `<a href="{civitaiUrl}/images/{item.id}">` and its handler
      is `onImageClick(e, item) { if (selected && selected.size > 0) { e.preventDefault(); toggle(item) } }`
      — so selection by click only works **once something is already selected**, and the first click of
      every batch navigates away instead. Selection is otherwise only reachable through the per-card
      checkbox at line ~105. The filed ask is explicitly global (*"the default case in all grid
      multi-select pages"*), and since both image pages share this component it is one change, not a
      per-page fix.
      A selectable grid now renders the media as a `<button>` that toggles, and the whole-card `<a>`
      only survives on the read-only grids that pass no `selected` set. Verified on Bulk Image Manager:
      103 select targets, and the first click on an empty selection sets `aria-pressed=true` and
      reads `1 selected` **without navigating or opening a tab** — which is precisely what it used to do.
- [x] **Add a corner arrow/button that opens the Civitai page.** (2026-08-13 — the other half of the
      same change, since the `<a>` wrapped the whole card and freeing the click needed somewhere for
      the navigation to go.) Verified: the arrow opens `civitai.red/images/<id>` in a new tab and does
      **not** toggle the selection.
- [x] **Striking from this page fails with `Struck 0 of 1 owners: CIVITAI_MOD_API_KEY is not
      configured.`** **RESOLVED 2026-08-19** — the key is gone; striking authenticates as the acting
      moderator. Note the failure this replaces it with: `strike/create` is rate-limited per moderator
      at 30/60s, so a bulk strike over more owners than that now reports the hub's own "retry in Ns".

### 12f. User Reports (`1537531797124943882`, `1537532842337378375`)

- [x] **Clicking an image should select it, with a separate arrow to Civitai** — same defect as §12e,
      same shared component, fixed once (2026-08-13). `SuspectPanel` renders `ImageQueueGrid` with a
      `selected` set, so it inherited the fix; verified separately on this page rather than assumed.
- [x] **Clicking anywhere in a report's empty space should select that report**, and **clicking the
      username should go to User Lookup.** (both, 2026-08-13.) **These two are one change, and the
      second could not be done without the first.** In `QueuePanel.svelte` the suspect's username *was*
      the select affordance:
      `suspectHref` returns `?user=<id>` on the same page, which opens the drill-down. So freeing the
      username to link out needs the row itself to become the select target first. The reporter's
      username beside it already linked to User Lookup, which is likely why the difference read as a
      bug. The row now carries a stretched anchor **above** the content with the real controls lifted
      over it, rather than the other way round — that way "empty space" means every pixel no control
      occupies, instead of every pixel no text occupies. Verified in a browser: a row click opens that
      account's drill-down and highlights the row, the username goes to `/retool/user-lookup?q=<id>`,
      and the Action button is still the topmost element at its own position, so the overlay does not
      swallow the controls.
      Worth noting while in this file: the queue labels the same array correctly — `+N also reported`
      — where the dashboard calls it *Reports*. See §12c.
- [ ] **Removing images from any multi-select UI should offer the same options the site does.**
      (`1537532842337378375`, screenshot) Filed against *"any multi select UI"*, so this is about the
      shared removal form, not one page. §2 shipped the eleven `tosReasons` there; check what the site
      offers that the bar does not before scoping.

### 12g. User Lookup (`1537527920938192992`, `1537156052511096902`, `1537543755110944799`)

- [x] **The open-report banner says too much.** (2026-08-13.) *"3 open reports against this account. Filed by
      moderator civitai — someone is already on this."* → wanted: `3 open reports against this
      account.` and nothing else. §1 added the second sentence deliberately, as the anti-overlap signal
      (`1537244824535699477` era); the mods do not want it, and it is their call.
      The sentence is now the count and nothing else. The moderator who filed survives as a `filed by
      <name>` chip beside it — the *editorial* half (*"someone is already on this"*) is what was
      objected to, and deleting the datum as well would re-open the overlap problem §1 was solving.
      Say so if the chip should go too. Verified: `20 open reports against this account.` + chip.
- [x] **Make *spoke with mod* the same red as bans.** (2026-08-13 — `destructive`. It sat in the same
      grey as the browsing level, and the mod team reads it as enforcement history.)
- [x] **The CSAM-report indicator should open the report.** (2026-08-13.) It rendered
      `identity.csamReportCount` as a plain `<Badge>` — no link, no handler — so the one chip a
      moderator most wants to open was the one that did nothing. It now opens a sheet listing each
      `CsamReport` with its type, whether and when it was sent, archived/content-removed state, who
      filed it, the `minorDepiction` and `contents` classification, and a link to the originating
      report. Fetched only on open, since almost every account has none.
      **What it deliberately does not show:** the report's `images`, and `details->'userActivity'` as
      anything but a count. That key is the account's whole session log — one report on the dev clone
      carries **89,550 entries, each with an IP** — so sending it to a browser to render a summary chip
      would have been both a payload and a disclosure nobody asked for.
- [x] **`name` is not displayed, only editable.** (2026-08-13 — now a read-only `Full name` field.)
      **§1b is what misled here** — that entry says *"selected in `getIdentity` and editable behind Enable Edits"*, and both halves are true, but
      `IdentityPanel.svelte` rendered the field **only inside the Enable Edits form**, so a moderator
      who never toggled edits on never saw the account's full name.
- [x] **Subscription details should move out of the Buzz section.** (2026-08-13 — **moved**, not copied.
      A second instance of a panel that can re-link a Paddle customer is two places to fix a bug in.)
      **This was a decision to reverse, not a gap.** `e43a55876b` put membership on Basic User Information and it is there —
      `IdentityPanel.svelte:190` renders the badge, with a comment stating the split deliberately:
      *"the subscription record stays there; this is the one line of it that belongs with identity."*
      The mods want the record itself on basic info. **Their call.**
- [x] **Creator Program status.** (2026-08-13 — a header badge.) It is not a table but two bits on
      `User.onboarding`, which the identity query already selected, so this needed no service change.
      Joining and being **banned** from the programme are separate bits and an account can hold both;
      the ban wins the label, because it is the one that changes what a moderator does next.
      ⚠️ **Found while wiring it:** `Accepted TOS` was `!!identity.onboarding` — a truthiness test on a
      bitfield, so *any* completed onboarding step rendered as "accepted the TOS". Now `& TOS`, with
      `& RedTOS` beside it as its own row. The bits live in `$lib/onboarding.ts` rather than inline.
- [x] **LoRA Training panel should show the training metadata.** (2026-08-13.) The panel rendered a
      summary line only; `trainingDetails.params` was never fetched. **This reverses a deliberate call** —
      the service comment read *"those are for debugging a failed train, not for moderating an account"* —
      so the note is now why they are back rather than why they went.
      Carried as the **whole object** rather than a chosen subset: the key set varies by engine, about 30
      across the corpus, `ecosystem`/`lr`/`epochs` on newer runs against `unetLR`/`maxTrainEpochs` on
      older ones, so a fixed column list would silently drop whatever the next engine adds. Rendered as a
      collapsed grid per run, with `optimizerArgs`-style objects stringified rather than skipped.
      Verified on a real account: `Training parameters (21) · kohya`.
- [x] 🔴 **Timed Mutes shows the entire enforcement surface.** (fixed 2026-08-13.)
      `[section]/+page.svelte` fell through to the same `AccountActionsPanel` for **both** `admin` and
      `mutes`, so the Timed Mutes section *was* the Admin section — ban, purge, force-logout and all.
      Now a `TimedMutesPanel` carrying only the duration presets, the reason and the history, and the
      timed-mute half is gone from Account actions.
      Two things kept deliberately: the **indefinite** Mute toggle stays on Admin, because it is not a
      timed mute and belongs with ban; and Admin still says *"This account has an active timed mute"*
      with a link, because it is the screen a ban or an unmute gets decided on and losing that signal
      would trade one complaint for another. The list also now shows each mute's reason, which the old
      panel selected and dropped.
      Verified end to end on 1290051: applying a 24h mute renders it active with the reason and the
      moderator, Admin shows the cross-link, revoke flips it to ended, and the `User` row comes back to
      `muted=false, muteExpiresAt=null` (and `mutedAt=null` since 2026-08-20; the `manualMute=false`
      originally recorded here no longer exists).
      **This unblocks §12i** — a gate on the `admin` slug now actually gates that surface.
- [x] **Notes and strikes belong on Basic User Information** (2026-08-13 — `ModerationMemoryPanel`
      renders there too; the Notes & Strikes section stays, since it is also where the write forms live).
      Not two scroll-and-tab hops away
      (`1537527920938192992`, restating `1537156052511096902`). The layout complaint behind it: socials
      is now strictly social links since the pfp/banner/bio/location moved to basic info, so it fits in
      the dead space beside location, and the dead space at the top of the page is where the
      notes/strikes/admin affordances should live. Retool put them one or two clicks from the main
      page. → **backlog** was the earlier answer (`1537244824535699477`: parity first, UI pass after) —
      it was asked for twice by two people, so it was re-decided rather than inherited. Verified in a
      browser: Basic renders identity → subscription → notes & strikes → addresses.
- [x] **Buzz: list the account's payouts.** (2026-08-13.) **The open question answers itself: no Tipalti
      connection is needed.** Tipalti is the processor, but every request and its state is a row in
      Postgres.
      Two tables, because there are two eras and they are not the same object — `BuzzWithdrawalRequest`
      (creator programme: buzz converted at a platform fee, sent via a provider) and `CashWithdrawal`
      (cash balance). Merged into one timeline since *"has this account been paid, and did anything
      fail"* is one question, but **tagged and denominated separately**: buzz requests are in buzz and
      cash withdrawals in cents, so a bare number would put `280,000` beside `425.18` as though they
      were comparable.
      Verified on real accounts: `Paid $382.77 PayPal — Payment completed`, `Rejected $425.18 PayPal —
      Payment error: PayPal payment failed: Receiver's account is locked or inactive`, and
      `Rejected 280,000 buzz Tipalti` in the same list.
- [x] **Copy-all-IDs button on *Addresses & linked accounts*** (`1537543755110944799`, 2026-08-13).
      Both halves: a **Check N in Bulk Ban** link that opens that page with the ids already loaded, and
      a copy disclosure for anything else. **The ids need deduping to be any use** — the list is one row
      per (account, address), so an account seen on two addresses appears twice. Verified against a
      stubbed response: 3 rows, `Check 2 in Bulk Ban`, `?ids=111%0A222`.

### 12h. Bulk Ban (`1537543755110944799`)

Filed against the page ported in §0, by the mod who uses it on bot chains.

- [x] **The IP check lists matched accounts with no way to copy their ids.** (2026-08-13.) Both
      *in common* lists now carry **Add N to the list** — which merges into the paste box, dedupes
      against what is already there and re-checks — and a **Copy these IDs** disclosure beside it, so
      the set can also leave for something else.
- [x] **No way to drop one entry from the pasted ban list.** (2026-08-13 — a ✕ per row, held
      client-side, so it costs no re-check; an *N dropped from this run* line with Undo says what
      happened, and the exclusions clear when the checked list itself changes.) Verified: dropping a
      row took the heading from 6 to 5 matched **without the URL changing**, which is the whole point
      — the old way paid for the scan again to remove one row.
- [x] **"Note on all matched accounts" includes already-banned accounts** (2026-08-13 — *Skip accounts
      that are already banned or deleted*, with the button's own count following the toggle so the
      target is never implied). Verified: 6 accounts → 4 with it ticked.
- [x] **The per-account note section is redundant** (2026-08-13 — removed). It wrote the same string to
      every account in the run, which is what `detailsInternal` beside it already does. The endpoint
      takes `note` as optional, so nothing else changed. Verified: the ban form now posts `userIds`,
      `removeMedia`, `reasonCode`, `detailsInternal` and nothing else.
- [x] **The paste boxes grow without bound instead of scrolling.** (2026-08-13.) **The cause is one
      class on the shared `Textarea`** — `field-sizing-content`, which grows the element with its
      content and has no ceiling. Capped per-box here (`max-h-40 overflow-y-auto`) rather than removed
      from the shared component, where auto-grow is right for a short reason field. The candidate list
      and both *in common* lists got the same treatment, since a bot chain makes all three long.

### 12j. Found while working the round, not reported

- [x] 🔴 **An unreachable ClickHouse took the whole Bulk Ban page down with a 500** (fixed 2026-08-13).
      Six sources loaded in one `Promise.all`, three of them ClickHouse-backed, so a DNS failure on the
      IP-clustering query failed the `load` — taking the candidate list, the email-domain clustering,
      the notes form and the ban button with it. On the page whose job is stopping a ring, losing the
      IP panel is a degraded investigation; losing the ban path is an outage.
      Each ClickHouse source now degrades to empty and the page names which one, because an empty IP
      panel otherwise reads as *"this account shares nothing with anyone"* — the same reasoning as
      `2002b4bfc7`. Found because the page 500'd while testing §12h; it reproduces anywhere ClickHouse
      is unreachable, which is every local dev machine.
- [x] **`Accepted TOS` was a truthiness test on a bitfield** — see §12g's Creator Program entry. Any
      completed onboarding step rendered the account as having accepted the TOS.
- [x] **The Most-reported count is short by one, and its filter hides two-reporter items** — see §12c.
      Asked for as a missing column; it was a present, wrong one.

### 12i. Permissions — sub-permissions inside a page (`1537519380148133980`)

- [ ] 🔴 **There is no way to restrict individual actions within a page, and several actions need it.**
      **The mechanism is built** (2026-08-14 — [`page-feature-permissions.md`](page-feature-permissions.md));
      one of the four named asks is not covered. No migration to apply — capabilities seed themselves
      from their declared defaults.
      Access was per-route, so anyone who could open User Lookup could do everything on it. Named as
      needing a narrower gate:
      - [x] editing email/username on Basic User Information → `identity.edit`
      - [x] adding or subtracting Buzz → `buzz.send`
      - [x] granting badges in the Cosmetic Shop → `cosmetics.grant`
      - [ ] **the entire Admin section** — only `moderator.toggle`, one button inside it, was carved
            out. Ban, purge-all-content, force-logout, rewards eligibility, Paddle re-linking and
            restriction rulings all still gate on `canAccess(user, '/users')` alone. No live hole
            today — `/users` is `{staff, senior}` and Retool hid the Admin nav from `Volunteer Mod`,
            so the two happen to agree — but nothing holds them together, and adding volunteer to
            `/users` for an investigation hands over the ban button. Needs a decision on whether it is
            one capability or several.
      **Confirmed in code**: `NAVIGATION` registered `/retool/user-lookup` as a *single* path, and the
      only narrower control was `isSenior`, hand-rolled at three call sites — with `updateIdentity`
      carrying no local gate at all. §0 had the same shape open for Bulk Ban (*"gate it, then widen
      deliberately"*) and §1b hand-rolled the same senior gate for `ToggleMod`.
      **Solved once, for all of them.** A declaration replaces every `isSenior` call site, which is now
      deleted, and `/admin` grants it per role — no schema change, since `AppPageAccess` already stores
      `(app, path) → roles[]`.
      🔴 **Reshaped 2026-08-19.** As first built, access was CONJUNCTIVE — the capability required its
      page plus everything in its `requires` — and that is what broke it: `/users` was never built, so
      five capabilities seeded to nobody and became admin-only with nothing reporting it. Page grants and
      action grants are independent now, keyed `grant:<id>`, with no defaults and no tri-state tree.
      See [`page-feature-permissions.md`](page-feature-permissions.md).
      Design confirmed on two recorded calls: 2026-08-07 (`1535334993470033991`, 42:00) landed the
      model, 2026-08-14 (`1537865483989295196`) fixed the UI and named the capabilities.
      ~~Blocked on §12g's Timed Mutes split~~ — that split shipped 2026-08-13, so `admin` and `mutes`
      no longer render the same panel.
