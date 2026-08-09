# Retool parity — what must exist before Retool is switched off

**This is the priority list.** Everything here exists in Retool *today* and is either missing from the
port or provably different. Improvements the team has asked for but Retool never had live in
[`post-migration-backlog.md`](post-migration-backlog.md) — keep them out of this one.

Sources: the eight JSON exports, the ClickUp subtasks under `868kkxqpn`, 13 screenshots on the User
Lookup subtask, and two Loom walkthroughs (transcripts, 2026-08-09). Where an item quotes the
walkthrough it is marked 🎥.

Detail and evidence for most items: [`retool-exports/parity-findings.md`](retool-exports/parity-findings.md).

---

## 0. Bulk Ban — a ninth app, export now in hand

Subtask `868kn87qj`, *"Place to easily ban a list of users."* It was missed because the migration
tracker only ever listed nine of the parent's **thirteen** subtasks. Export pulled and inventoried at
[`retool-exports/bulk-ban.md`](retool-exports/bulk-ban.md) (15 queries / 12 components).

- [ ] **Port it.** Paste a newline-separated list of user ids → `BANAPI` per user
      (`/api/mod/ban-user`, one call each with a retry counter, capped at 5 consecutive failures) →
      `ListUsers` to confirm `bannedAt` landed → `LogBans` to `retool_db`.
- [ ] **It is also a ban-evasion console**, which is the part not to drop: `GetUsers` (buzz
      transactions), `GetIP` and `UsersByIp` (ClickHouse `userActivities` grouped by registration IP),
      `GetEmail`/`getEmails`, `UserNotes`. That is how a list of accounts is assembled in the first
      place.
- [ ] `deleteComments` runs against `Prod` as part of the flow — confirm whether banning here is
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

- [ ] **Persistent header across all sections**: strike count, subscription tier, Force Logout,
      username / user id / email.
- [ ] **"Talked to a mod"** — a header button opening a *Chats with Mods* modal listing chat ids.
      🎥 *"You get to see if they've talked to a moderator previously."*
      **Partially built:** `ChatContactPanel` already shows a chats-count and last-contact warning from
      `getModContact`. Missing is the header placement and the chat-id list — not the signal.
- [ ] **Report banner** — a pending/processing `UserReport` shown clearly at the top, actionable from
      this page. 🎥 *"You get to see if there's a user report on their account."*
      **Partially built:** `getReportsOnUser` already filters to Pending/Processing and `ReportsPanel`
      renders an amber block. Missing is the header placement and any way to action it from here.
- [ ] **CSAM banner** — a `CsamReport` against the account shown clearly at the top. `CsamReport` is
      currently read nowhere in the app.
- [ ] **Mute state must distinguish system from manual.** 🎥 *"if they're muted, if they're muted,
      overturned or pending."* `UserRestriction` is read nowhere, so a system auto-mute renders as an
      unexplained manual one, and unmuting here skips the Overturn path entirely.
- [ ] **Reports: a Status filter, and the 50-row cap.** Screenshot shows **803 rows** for one account.
      (Correction: ours is *not* one merged list — `ReportsPanel` already renders received and filed as
      two lists plus a banner. The real gaps are the filter and the cap.)
- [ ] `getReportsSubmitted` drops the commonest kind (reports against accounts) while the tile above it
      counts them, so "Total 12" can sit beside 4 rows.
- [ ] **Report coverage is 6 of 11 entity types.** Bounty, BountyEntry, Collection, ResourceReview and
      chat reports are invisible, so an account reported over those reads as clean.
- [ ] **Buzz: Payments and Receipts side by side**, each with its own type filter, plus a Description
      filter and an *After date* picker. Ours is one merged list on a fixed 90-day window with no
      filters. 🎥 buzz is actively used to grant and deduct.
      (The per-transaction **Color** is already rendered — that sub-claim was stale.)
- [ ] **A second row of aggregate tables** below those two (counterparty × total amount, for payments
      and for receipts) — the other half of the 2×2 grid.
