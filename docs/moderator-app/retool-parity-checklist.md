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
- [ ] **ReTool Database Migration** (`868kn67aq`) — the tables to move off Retool's Postgres:
      `User`, `UserNotes`, `UserStrikes`, `ModelNotes`, `RatingChanges`, `ReToolActions`, and
      `BuzzCodes` ("could potentially be dropped"). **`ModelNotes` is not in
      `moderator-db-types.ts`** and nothing in the app reads it.
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

- [ ] 🔴 **Timed mutes never expire.** `addTimedMute` writes the moderator-DB row and sets
      `muted`/`mutedAt`, but **not `User.muteExpiresAt`** — the only thing that lifts a timed mute is
      the main app's `processTimedUnmutes`, which selects on that column. So a 24-hour mute is
      permanent while the panel renders it as expiring. **This cannot be fixed locally**: the main app
      uses `muteExpiresAt !== null` to mean "this mute came from strikes", so a spoke-set value would
      let a strike expiry silently clear a moderator's mute. Needs an `expiresAt`/`muteHours` parameter
      on `retool/user → mute`, main-app side.
- [ ] **Strikes write a second, disconnected ledger.** `addUserStrike` inserts into the moderator DB's
      legacy `UserStrikes`; the main app owns `UserStrike` via `retool/strike → create`. Missing from
      the local path: escalation (≥2 points auto-mutes 3 days, ≥3 indefinite + session invalidation),
      `points`/`expiresAt`, the `StrikeReason` enum, `reportId` attachment, the typed `strike-issued`
      notification and its email, the auto-strike rate limit, and any way to void. The panel is also
      blind to every strike the automated pipeline issued. **Still filed as backlog rather than parity
      — Retool never called that endpoint either** — but this is the largest behavioural gap in the app.
- [ ] **Local mute / force-logout skip the session SIGNAL.** They revoke tokens and drop the session
      cache but never `sendSessionSignal`, so a connected user is not pushed out until their client
      next refreshes. Same in `unmuteAndClearTimed` and `revokeTimedMute`.
- [ ] **Cosmetic grant and shop refund miss the owned-sticker cache bust.** A granted sticker is not
      sendable, and a refunded one stays sendable, for up to 5 minutes (`USER_OWNED_STICKER`, no
      stale-while-revalidate). One `bustCachedObject` either way.
- [ ] **"Remove Badges" (`RemoveCosmetics`) unported** — `ShopPanel` can grant but not remove. The safe
      path exists: `retool/cosmetic → unassign`.
- [ ] **Every `retool/*` call attributes to the API key's owner**, not the acting moderator: one shared
      `CIVITAI_MOD_API_KEY` confers each `privileged:` capability on everyone who can reach the page,
      shares the per-actor rate limits, and puts the key owner on every `retoolAudit` row. Either mint
      per-moderator keys (the endpoints resolve a real user from the bearer token) or state that
      `isSenior` is the real control — and `updateIdentity` currently has no senior gate at all.
