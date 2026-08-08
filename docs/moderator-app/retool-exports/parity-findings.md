# Export-vs-build parity findings (2026-08-08)

A fourth review pass, run over every ported slice: **the export's SQL against what was built**. The
three standing review agents compare the code to itself and to this app's conventions, so all three
pass cleanly over a faithful implementation of the wrong thing. Every slice below had already passed
them.

The coverage gate was name-level, and it does not hold: on Bulk Image Manager all 40 queries were
NAMED in the audit and four were still not covered. A classification row absorbs a query whose
behaviour it does not carry. Read each query's WHERE clause, its input widget, and the columns it
selects — not its name.

Status: **[x] fixed · [ ] open**. Nothing here is verified in a browser.

## Bulk Image Manager — fixed in 948bd9d110

- [x] `UserQuery5000` (`WHERE nsfwLevel = 32`, the already-removed view) absorbed into a row about
      `resolveUserId` → added as the `userRemoved` source
- [x] Pasted-id-list entry point (`textArea5`, 4 queries) classified by endpoint → added as `imageIds`
- [x] `prompt`, `poi`, `minor` selected on every row, rendered nowhere → on the card, with
      profile-picture / attached-to-entity warnings
- [x] `nukeUser` mis-mapped to `purgeAllContent` (much larger blast radius) → audit corrected
- [x] One 5000-id call → chunked at 100, as Retool's chunk-of-10 did
- [ ] Image-only account nuke absent; counts are rows *found* not *changed*; remove+strike not ported
      (all recorded in `bulk-image-manager-audit.md`)

## User Lookup v2 — 14 findings, 2 fixed

- [x] **Account history was logins only.** Retool filtered `AND NOT type = 14`; the port dropped it.
      31.6M Login rows against 62k Muted / 48.6k Banned, so a 50-row window is ~49 logins and a
      thrice-muted account showed no enforcement history at all.
- [x] **The ban confirmation claimed images are removed. They are not.** `toggleBan` blocks media only
      when `removeMedia === true` or the reason is `SexualMinor`; the port never sends it. Copy
      corrected — a `Nudify` ban leaves every image up.
- [ ] **Reports-they-filed drops most of them** and contradicts its own total tile: the port
      inner-joins the six content report tables, so reports filed against *accounts* (the commonest
      kind), collections, bounties, reviews and chats vanish — while `getReportsFiled` counts the
      unjoined total. "Total 12" beside 4 rows.
- [ ] **`report-sources.ts` lists 6 entity types; Retool's `ReportsReceived` UNIONed 11.** Bounty,
      BountyEntry, Collection, ResourceReview and chat reports are invisible. A user repeatedly
      reported over a collection reads as a clean account. Affects counts and rows identically.
- [ ] **`UserRestriction` is read nowhere.** A system auto-mute (prohibited-prompt volume) deliberately
      leaves `mutedAt` NULL, so it renders as a muted account with no reason and no activity. Unmuting
      from here also skips the Overturn path — the restriction stays `Pending`, the subscription is not
      reinstated, the user is never told.
- [ ] `CsamReport` read nowhere — an account with a CSAM report filed against it looks clean
- [ ] Moderation Activity omits `ReToolActions` — every pre-migration action, presented as complete
- [ ] Model/comment breakdowns (`NumTos`, `NumPoi`, `NumNSFW`, `NumLocked`, `NumDeleted`,
      `NumTOSViolations`, `NumHidden`) collapsed to a single `COUNT(*)`
- [ ] Reviews can be deleted without their text (`details`) ever being shown
- [ ] Report `details` / `internalNotes` shipped to the browser and never rendered — the reporter's own
      words are the only part saying what happened
- [ ] Notification `details` dropped — the panel captioned "context for 'I was never warned'" renders
      announcements with no message
- [ ] `setRewardsEligibility` has no UI, and as wired it cannot succeed (`callMainApp` sends query-string
      params; the endpoint reads `req.body` and requires `modId`)