- [ ] **The send form is missing `EntityType` / `EntityId`**, which Retool's `buzzSendEntityType` carries.
- [ ] **Deduct Types reference table** beside the send form (which types lower lifetime balance, which
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

### Found by the screenshot audit, absent from every earlier list

- [ ] 🔒 **Buzz sending was Senior-Mod-gated in Retool** (`tabbedContainer12`'s second pane carries
      `current_user.groups.some(i => i.name === "Senior Mod")`). Ours gates it on the general `/users`
      permission — **a restricted capability silently widened**. Highest priority in this block.
- [ ] **The whole account-edit capability.** An *Enable Edits* toggle over editable **Username, Email,
      Full Name**, plus a Quick Info checkbox block — Muted, Banned, Moderator, Accepted TOS, Excluded
      Leaderboards, Buzz-Blocked, FP Curator — with a Save button. Nothing in the build can edit any of
      it. (The *sub-permission* that should guard it is a backlog item; the capability itself is parity.)
- [ ] **Admin actions**: Make/Remove Moderator, Add/Remove **Buzz-Block**, Generator Buzz Earnings.
- [ ] **Notifications**: a **Delete Notification** action and a **Link** field on the send form; ours is
      message-only with no delete.
- [ ] **Browsing level shown** ("Viewing: PG, PG13, R, X, XXX, Blocked") and a **Comment Spammer** alert
      in Quick Info.
- [ ] **Timed mutes**: a **Mute Start** datetime and a **Notify User** button beside the presets.
- [ ] Header chips the checklist missed: **Banned for CSAM**, **UserReport by \<mod\>**, and a
      **Copy Retool URL / Profile** pair.

## 2. Bulk Image Manager

- [ ] 🎥 **Strike the user as part of the TOS action.** *"TOS, affect the reason, also strike the user."*
      Retool did both in one gesture; ours requires leaving for User Lookup per owner.
- [ ] 🔴 **`violationType` / `violationDetails` are never sent on removal.** `/api/mod/remove-images`
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
- [ ] **Bulk selection helpers** — Select All / Select 100 / Unselect All. Multiselect works, but only
      click-by-click, so a 200-image batch is 200 clicks.
- [ ] `negativePrompt` is selected and rendered nowhere.
- [ ] **Image-only account nuke** (`remove-images` with `userId`, no id list) — absent; the user source
      caps at 200.
- [ ] Remove/restore counts are rows **found**, not rows **changed**, so re-removing an already-blocked
      batch reports success.

## 3. User Reports

🎥 *"press the report and then their images load below… previous removals, previous reports… everything
in the same screen instead of having to click around a bunch."*

- [x] Queue and account side by side (2026-08-09 — was stacked). **The screenshot settles what Retool
      did**: history tabs top-left, queue table top-right, image grid full-width below. So ours is a
      deliberate improvement, not parity. Caveat: the split is `xl:` only, so it still stacks below
      1280px — the exact failure it was meant to fix.
- [ ] 🔴 **The image grid's entire filter bar.** Retool had, above the suspect's images: *Show only
      ToS'd*, *Clear Filter*, *No Prompt Only*, rating checkboxes (PG / PG-13 / R / X / XXX / ToS),
      *Start Date* / *End Date* / *Reset*, and *Search Prompt* / *Search Neg Prompt*. We have none of
      it — so 60 unfiltered, unsearchable images is the whole review surface for an account with
      thousands. Largest single omission in this section.
- [ ] **No image action path at all.** The grid is display-only: no selection, no remove/restore, no
      Select All / Select 100. (The *strike* action itself IS on this page; what is missing is tying it
      to an image removal, as Retool's `strikeCheckbox` did.)
- [ ] **`blockedFor` is never shown and blocked images are excluded**, so a CSAM removal is
      indistinguishable from a tag cleanup, and there is no restore path. (The blocked *count* is
      already reported separately as "N already blocked" — the gap is which and why.)
- [ ] **A "Remaining" column per queue row** — the non-removed count, beside "Images". It is the number
      that says whether an account has already been cleaned up; we show neither.
- [ ] **`?user=` and `?page=` clobber each other.** Clicking a report on page 3 returns you to page 1;
      paging closes the open drill-down. Small code, hit within a minute of working page 2.
- [ ] Report history capped at 100 where Retool used 300; no *Profile* deep link beside User Lookup.
- [ ] **Prompt/negativePrompt dropped** from the cards — for a generated image the prompt is the evidence.
- [ ] 60-image cap **with no paging wired** — `ImageQueueGrid` already implements cursor paging and the
      page simply doesn't pass a cursor. Retool's button reads *"Grab 5000 images"* and its query had no
      `LIMIT` at all.
- [ ] The suspect's history — Retool's top-left was a three-tab panel **ModActivity / Reports / UserReport
      History** with actor and reason per row. **Strikes are the one piece already here**; mod activity,
      notes and received reports are not.
- [ ] 🎥 **Post reports** — *"Same for post reports."* **Unverifiable from what we hold**: the User
      Reports export has no post-report queue, and there is no separate post-reports export. A generic
      post-report *queue* is shipped at `/reports/post` with filters and actions; the drill-down half
      (the post's images inline, actions on them) certainly is not. **Needs the post-reports export or a
      screenshot of that tab.**

## 4. Image Lookup

- [ ] 🎥 **Expose all the columns.** *"you can expose all the columns. Maybe you want to look into the
      hashes or the meta… ingestion, all this stuff."* Retool used `SELECT *`; ours drops `meta` (the
      **prompt**), `hideMeta`, `analysis`, `scanJobs`, `hash`, `pHash`.
- [ ] Report `details` fetched and never rendered.
- [ ] `hasImageEvents` is an unguarded ClickHouse call in `load`, so ClickHouse being down turns "no
      image matches" into an error page.

## 5. Chat Audit

- [x] Content search reachable for spam terms; "Open reports" actually filtered (both fixed 2026-08-09).
- [ ] The reporter's `details->>'comment'` is fetched and never rendered — for a chat report that
      comment is the entire substance.
- [ ] `TopChatters` capped at 25 where Retool showed 50.

## 6. Article Lookup

- [ ] `unlisted` is selected and rendered nowhere — an unlisted article looks identical to a public one.
- [ ] `Article.metadata` dropped; confirm nothing moderation-bearing lives in it.

## 7. Front Page Audit

- [ ] **Confirm this is still wanted before finishing it.** 🎥 *"We are reviewing all PG videos. I'm not
      sure if we need to do this anymore… she only does a few a day."* Built, but three pieces are
      unported pending schemas (`FrontPageTimers` resume point, `RatingChanges`, `research_ratings`).
      **Ask before spending more on it.**

## 8. Moderation Status → `/retool/image-help`

- [ ] `ReviewGrouped` and `GetSplitQueue` — the two queries never matched to an existing page.
- [ ] Its help queue is fed by three producers (`GetMinors`/`GetPoI`/`GetReported` → `Store*`) that are
      cron-shaped and not yet scheduled anywhere, so the queue will not fill on its own.

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
- [ ] **Re-extract every export while access remains** — only `user-lookup-v2` has option sets and
      layout geometry.
- [ ] 🔒 **Rotate the Freshdesk API key** that sits in plaintext in the ClickUp ticket body.
- [ ] **Nothing has been exercised in a browser** beyond two User Reports screens.