- [ ] **Filter rows missing on five list panels**, each with the same failure: destructive checkboxes
      sitting on top of a fixed newest-25. Reviews (Rating / TOS Violation? / NSFW? / Excluded? /
      Search Review Content — and the review **text** is never rendered, so reviews are deleted on
      rating and date alone), Comments (search), Bounties (Type / Complete / Name / Description),
      Reports (reason filter — status is done), Prompt Audit (Filter Prompt / # of Prompts).
- [ ] **Bulk review/comment deletion has no confirmation step.** Retool gated it behind a modal; ban
      and purge here got confirmations, these did not.
- [ ] **Notifications: three dropped pieces** — the "Number of Notifs" control (hardcoded 25), Delete
      Notification, and `notificationLink`. The last is live on the receiving end:
      `system-announcement`'s `prepareMessage` reads `details.url`, and the send form posts `message`
      only.
- [ ] **`GensPerResource` look-back days hardcoded to 30** — the service takes the parameter, nothing
      passes it.
- [ ] **Cover image and profile picture not shown.** Retool had "Look at Cover Image" / "Look at PFP";
      checking those for TOS content was an in-tool action.

- [ ] **Header: the strike chip, subscription tier and Force Logout are missing from it.** (The header
      itself, and lookup by id / username / email, are **already done** — `+layout.svelte` keeps
      username, id and the banned/muted/deleted/moderator badges on every section, and `resolveUserId`
      already tries all three.) Force Logout, mute, ban and purge exist but live under Admin.
- [ ] **Paddle account linking is absent.** Retool had a three-step wizard behind the Membership
      panel's Paddle button — find account by customer id, unlink an old one, link this one — writing
      `User.paddleCustomerId` with a `retool_db` audit row. The port reads that column and deep-links
      to Paddle, but nothing can re-link a mis-linked billing account.
- [ ] **"Content (click rows!)" is a drill-down, and ours goes somewhere else.** Retool's rows clicked
      through inside the console; ours link out to the **public** civitai profile — where deleted,
      unpublished and TOS'd content is not shown, so the count and the page it opens legitimately
      disagree. Three of eight rows (model comments, image comments, reviews) do not link at all.
      Point each row at the in-app section instead.
- [ ] **A ninth Content row, Chat Messages**, that `AllCountsUnion` does not produce and we do not show.
- [ ] **Placement**: Retool put mute / ban / purge / freshdesk / refresh-session / clear-cache in a bar
      on the landing section. Ours are all one section away under Admin. Reachable, but not in front of
      the moderator on arrival.
- [x] **`sections.ts` is inverted against the live nav**: it ships *Content Overview* (which the live
      sidebar does **not** show) and omits *Bulk Image Manager* (which it does). That page now exists.
- [ ] **"Talked to a mod"** — a header button opening a *Chats with Mods* modal listing chat ids.
      🎥 *"You get to see if they've talked to a moderator previously."*
      **Partially built:** `ChatContactPanel` already shows a chats-count and last-contact warning from
      `getModContact`. Missing is the header placement and the chat-id list — not the signal.
- [ ] **Report banner** — a pending/processing `UserReport` shown clearly at the top, actionable from
      this page. 🎥 *"You get to see if there's a user report on their account."*
      **Partially built:** `getReportsOnUser` already filters to Pending/Processing and `ReportsPanel`
      renders an amber block. Missing is the header placement and any way to action it from here.
- [x] **CSAM banner** (2026-08-09 — `getIdentity` counts `CsamReport` and the layout header carries a
      `CSAM report ×N` chip on every section).
- [ ] **Mute state must distinguish system from manual.** 🎥 *"if they're muted, if they're muted,
      overturned or pending."* **Partially built** (2026-08-09): the header now shows the latest
      `UserRestriction` as `<type>: <status>`, so a system auto-mute no longer reads as a manual one.
      Still missing: unmuting from here goes straight to the mute toggle and skips the Overturn path.
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
- [ ] **A second row of aggregate tables** below those two (counterparty × total amount, for payments
      and for receipts) — the other half of the 2×2 grid.
- [x] **The send form is missing `EntityType` / `EntityId`**, which Retool's `buzzSendEntityType` carries.
- [x] **Deduct Types reference table** beside the send form (which types lower lifetime balance, which
      can go negative).
- [ ] **Moderation activity omits the Retool era.** Only `ModActivity` is read; `ReToolActions` is typed
      and queried nowhere, so all pre-migration history is absent while the panel reads as complete.
      (Correction: "must show who did each action" is **already done** — `getModActivity` joins the
      moderator name and the panel renders it.)
- [ ] **Model/comment breakdowns** (`NumTos`, `NumPoi`, `NumNSFW`, `NumLocked`, `NumDeleted`,
      `NumTOSViolations`, `NumHidden`) collapsed to a single `COUNT(*)`.
- [ ] **Review text (`details`) is never shown** — reviews can be deleted on rating and date alone.
- [ ] **Notification bodies dropped** from the panel captioned "context for 'I was never warned'".
- [ ] **`setRewardsEligibility` has no UI**, and as wired it cannot succeed (`callMainApp` sends query
      params; the endpoint reads `req.body` and requires `modId`).
- [ ] **Timed-mute presets** (6/12/24/48/72/168h) are a free-text hours box.
- [ ] **Bulk Image Manager is a section of User Lookup's sidebar** in the live app; `sections.ts`
      omitted it because nothing was ported behind it. That page now exists.
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
- [~] **The account-edit capability.** Username and Email are editable behind the *Enable Edits*
      toggle. **Still missing** (this was ticked in error — caught by the 2026-08-09 fidelity pass):
      **Full Name**, which `updateIdentity` and `/api/mod/retool/user` both already accept, and the
      whole **Quick Info checkbox block** — Accepted TOS (`onboarding`), Excluded Leaderboards,
      Buzz-Blocked, FP Curator, plus `browsingLevel`/`showNsfw`/`blurNsfw`. `UserContent` selects all
      of them and none reaches the DOM. (The *sub-permission* that should guard it is a backlog item.)
- [x] **Admin actions**: Make/Remove Moderator, Add/Remove **Buzz-Block**, Generator Buzz Earnings
      (2026-08-09 — all three on the Admin section; see 1a).
- [ ] **Notifications**: a **Delete Notification** action and a **Link** field on the send form; ours is
      message-only with no delete.
- [ ] **Browsing level shown** ("Viewing: PG, PG13, R, X, XXX, Blocked") and a **Comment Spammer** alert
      in Quick Info.
- [ ] **Timed mutes**: a **Mute Start** datetime and a **Notify User** button beside the presets.
- [ ] Header chips the checklist missed: **Banned for CSAM**, **UserReport by \<mod\>**, and a
      **Copy Retool URL / Profile** pair.

## 2. Bulk Image Manager

- [ ] 🔴 **`TosReasons` — the removal reason picker, and its user-facing messages.** Found 2026-08-10
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

      Ours offers the `violationType` enum plus a free-text reason: the canned messages and the
      automatic flagging are both absent, so every moderator writes their own wording and sets POI or
      minor by hand afterwards. **The same widget is on User Reports** — fix once, in `ImageActionBar`.
- [ ] 🎥 **Strike the user as part of the TOS action.** *"TOS, affect the reason, also strike the user."*
      Retool did both in one gesture; ours requires leaving for User Lookup per owner. The export's
      `strikeCheckbox` ("Strike User's Account") is the control, on **both** this page and User Reports.
- [x] 🔴 **`violationType` / `violationDetails` are never sent on removal.** `/api/mod/remove-images`
      accepts a `violationType` **enum** plus a details string and forwards both to the ClickHouse
      `DeleteTOS` event; the port sends only free-text `reason`. **Every removal from this page is
      logged with an empty violation classification** — silent and permanent. The endpoint's own zod
      schema is the authoritative list, so this needs **no re-extract**; the BIM audit's "re-extract
      before trusting the action set" was the wrong conclusion for this item.
- [ ] 🎥 **Filter by rating** — *"you can filter to see specific ratings"*. Worse than missing: the
      rating is **never displayed**. `nsfwLevel` is selected and typed but the card renders
      ingestion/needsReview/poi/minor/date/prompt and drops it.
- [ ] **A toggle to hide or isolate removed images.** (Correction: an earlier draft claimed removed
      images were only reachable via the user source. **Wrong — every source already returns them**,
      badged `blocked: <reason>`, because `imageBase()` applies no ingestion filter. What Retool had and
      we lack is the client-side *toggle* — "Show only ToS'd" / "Clear Filter" — plus a removed-only
      view for the non-user sources.)
- [x] **Bulk selection helpers** — Select All / Select 100 / Unselect All (2026-08-09, in the shared
      `ImageActionBar` that Bulk Image Manager and User Reports both use).
- [ ] `negativePrompt` is selected and rendered nowhere.
- [ ] **Image-only account nuke** (`remove-images` with `userId`, no id list) — absent; the user source
      caps at 200.
- [ ] Remove/restore counts are rows **found**, not rows **changed**, so re-removing an already-blocked
      batch reports success.

## 3. User Reports

🎥 *"press the report and then their images load below… previous removals, previous reports… everything
in the same screen instead of having to click around a bunch."*

- [ ] 🔴 **`tosReasonsRadio` + `strikeCheckbox`** — this page carries the same two widgets as Bulk
      Image Manager, so the eleven canned TOS reasons, their user-facing messages, the `poi`/`minor`/
      `tag` flagging and "Strike User's Account" are missing here too. See §2 for the full table; the
      fix belongs in the shared `ImageActionBar`.
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
- [ ] The suspect's history — Retool's top-left was a three-tab panel **ModActivity / Reports / UserReport
      History** with actor and reason per row. **Strikes are the one piece already here**; mod activity,
      notes and received reports are not.
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
- [ ] `ImageReaction.updatedAt` and the image row's `updatedAt` are dropped.

## 5. Chat Audit

- [ ] **The reports tab has no Status filter.** Retool's `select1` ("Status", bound to
      `ChatReport.data`) let a moderator pick; ours hardcodes `DEFAULT_REPORT_STATUSES`, so resolved
      chat reports cannot be reached at all. Same shape as the User Lookup reports filter fixed on
      2026-08-09. `select2` ("Username", bound to `FindChatById.data`) is the second half.