- [ ] Report list has no status/reason filter and a hard 50-row cap where Retool had none
- [ ] Timed-mute presets (6/12/24/48/72/168) still a free-text hours box

## User Reports — 9 findings, 0 fixed

- [ ] **No image action path at all.** Retool selected a reported user's images and removed/restored
      them here, with the strike checkbox and notification in the same flow. `ImageQueueGrid` is passed
      no `selected` set, so the grid is display-only and nothing links to Bulk Image Manager.
- [ ] Blocked images excluded (`ingestion != 'Blocked'`) and `blockedFor` never surfaced — prior
      enforcement is one number, a CSAM removal is indistinguishable from a tag cleanup, no restore path
- [ ] 60-image cap with no cursor, where Retool reached 5000
- [ ] `prompt` / `negativePrompt` dropped from the cards — for a generated image the prompt *is* the
      ToS evidence
- [ ] `profile` / `bounty` flags dropped (blast-radius warnings)
- [ ] `GetImageCount` was per-queue-row in Retool; now only for the selected user, so the queue no
      longer shows which accounts have content worth reviewing
- [ ] The suspect's history datasets (ClickHouse activities, Retool actions, notes, received reports)
      are "shipped in User Lookup" — true of the datasets, false of this page
- [ ] `ReportHistory` 300 → 100
- [ ] Pagination links drop the `user` param, closing the suspect drill-down

## Chat Audit — 5 findings, 2 fixed

- [x] **Message-content search was unreachable for most spam terms.** `USERNAME_SHAPE`
      (`^[\w.-]{3,50}$`) classified `discord.gg`, `telegram`, `onlyfans`, `bitcoin` as usernames →
      0 rows → "No chats matched", where the same term matches ~4,774 chats. Now falls through to
      content search when the username does not exist.
- [x] **"Open reports" counted every chat report in history.** No `statuses`/`reasons` passed to
      `getReports`, under copy claiming the same definition of open as `/reports`; Retool's
      `reason != 'Automated'` was also dropped. Both restored.
- [ ] Reporter's `details->>'comment'` fetched and never rendered — for a chat report that comment is
      the entire substance
- [ ] `TopChatters` 50 → 25, unexplained
- [ ] Ban / note actions deliberately delegated to User Lookup (accepted, but it is a capability
      removed from this screen)

## Image Lookup — 4 findings, 0 fixed

- [ ] **`Image.meta` dropped** — Retool's `SELECT *` put the generation prompt in front of the
      moderator. On an image flagged `minor` or `poi` the prompt is the strongest evidence, and this
      repo treats it as first-class elsewhere (`@civitai/mod-utils/prompt-audit`). `hideMeta` is also
      gone, so "uploader hid the prompt" and "no prompt" look identical.
- [ ] Report `details` fetched, never rendered (same shape as everywhere else)
- [ ] `hasImageEvents` is an unguarded ClickHouse call in `load`, so ClickHouse being down turns
      "no image matches" into an error page
- [ ] `ImageReaction.updatedAt` dropped (no consequence found)

## Article Lookup — 3 findings, 0 fixed

- [ ] `unlisted` selected, typed, rendered nowhere — an unlisted article is visually identical to a
      public one
- [ ] `coverId` declared on `ArticleRow` but never selected; `as unknown as ArticleRow` hides it, so a
      future cover thumbnail silently renders blank
- [ ] `Article.metadata` dropped; unverified whether anything moderation-bearing lives there

## Cross-cutting

1. **Report `details` is dropped on every page that shows reports** — User Lookup, User Reports, Chat
   Audit, Image Lookup. The reporter's own words never reach the DOM anywhere in this app.
2. **`getReports` applies status/reason filters only when passed**, silently returning all history
   otherwise. Chat Audit was the first caller to trip on it. A required parameter, or an explicit
   `'all'` sentinel, would make the next omission a compile error rather than a wrong number.
3. **Columns selected but never rendered** is the single most repeated defect — prompts, flags,
   `blockedFor`, notification bodies, report details. Fetching costs a query; dropping it costs a
   moderator deciding blind.
