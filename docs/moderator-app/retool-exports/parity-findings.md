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

**Reconciled against the code 2026-08-10.** The boxes had gone stale — fixes landed in `2586b46947`
and `b3456102bb` without being ticked, so this file read as 19 open findings when 16 were done. If you
are about to act on an unticked box, check the code first; that is how this file misleads.

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

## User Reports — 9 findings, 8 fixed

- [x] **No image action path at all.** Retool selected a reported user's images and removed/restored
      them here, with the strike checkbox and notification in the same flow. `ImageQueueGrid` is passed
      no `selected` set, so the grid is display-only and nothing links to Bulk Image Manager.
- [x] Blocked images excluded (`ingestion != 'Blocked'`) and `blockedFor` never surfaced — prior
      enforcement is one number, a CSAM removal is indistinguishable from a tag cleanup, no restore path
- [x] 60-image cap with no cursor, where Retool reached 5000
- [x] `prompt` / `negativePrompt` dropped from the cards — for a generated image the prompt *is* the
      ToS evidence
- [x] `profile` / `bounty` flags dropped (blast-radius warnings)
- [x] `GetImageCount` was per-queue-row in Retool; now only for the selected user, so the queue no
      longer shows which accounts have content worth reviewing
- [ ] The suspect's history datasets (ClickHouse activities, Retool actions, notes, received reports)
      are "shipped in User Lookup" — true of the datasets, false of this page
- [x] `ReportHistory` 300 → 100
- [x] Pagination links drop the `user` param, closing the suspect drill-down

## Chat Audit — 5 findings, 4 fixed

- [x] **Message-content search was unreachable for most spam terms.** `USERNAME_SHAPE`
      (`^[\w.-]{3,50}$`) classified `discord.gg`, `telegram`, `onlyfans`, `bitcoin` as usernames →
      0 rows → "No chats matched", where the same term matches ~4,774 chats. Now falls through to
      content search when the username does not exist.
- [x] **"Open reports" counted every chat report in history.** No `statuses`/`reasons` passed to
      `getReports`, under copy claiming the same definition of open as `/reports`; Retool's
      `reason != 'Automated'` was also dropped. Both restored.
- [x] Reporter's `details->>'comment'` fetched and never rendered — for a chat report that comment is
      the entire substance
- [x] `TopChatters` 50 → 25, unexplained
- [x] **WON'T FIX** — ban / note actions deliberately delegated to User Lookup (a capability
      removed from this screen)

## Image Lookup — 4 findings, 3 fixed

- [x] **`Image.meta` dropped** — Retool's `SELECT *` put the generation prompt in front of the
      moderator. On an image flagged `minor` or `poi` the prompt is the strongest evidence, and this
      repo treats it as first-class elsewhere (`@civitai/mod-utils/prompt-audit`). `hideMeta` is also
      gone, so "uploader hid the prompt" and "no prompt" look identical.
- [x] Report `details` fetched, never rendered (same shape as everywhere else)
- [x] `hasImageEvents` is an unguarded ClickHouse call in `load`, so ClickHouse being down turns
      "no image matches" into an error page
- [x] **WON'T FIX** — `ImageReaction.updatedAt` dropped; no consequence found in two passes

## Article Lookup — 3 findings, 2 fixed

- [x] `unlisted` selected, typed, rendered nowhere — an unlisted article is visually identical to a
      public one
- [x] `coverId` declared on `ArticleRow` but never selected; `as unknown as ArticleRow` hides it, so a
      future cover thumbnail silently renders blank
- [x] `Article.metadata` dropped — now selected and rendered raw when non-empty, since the column is `Json?` with no schema documentation and guessing its contents is what kept this open

## Layout parity (from the extractor's new `## layout` section, 2026-08-08)

The extractor now emits Retool's structure — containers, their panes, and modals. Not yet actioned on
any existing slice; recorded here so it is not re-derived. **User Lookup's real tab groups:**