- [x] Content search reachable for spam terms; "Open reports" actually filtered (both fixed 2026-08-09).
- [x] The reporter's `details->>'comment'` is fetched and never rendered — for a chat report that
      comment is the entire substance.
- [x] `TopChatters` capped at 25 where Retool showed 50 (surfaced, so not silent).
- [ ] **A sixth tab, "Send Mod Chat"** — a moderator-initiated DM from this screen. In no export, no
      build and no list; the screenshot is the only record. Needs a re-extract to size.
- [x] **"SPAM Detector" is already built** — it is `SpamGroupsPanel` on the stats tab. Recorded so
      nobody builds it from the screenshot.
- [ ] Retool also had **Ban Reason + "Ban and Set Note"** here. Deliberately delegated to User Lookup —
      listed so the decision reads as considered rather than missed.

## 6. Article Lookup

- [x] `unlisted` is selected and rendered nowhere — an unlisted article looks identical to a public one.
      Retool's data table shows an **Unlisted** column.
- [ ] `Article.metadata` dropped (Retool showed a **Metadata** column); confirm nothing
      moderation-bearing lives in it — that half needs the column's live contents.
- [ ] `coverId` is declared on `ArticleRow`, never selected, and `as unknown as ArticleRow` hides it.
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
- [ ] `ReviewGrouped` — **not an unmatched query: it is the dashboard.** `COUNT(*) GROUP BY needsReview`
      plus a pending-report count, i.e. the *Content Needing Review* block. Moved to the Dashboard
      section below.
