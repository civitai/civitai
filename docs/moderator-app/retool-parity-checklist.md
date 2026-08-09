# Retool parity — what must exist before Retool is switched off

**This is the priority list.** Everything here exists in Retool *today* and is either missing from the
port or provably different. Improvements the team has asked for but Retool never had live in
[`post-migration-backlog.md`](post-migration-backlog.md) — keep them out of this one.

Sources: the eight JSON exports, the ClickUp subtasks under `868kkxqpn`, 13 screenshots on the User
Lookup subtask, and two Loom walkthroughs (transcripts, 2026-08-09). Where an item quotes the
walkthrough it is marked 🎥.

Detail and evidence for most items: [`retool-exports/parity-findings.md`](retool-exports/parity-findings.md).

---

## 0. Blocking — a Retool app with no export at all

- [ ] 🎥 **Mass ban tool.** *"This one is limited to only some mods. Just a way to ban a lot of accounts
      at the same time — put them in like this and hit ban."* There is **no export, no ClickUp subtask
      and no page** for this. It is a live Retool app used by a restricted group.
      **Pull its export before access is lost.** Until then it is unported and unscoped.
      The walkthrough adds that other mods should get access, and that the alternative today is a
      cloud tool "not every mod has access to".

## 1. User Lookup — the primary console

Ported but incomplete. The header items are visible on every section in Retool, not buried in one.

- [ ] **Persistent header across all sections**: strike count, subscription tier, Force Logout,
      username / user id / email.
- [ ] **"Talked to a mod"** — a header button opening a *Chats with Mods* modal listing chat ids.
      🎥 *"You get to see if they've talked to a moderator previously."*
- [ ] **Report banner** — a pending/processing `UserReport` shown clearly at the top, actionable from
      this page. 🎥 *"You get to see if there's a user report on their account."*
- [ ] **CSAM banner** — a `CsamReport` against the account shown clearly at the top. `CsamReport` is
      currently read nowhere in the app.
- [ ] **Mute state must distinguish system from manual.** 🎥 *"if they're muted, if they're muted,
      overturned or pending."* `UserRestriction` is read nowhere, so a system auto-mute renders as an
      unexplained manual one, and unmuting here skips the Overturn path entirely.
- [ ] **Reports: two tabs, Received and Submitted**, each a full table with a **Status filter**.
      Screenshot shows **803 rows** for one account; ours is one merged list, no filter, capped at 50.
      `getReportsSubmitted` also drops the commonest kind (reports against accounts) while the tile
      above it counts them.
- [ ] **Report coverage is 6 of 11 entity types.** Bounty, BountyEntry, Collection, ResourceReview and
      chat reports are invisible, so an account reported over those reads as clean.
- [ ] **Buzz: Payments and Receipts side by side**, each with its own type filter, plus a Description
      filter, an *After date* picker, and a per-transaction **Color** column. Ours is one unfiltered
      list. 🎥 buzz is actively used to grant and deduct.
- [ ] **Deduct Types reference table** beside the send form (which types lower lifetime balance, which
      can go negative).
- [ ] **Moderation activity must show who did each action**, and includes the Retool era
      (`ReToolActions`) — currently only `ModActivity` is read, so all pre-migration history is absent
      while the panel reads as complete.
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

## 2. Bulk Image Manager

- [ ] 🎥 **Strike the user as part of the TOS action.** *"TOS, affect the reason, also strike the user."*
      Retool did both in one gesture; ours requires leaving for User Lookup per owner.
- [ ] 🎥 **Filter by rating.** *"You can filter to see specific ratings."*
- [ ] 🎥 **Include already-removed images in any source.** *"filter to see including the ones that have
      been removed from the account"* — built for the user source only (`userRemoved`), not as a filter
      across sources.
- [ ] **Image-only account nuke** (`remove-images` with `userId`, no id list) — absent; the user source
      caps at 200.
- [ ] Remove/restore counts are rows **found**, not rows **changed**, so re-removing an already-blocked
      batch reports success.

## 3. User Reports

🎥 *"press the report and then their images load below… previous removals, previous reports… everything
in the same screen instead of having to click around a bunch."*

- [x] Queue and account side by side (fixed 2026-08-09 — was stacked).
- [ ] **No image action path at all.** The grid is display-only: no selection, no remove/restore, and
      the strike checkbox that Retool tied into the same flow is absent.
- [ ] **Blocked images are hidden and `blockedFor` is never shown**, so prior enforcement is one number
      and a CSAM removal is indistinguishable from a tag cleanup. No restore path.
- [ ] **Prompt/negativePrompt dropped** from the cards — for a generated image the prompt is the evidence.
- [ ] 60-image cap with no paging (Retool reached 5000); per-suspect counts only, where Retool showed a
      count against every queue row.
- [ ] The suspect's history (mod activity, notes, received reports) is "shipped in User Lookup" — true
      of the data, false of this page.
- [ ] 🎥 **Post reports** — *"Same for post reports."* Confirm the post-report queue is equivalent.

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

- [ ] **Report `details` — the reporter's own words — is fetched and dropped on every page in the app.**
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