- [ ] `tabbedContainer8` — **"Submitted Reviews" / "Received Reviews"** (two tabs, plus filters
      `Excluded?`, `NSFW?`, `TOS Violation?`, `Review Rating`, `Search Review Content`)
- [ ] `tabbedContainer9` — **"Bounties" / "Bounty Entries"** (filters `Type`, `Complete`,
      `Name Contains`, `Description Contains`)
- [ ] `tabbedContainer10` — **"Reports Received" / …**
- [ ] `tabbedContainer12` — **"View Buzz" / "Buzz Transaction"**, and the second pane is gated on
      `current_user.groups.some(i => i.name === "Senior Mod")`. **This gate exists in no query.** If
      buzz sending is reachable by every moderator here, it is a capability that was senior-only in
      Retool.
- [ ] `tabbedContainer14` — 3 panes

Each is a candidate sub-page rather than a scrolling section. Only the top-level nav
(`MainContentContainer`'s 21 view keys → `sections.ts`) was honoured; these nested groups were not.

**User Reports was stacked, and is now queue-left / account-right** (2026-08-09, found by looking at
the running page — the account panel sat below a 50-row queue, so clicking a report read as "nothing
happened"). **Retool's actual arrangement is unconfirmed**: that export predates the layout emitter and
its raw JSON is not on disk. The two `ContainerWidget2` in its component list are consistent with a
sidebar-plus-detail split but do not prove one. **Confirm on re-extract** — if Retool stacked them, this
is a deliberate improvement rather than a parity fix, and either way it should be recorded as one.

## Layout geometry (2026-08-09, from a screenshot of Retool's Buzz page)

**The export carries the full grid, and the first pass threw it away.** Retool lays out on a
**12-column grid**: every widget's `position2` has `col`, `row`, `width`, `height`. The extractor now
emits `col`/`width` per widget, which is the whole answer to "was this one column or two". Confirmed
against a live screenshot of `Buzz`, which matches the export exactly.

**`Buzz` → "Buzz Transaction" pane** — a genuine two-column screen:

| | Retool | Ours |
| --- | --- | --- |
| Form (Action, Reason, Type, Amount, Description, EntityType/Id) | `col 0`, width 3–6 | ✅ present |
| `container30` — **Presets** (5 canned workflows, e.g. Stripe Chargeback Retrieval) | `col 7`, width 5 | ✅ present |
| `container29` — **Deduct Types** reference table (Type / Lowers Lifetime Balance / Can Go Negative) | `col 7`, width 5 | ❌ **absent** |
| Three balances **and three lifetimes** (Yellow/Blue/Green) | header | ✅ fixed 2026-08-09 — was 3 balances, 1 lifetime |

- [ ] **Deduct Types is missing.** It is a static reference table telling the moderator which transaction
      types lower the lifetime balance and which can go negative — decision support for the very form
      beside it. Three rows: Purchase, AuthorizedPurchase (can go negative), Chargeback (lowers lifetime,
      can go negative).

**`Buzz` → "View Buzz" pane** — much richer than what was built:

- [ ] Retool had a `Check Buzz` button + **After date** picker, three filters (**Payment Type**,
      **Receipt Type**, **Description**) and **four tables in a 2×2 grid** (`table23`/`table24` at
      `col 0`/`col 6`, then `table53`/`table54` below). Ours is a single unfiltered "Buzz history" list.
      The filters are the dropped-entry-point shape again.

- [ ] **`Bulk Image Manager` is a section of User Lookup's own sidebar** in the live app (visible in the
      screenshot, between "Socials & Bio" and "Buzz"). `sections.ts` deliberately omitted it because
      nothing was ported behind it — that page now exists, so the entry can come back as a link.

**Method note:** this was found by comparing a screenshot to the export, not by reading code. Every
other page's layout is still unchecked, and only `user-lookup-v2` has a re-extracted inventory with
geometry — the other seven exports predate it.

## From the ClickUp ticket and its 13 screenshots (2026-08-09)

**The User Lookup subtask (`868kn6x1b`) carries a requirements list nobody has been porting from.** The
migration has been driven by the JSON exports, which describe what Retool *does*. The ticket describes
what the moderation team *asked for* — including things Retool does badly. Several items match findings
already logged here, which is corroboration from the people who use the tool; several have never been
looked at. Its 13 screenshots are the first look at pages other than Buzz.

Confirmed by screenshot, already logged above, now with evidence:

- **Reports** is two tabs, `Reports Received` / `Reports Submitted`, with a **Status filter** and
  **803 rows** for one account. Ours has no filter, a hard 50-row cap, and one merged list.
- **View Buzz** is **Payments | Receipts side by side** — the ticket's "buzz needs to be split into
  received/sent out" — each with its own type filter, plus a Description filter, an *After date*
  picker, and a **Color** column per transaction. Ours is a single unfiltered list. The ticket also
  says explicitly that 50 entries is too few for support to troubleshoot.

New, not previously logged:

- [ ] **"Talked to a mod" is a red button in the persistent header that opens a `Chats with Mods`
      modal** listing chat ids. The ticket asks for it "clearly at the top".
      **Corrected 2026-08-09:** an earlier draft said we surface prior mod contact nowhere — wrong.
      `ChatContactPanel` shows a chats-count and last-contact warning from `getModContact`. The gap is
      the header placement and the chat-id list, not the signal.
- [ ] **A persistent header across every section**: strike count, "Talked to a mod", subscription tier,
      Force Logout, and username / user id / email fields. Ours puts these inside sections.
- [ ] **An "Enable Edits" toggle guarding editable username/email fields.** The ticket wants this
      limited to some mods — it is the "sub-permissions per app" requirement, and it is an *edit*
      capability we have not ported at all.
- [ ] **Report banners**: a pending/processing `UserReport` and any `CsamReport` should show "very
      clearly at the top", with a way to action/unaction from this page. Related to the
      `CsamReport`-read-nowhere finding above.
- [ ] LoRA training metadata + a clickthrough to the orchestrator dashboard.
- [ ] Multi-select comments to ToS/delete them.
- [ ] Prompts *and blocked prompts* list; editable socials & bio; mod notes that wrap.

⚠️ **The ticket body contains a live Freshdesk API key in plaintext.** It is in ClickUp, not in this
repo — do not copy it here. It should be rotated and replaced with an env var reference, and this
finding kept out of any public doc beyond this sentence.

**Method note:** every one of these came from a screenshot or the ticket text, not from code review or
the export. The exports describe behaviour; they do not describe what was asked for, and they only
describe layout once re-extracted.

## tabbedContainer14, resolved 2026-08-10

Recorded as UNVERIFIABLE for two days because the note never said what its panes were. Re-extracted from
the committed raw export: it is a **Paddle account-linking workflow**, three panes —
`1. Find Account` (`textInput15` "Enter Paddle Customer Id" → `table71`), `2. Remove an old
paddleCustomerId account` (`textInput14` "Enter User Id" → `button95` "Remove Link"), and
`3. Link Paddle Account` (`textInput12`).

- [ ] **Not ported, and deliberately not built without a decision.** Two of the three panes WRITE to a
      billing identifier on `User`, which is a different risk class from the rest of this page. The
      lookup pane alone is harmless; the link/unlink pair needs someone to say whether the spoke should
      own it at all. `paddleCustomerId` is already read and shown on the identity panel.

## Cross-cutting

1. **Report `details` is dropped on every page that shows reports** — User Lookup, User Reports, Chat
   Audit, Image Lookup. The reporter's own words never reach the DOM anywhere in this app.
2. **`getReports` applies status/reason filters only when passed**, silently returning all history
   otherwise. Chat Audit was the first caller to trip on it. A required parameter, or an explicit
   `'all'` sentinel, would make the next omission a compile error rather than a wrong number.
3. **Columns selected but never rendered** is the single most repeated defect — prompts, flags,
   `blockedFor`, notification bodies, report details. Fetching costs a query; dropping it costs a
   moderator deciding blind.