- [x] **`image-help` gates on `/images`**, a group node whose grant is the union of its children — the
      same hazard Front Page Audit documents as its reason for gating on its own path. A moderator
      granted only `/images/to-ingest` gets action rights here.

## 8b. Dashboard — absent from every list until now

Retool's board is the triage entry point, and the walkthrough's colour quote lands here.

- [ ] 🎥 **Per-queue severity colour with per-queue thresholds** — *"green indicates this is fine, four
      images in POI, but 400 reported images is more of an emergency."* Ours renders every count in the
      same style, which is exactly what the colour exists to prevent.
- [ ] **Who last worked each queue, and how long ago** (staleness).
- [ ] **An "Urgent Content (N)" banner** — a lot of reports on a recent image.
- [ ] **Per-entity report breakdown across all 11 types** (models, comments, commentV2, reviews,
      articles, posts, users, collections, bounties, bountyEntries, chats), each with colour and
      staleness. Ours covers 6 types app-wide.
- [ ] **A Front Page block** reading "N hours behind" with a Split control, and **Special Queues**
      (Blocked Images, Civitai Models, Training Data, Appeals).

## 9. Workflows (cron)

- [ ] 🎥 **Only one is live: the DALEN challenge runs.** *"I think the only ones that currently are being
      used is the DALEN challenge runs; we would need to move these into Civitai somewhere."* Port that
      one into the main app's cron; confirm the rest can die with Retool.

## 10. Cross-cutting

- [ ] **Report `details` — the reporter's own words — is fetched and dropped on most pages.**
      (Correction: **not** User Reports. `QueuePanel` renders `details->>'violation' ?? 'reason'` and
      `details->>'comment'` as its own paragraph, matching Retool. Verify each page before "adding" it.)
- [ ] `getReports` applies status/reason filters only when passed, silently returning all history
      otherwise. Chat Audit was the first caller to trip on it.

## 11. Operational

- [ ] `CIVITAI_MOD_API_KEY`, `RETOOL_DATABASE_URL`, `FRESHDESK_API_KEY` — see the handover.
- [ ] Three SQL migrations, applied by hand.
- [ ] Grant five new pages on `/admin`.
- [x] **Re-extract every export while access remains** — done 2026-08-10; all nine carry option sets
      and layout geometry, and sanitized copies are committed under `retool-exports/raw/`.
- [x] 🔒 **Support-tool credential** — never committed (verified 2026-08-10). Ticket-body hygiene is an
      owner's call; specifics belong in the private infra repo.
- [ ] **Browser verification is partial.** The moderation team is exercising pages as they go and
      feeding findings back per session, rather than this being one gated pass. Treat a slice as
      unverified until someone says otherwise, but do not block porting on it.
