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

## Front Page Audit: port state (canonical)

**This block is the single source of truth for which Front Page Audit writes exist.** It is stated here
and *linked* from everywhere else — `MIGRATIONS.md`'s table row and its §B verification list, and the
08-19 feedback round. It used to be restated in each of them, and it went out of step with reality twice
on 2026-08-20 alone: both times a write was built and two of the four copies still called it unported.
If you change what is ported, change this block; do not re-describe it elsewhere.

| Retool write | State |
| --- | --- |
| `FrontPageTimers` (shared resume point) | **Built** 2026-08-20 — read by `getSweepCheckpoint`, advanced by "Mark swept up to here". Unverified in a browser. |
| `research_ratings` (`InsertRatingGame`) | **Built** 2026-08-20 — Retool's upsert verbatim; unfreezes Queue Stats' "Research ratings" board. Unverified in a browser. |
| `RatingChanges` (`LogNsfwLevel` + `LogNsfwLevel2`) | **PORTED 2026-08-21**, and the description here was wrong twice — both corrections came from the app export (`raw/front-page-audit.json`, plugins → LogNsfwLevel / LogNsfwLevel2), not from more reasoning. (1) **`LogNsfwLevel` is not an INSERT.** Both writes are `UPDATE_OR_INSERT_BY` keyed on `imageId`, so the table holds the LATEST change per image, not a history of every change. (2) **`originalRating` is the sweep's selected rating** (`selectedAge.value`), not a lookup of the image's own previous level — on this page they are the same number, because the sweep query is `where i.nsfwLevel = <selected>`. `LogNsfwLevel2` records the TAG's `nsfwLevel` as the rating and is disabled on a downvote (`vote === -10`), which is the "additions only" rule. Both live in `front-page-audit.service.ts`; `rating-changes.test.ts` pins the upsert and the additions-only rule, both mutation-checked. **Unexercised against a database.** |

Consequence still open: `recordModActivity` stores no before/after, so "who changed this image from X
to XXX" is answerable for the Retool era and not for ours.


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

## User Lookup v2 — 14 findings, 12 fixed (reconciled 2026-08-10)

- [x] **Account history was logins only.** Retool filtered `AND NOT type = 14`; the port dropped it.
      31.6M Login rows against 62k Muted / 48.6k Banned, so a 50-row window is ~49 logins and a
      thrice-muted account showed no enforcement history at all.
- [x] **The ban confirmation claimed images are removed. They are not.** `toggleBan` blocks media only
      when `removeMedia === true` or the reason is `SexualMinor`; the port never sends it. Copy
      corrected — a `Nudify` ban leaves every image up.
- [x] **Reports-they-filed drops most of them** and contradicts its own total tile: the port
      inner-joins the six content report tables, so reports filed against *accounts* (the commonest
      kind), collections, bounties, reviews and chats vanish — while `getReportsFiled` counts the
      unjoined total. "Total 12" beside 4 rows.
- [x] **`report-sources.ts` lists 6 entity types; Retool's `ReportsReceived` UNIONed 11.** Bounty,
      BountyEntry, Collection, ResourceReview and chat reports are invisible. A user repeatedly
      reported over a collection reads as a clean account. Affects counts and rows identically.
- [ ] **`UserRestriction` is read nowhere.** A system auto-mute (prohibited-prompt volume) deliberately
      leaves `mutedAt` NULL, so it renders as a muted account with no reason and no activity. Unmuting
      from here also skips the Overturn path — the restriction stays `Pending`, the subscription is not
      reinstated, the user is never told.
- [x] `CsamReport` read nowhere — an account with a CSAM report filed against it looks clean
- [x] Moderation Activity omits `ReToolActions`. **Cannot be joined**: that table records App/User/ActionType with NO subject id, so it is a run-level log, not per-account history. Fixed the false claim instead — the empty state now says pre-migration Retool actions are not recorded per-account rather than "no recorded moderator activity"
- [x] Model/comment breakdowns (`NumTos`, `NumPoi`, `NumNSFW`, `NumLocked`, `NumDeleted`,
      `NumTOSViolations`, `NumHidden`) collapsed to a single `COUNT(*)`
- [x] Reviews can be deleted without their text (`details`) ever being shown
- [x] Report `details` / `internalNotes` shipped to the browser and never rendered — the reporter's own
      words are the only part saying what happened
- [x] Notification `details` dropped — the panel captioned "context for 'I was never warned'" renders
      announcements with no message
- [x] `setRewardsEligibility` has no UI, and as wired it cannot succeed (`callMainApp` sends query-string
      params; the endpoint reads `req.body` and requires `modId`)
- [x] Report list has no status/reason filter and a hard 50-row cap where Retool had none
- [x] Timed-mute presets (6/12/24/48/72/168) still a free-text hours box

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
- [x] The suspect's history datasets were "shipped in User Lookup" — true of the datasets, false of
      this page. Strikes and now **notes** render here beside the strike form, which is where they
      change a decision. Mod activity and received reports were also deep links at first and are now
      inline too (2026-08-12, widened 2026-08-21) — see the User Reports section of
      [`retool-parity-checklist.md`](../retool-parity-checklist.md). `ReToolActions` has no subject key,
      so it cannot be shown per-account anywhere.
- [x] `ReportHistory` 300 → 100
- [x] Pagination links drop the `user` param, closing the suspect drill-down

## Found 2026-08-10 while resolving the two unidentified Buzz tables

- [x] **The Buzz ledger showed bank rows to everyone.** `table23`/`table24` bind to
      `admin || <two hardcoded names> ? Payments.data : formatDataAsArray(Payments.data).filter(i => i.type !== 'bank')`
      — so ordinary moderators did NOT see `type = 'bank'` transactions. The restriction lived in the
      table's **data binding**, not in a query or a pane's `only visible when`, which is why every pass
      over the queries and the layout missed it and the port widened access without anyone noticing.
      Now gated on `isSenior`; hardcoding names is what left the moderator list stale in three other
      places. Filtered after mapping so `truncated` still describes the real window.
- [ ] `table53`/`table54` are `RecGrouped.value` / `PayGrouped.value` — **grouped** views of receipts
      and payments. Their bodies are NOT recoverable: both appear only as empty `pageCodeFolders`
      entries. Sibling names in that folder (`GroupPayments`, `UngroupPayments`, `PaymentsGroup`)
      suggest a group/ungroup toggle over the same two tables. Needs a screenshot to port.

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

- [x] `tabbedContainer8` — **"Submitted Reviews" / "Received Reviews"** (two tabs, plus filters
      `Excluded?`, `NSFW?`, `TOS Violation?`, `Review Rating`, `Search Review Content`)
- [x] `tabbedContainer9` — **"Bounties" / "Bounty Entries"** (filters `Type`, `Complete`,
      `Name Contains`, `Description Contains`)
- [x] `tabbedContainer10` — **"Reports Received" / …**
- [x] `tabbedContainer12` — **"View Buzz" / "Buzz Transaction"**, and the second pane is gated on
      `current_user.groups.some(i => i.name === "Senior Mod")`. **This gate exists in no query.** If
      buzz sending is reachable by every moderator here, it is a capability that was senior-only in
      Retool.
- [x] `tabbedContainer14` — 3 panes; resolved by re-extract, see its own section below

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

- [x] **Deduct Types is missing.** It is a static reference table telling the moderator which transaction
      types lower the lifetime balance and which can go negative — decision support for the very form
      beside it. Three rows: Purchase, AuthorizedPurchase (can go negative), Chargeback (lowers lifetime,
      can go negative).

**`Buzz` → "View Buzz" pane** — much richer than what was built:

- [ ] Retool had a `Check Buzz` button + **After date** picker, three filters (**Payment Type**,
      **Receipt Type**, **Description**) and **four tables in a 2×2 grid** (`table23`/`table24` at
      `col 0`/`col 6`, then `table53`/`table54` below). Ours is a single unfiltered "Buzz history" list.
      The filters are the dropped-entry-point shape again.

- [x] **`Bulk Image Manager` is a section of User Lookup's own sidebar** in the live app (visible in the
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

- [x] **"Talked to a mod" is a red button in the persistent header that opens a `Chats with Mods`
      modal** listing chat ids. The ticket asks for it "clearly at the top".
      **Corrected 2026-08-09:** an earlier draft said we surface prior mod contact nowhere — wrong.
      `ChatContactPanel` shows a chats-count and last-contact warning from `getModContact`. The gap is
      the header placement and the chat-id list, not the signal.
- [x] **A persistent header across every section** (Force Logout stays in Admin — it is an action, and the header is not a form): strike count, "Talked to a mod", subscription tier,
      Force Logout, and username / user id / email fields. Ours puts these inside sections.
- [x] **An "Enable Edits" toggle guarding editable username/email fields.** The ticket wants this
      limited to some mods — it is the "sub-permissions per app" requirement, and it is an *edit*
      capability we have not ported at all.
- [x] **Report banners** (open UserReport is now a banner with a link to the queue; CSAM is a header badge): a pending/processing `UserReport` and any `CsamReport` should show "very
      clearly at the top", with a way to action/unaction from this page. Related to the
      `CsamReport`-read-nowhere finding above.
- [ ] LoRA training metadata + a clickthrough to the orchestrator dashboard.
- [x] Multi-select comments to ToS/delete them.
- [x] Prompts *and blocked prompts* list; editable socials & bio; mod notes that wrap.

⚠️ **Ticket bodies for this migration carry credentials in plaintext.** Nothing has reached this repo
and nothing should: quote the behaviour, never the value, and use an env var reference. Specifics
belong in the private infra repo — naming the vendor and the ticket here would be an inventory of
where to look, which this repo's security rules put off-limits.

**Method note:** every one of these came from a screenshot or the ticket text, not from code review or
the export. The exports describe behaviour; they do not describe what was asked for, and they only
describe layout once re-extracted.

## tabbedContainer14, resolved 2026-08-10

Recorded as UNVERIFIABLE for two days because the note never said what its panes were. Re-extracted from
the committed raw export: it is a **Paddle account-linking workflow**, three panes —
`1. Find Account` (`textInput15` "Enter Paddle Customer Id" → `table71`), `2. Remove an old
paddleCustomerId account` (`textInput14` "Enter User Id" → `button95` "Remove Link"), and
`3. Link Paddle Account` (`textInput12`).

- [x] **NOT PORTING — removed 2026-08-21.** Built as a `linkPaddle` form action, then removed
      along with every other Paddle reference on the page: Civitai no longer uses Paddle, so there is
      no customer id worth linking. Nothing replaces it.

## Cross-cutting

1. **Report `details` is dropped on every page that shows reports** — User Lookup, User Reports, Chat
   Audit, Image Lookup. The reporter's own words never reach the DOM anywhere in this app.
2. **`getReports` applies status/reason filters only when passed**, silently returning all history
   otherwise. Chat Audit was the first caller to trip on it. A required parameter, or an explicit
   `'all'` sentinel, would make the next omission a compile error rather than a wrong number.
3. **Columns selected but never rendered** is the single most repeated defect — prompts, flags,
   `blockedFor`, notification bodies, report details. Fetching costs a query; dropping it costs a
   moderator deciding blind.

---

# Second fidelity pass (2026-08-20)

`retool-fidelity-review` re-run on the six apps with no agent-run on record: **User Lookup v2, Chat
Audit, Image Lookup, Article Lookup, User Reports, Front Page Audit**. The first pass above was largely
hand-run and predates the agent.

Every claim below was checked against the code before being recorded; several of the agents' findings are
**not** here because they did not survive that check. Nothing here is verified in a browser.

## Fixed in this pass

- [x] **Image Lookup — a pasted CDN URL could never match a full-URL row.** `where('url', '=', uuid ?? value)`:
      a full URL contains a UUID, so `uuid` was always truthy and the raw string was never tried — the
      exact case the adjacent comment said the fallback existed for. Such rows are ~0.003% of `Image`
      (2 of 57,852 sampled), and they reported "no image matches", which on that page reads as *deleted*.
      Now tries both spellings.
- [x] **Image Lookup — the POI/minor write was gated on the page's own path**, which `hooks.server.ts`
      has already checked, so it was no gate at all. Bulk Image Manager and User Reports gate the identical
      `setImageFlag` call on `/users`. An Image Lookup grant alone conferred a write the other two
      withhold. Now `/users`.
- [x] **User Reports — "Nothing recorded against this account" was false for the whole Retool era.**
      The page called `getModActivity` alone; `ModActivity` keys on content and did not exist for those
      years. `getRetoolActivity` was already built and `/api/user-mod-activity` already returns the pair —
      this page called one of the two, on the screen where the strike is issued. Both now render, kept
      visually apart (the Retool rows carry a display name, not a moderator id).
- [x] **User Reports — "Reports received … Never reported before this one"** was `UserReport` rows only:
      reports against the *account row*, not against content the account owns. "Reports received" is the
      established name of the 11-way content union (`getReportsReceived`), so the label asserted the
      stronger claim. Relabelled "Account reports", and the empty state now says content reports are not
      counted here.
- [x] **Chat Audit — the "Newest" feed lost its content search** (Retool's `textInput2`). The panel's
      stated job is watching spam as it happens, bodies are collapsed by default, and there was no filter,
      so there was no way to find the spam string. `ListFilterBar` added, matching the sibling panel.
      Filtering reveals no text: a match still needs "Show message text".
- [x] **Article Lookup — `Article.cover` dropped, so legacy-cover articles showed "Cover image —".**
      Two cover columns exist; the port selected only `coverId`. 7 of 26,505 articles carry only the old
      one, and for those the page denied the existence of the image its headline badge derives from. Two
      other services in this repo already treat `cover` as a live fallback.
- [x] **Article Lookup — `moderatorNsfwLevelBasis` dropped** (set on 360 articles). It is what says whether
      an override may be auto-cleared. Now shown, but only under an active override.

## Chat reports — resolved, with a third answer

- [x] **User Lookup — chat reports were scoped to `Chat.ownerId`, whoever *created* the conversation.**
      First read of this said the data could not settle it and it needed a decision. That was too
      pessimistic: `Report.userId` names the reporter, and excluding them is what makes the question
      answerable. The rule now lives in `chatReportSubject` (`report-entities.ts`) and both the count
      tile and the rows list use it — **the reported party is the chat member who is not a reporter, in
      a two-party chat; group chats match nobody.**

      Why the two obvious answers are both wrong, and why this one is not:

      | Reading | Result on production |
      | --- | --- |
      | `Chat.ownerId` (what shipped) | Wrong for **118** reports where the owner is the reporter — the complainant was credited and the account complained about showed zero. Also counted `Automated` reports, which the rows list filters out. |
      | Any message author (Retool `query152`) | Always includes the reporter, so every harassment report also marks the **victim** as having reported content. |
      | Non-reporter participant, two-party only | **2,219 of 2,241** human-filed reports (99.0%) resolve to exactly one account — verified one accused per report, no double counting. The 17 group-chat reports are deliberately unattributed. |

      The scale of the old bug is larger than the mis-attribution alone: **11,056 accounts were
      over-counted** (worst by 269), because the tile counted the 59,555 `Automated` reports (96% of all
      chat reports, filed by user `-1`) that the rows list never showed — the exact count/rows
      disagreement that function's comment says it exists to prevent. **93 accounts were under-counted.**

      All figures measured against production 2026-08-20 and recorded in the function's docstring.

## Open — real gaps, not yet built

> Ticked 2026-08-20: 11 of these 13 were closed the same day and one did not survive verification —
> see "Open gaps closed" below for each. The finding text is kept as the record of what was wrong.
> Only `RatingChanges` remains open.

- [x] **Front Page Audit — the Split control on Queue Stats writes a resume point nothing reads.**
      `queue-stats` inserts fork rows into `FrontPageTimers`/`_catchup` and tells the moderator a fork
      happened; `/retool/front-page-audit` reads neither table (its window is a fixed `hours` dropdown).
      The two pages state contradictory things about the same mechanism.
- [x] **Front Page Audit — `LogTimestamp`'s column list is NOT missing from the export.** The recorded
      reason for leaving three writes unported ("GUI-mode writes whose column lists the export does not
      carry") does not survive reading `raw/front-page-audit.json`, which has all three changesets
      verbatim. `numberOfImages` is typed as of the schema introspection.
- [x] **Front Page Audit — `InsertRatingGame` unported, and Queue Stats renders the frozen result.**
      "Research ratings — All time" sits directly beside "Ratings set", which is `ModActivity`-backed and
      still counts. One list grows, the other cannot, with nothing on screen saying why.
- [ ] **Front Page Audit — `RatingChanges` is two writes, not one.** `LogNsfwLevel` (on rating: records
      the set level *and* the swept level) and `LogNsfwLevel2` (on tag vote: additions only, level from
      the tag). The audit called them duplicates of each other.

      **`LogNsfwLevel` built 2026-08-21** — `recordRatingChange` in `front-page-audit.service.ts`, called
      from `setRating` after the rating commits, best-effort like `recordResearchRating` beside it. The
      old level is read *before* the update, because that pair is the whole value of the row.

      **`LogNsfwLevel2` stays open**, and not for the reason recorded: the table shape is known and now
      generated. What is missing is what `originalRating` — NOT NULL — holds on the tag-vote path. That
      needs the changeset, not more reasoning.
- [x] **Front Page Audit — the sweep's coordination mechanic is absent**: no shared checkpoint, no "who
      swept this last". Two moderators sweeping the same rating work the same rows. The page discloses
      this; the Split control above now contradicts the disclosure.
- [x] **User Lookup — `ActionReport` absent, with no navigation path either.** Report rows render
      read-only with no link out, and `/reports/[slug]` filters by *reporter*, not by reported account,
      and has no report-id anchor. The recorded mitigation ("act on it in /reports") overstates what is
      reachable.
- [x] **User Lookup — timed mutes lost arbitrary durations and scheduled start.** Retool had `muteStart`
      and `muteEnd` datetime widgets *plus* presets; the build has the six presets only, and always starts
      now. The server accepts up to 8760 hours, so the UI is the constraint. Three hours, two weeks, or a
      mute beginning when an event does are all unexpressible.
- [x] **User Lookup — `UserSubscriptionStatusAnnual` absent.** `Price.interval` is never selected, so a
      moderator handling a refund cannot tell an annual plan from a monthly one — the fact that decides
      the amount.
- [x] ~~**User Lookup — notification depth fixed at 25.**~~ **FALSE** — see "Did not survive
      verification" below; the 25/50/100/200 picker exists and `?limit=` is honoured to 200.
      record left. `ownerId` differs from the current `Image.userId` after a transfer.
- [x] **Image Lookup — `Image.meta` survives only as `prompt`/`negativePrompt`.** Retool showed the whole
      cell, so seed, sampler, model hash and `civitaiResources` were readable. `scanJobs` already gets a
      raw `<details>` on the same panel; `meta` could take the same treatment.
- [x] **Image Lookup — the vote-ring panel narrowed two Retool tables into one signal** and prints
      "nothing suggesting a ring" over a set filtered by `Image_Create`, an internal-CIDR exclusion and a
      `createdAt` bound. One-account-many-IPs and the full IP ranking are both gone, and the internal-range
      exclusion appears in no divergence list.
- [x] **User Reports — mod notifications have no click-through.** `sendModNotification` takes a `url`,
      documented as what `system-announcement` renders as the click-through; **no call site anywhere passes
      it** — not User Reports, not User Lookup, not Bulk Image Manager. Retool sent `/safety`.

## Process findings

- [ ] **Chat Audit and Image Lookup have no `-audit.md` classification file.** They are the only ported
      apps without one. Nothing records what was deliberately dropped, which is why most of their findings
      are widget-level rather than SQL-level.
- **Audit rows corrected in this pass**, recorded so they are not re-trusted: Image Lookup's tracker entry
  claimed "read-only" (it writes POI/minor); Chat Audit's claimed `TopChats` was not ported (it is, as are
  `TopChats24` and `TopChatters24`); User Lookup's audit lists `ToggleMod`, the strike cluster and most of
  "cluster A" as blocked or missing when all are built, files `query152` and `alternateAccount` as plumbing
  when both are real queries, and classifies `AvailableCosmeticList` twice contradictorily; User Reports'
  audit maps `UserQuery`/`UserQuery5000` to `resolveUserId` when both are the image grid, and files
  `TOSImages` as `port` when the export annotates it `//doesnt run anywhere, just a test`; Front Page
  Audit's audit calls `LogNsfwLevel`/`LogNsfwLevel2` duplicates and counts `ByReactions` in two buckets.
  Article Lookup's and User Reports' audits both still ask for a re-extract that already happened.

---

# Open gaps closed (2026-08-20, same day)

Working through the "Open — real gaps" list above. Each was re-verified against the code before being
acted on; two did not survive that check and are corrected rather than fixed.

## Did not survive verification

- **"Notification depth is fixed at 25" — FALSE.** `NotificationsPanel.svelte` has a Retool-equivalent
  "Number of Notifs" picker (25/50/100/200) and `/api/user-notifications/[userId]` honours `?limit=` up
  to 200. The claim came from reading the service's default parameter (`limit = 25`) as a hardcode. The
  "show me the last 200" case it said was impossible is directly supported.
- **"Timed mutes lost arbitrary durations" — half true.** Presets-only was a deliberate, commented
  choice ("a free-text hours box invites 240 where someone meant 24"), not an oversight. The *gap* was
  real, so it is fixed below — but as a date picker, which was Retool's `muteEnd` and does not
  reintroduce the hazard the presets exist to avoid. **Scheduled START (`muteStart`) is still not ported.** Not for the reason
  given here — expiry works (`processTimedUnmutesJob`, hourly, since 2026-08-12) — but because there is
  no `muteStartsAt` column to write, so a scheduled start is a schema change plus a second job.

## Fixed

- [x] **Mod notifications had no click-through.** `sendModNotification` took an optional `url` that
      **no call site anywhere passed**, so every moderator-authored notification shipped as dead text.
      Now defaults to `/safety` — Retool's own destination, and what the footer, image detail and
      training upload all link to — with an explicit override still available.
- [x] **`UserSubscriptionStatusAnnual`.** `Price` is now joined into the one subscription query, so
      `interval` (plus `unitAmount`/`currency`) reaches the panel. Annual vs monthly is what decides a
      refund amount, and Retool kept a whole second query for it.
- [x] **Timed mutes: arbitrary end.** An "Until…" option beside the six presets, taking a datetime.
      The action accepts `hours` OR `until`, and refuses a time already past — `datetime-local` carries
      no timezone, and a mute that lifts the instant it is applied reads as a silent failure.
- [x] **Image Lookup: the lifecycle log dropped four columns Retool showed.** `ownerId` (owner at the
      time — differs from the current `Image.userId` after a transfer), `nsfw` at the event, `resources`
      and the request provenance (`ip`, `userAgent`, `via`) are all selected and rendered. Verified
      against `system.columns` rather than inferred: every one exists on `default.images`.
- [x] **Image Lookup: the lifecycle log's time bound is removed.** It was applied on the reasoning that
      it "costs nothing", but it could not gain anything either (8.2M rows, ~400ms unbounded) and could
      only lose rows — and the truncation banner fires on the LIMIT, not the bound, so an exclusion
      would have been silent. On the deleted path the oldest event is the original `DeleteTOS`.
- [x] **Image Lookup: `Image.meta` beyond the two prompts.** The rest of the cell — seed, sampler, model
      hash, `civitaiResources` — now renders in a `<details>`, the same treatment `scanJobs` already got.
      Retool showed the whole cell.
- [x] **Image Lookup: the vote-ring panel's negative claim.** "Nothing suggesting a ring" was asserted
      over a set narrowed three ways the reader could not see. It now says what it counted, and that one
      account reacting from many addresses is not a shape it looks for.
- [x] **User Lookup: `ActionReport` had no navigation path.** `getReports` takes a `reportId`, and
      `/reports/[slug]?report=<id>` opens that one report with its filters forced to `all` — a report
      linked from elsewhere is usually already handled, and the default Pending+Processing view would
      have rendered an empty list, which reads as "that report does not exist". Every report row on
      User Lookup now links to where it can be actioned.
- [x] **Front Page Audit: `InsertRatingGame`.** Every rating set on the sweep writes `research_ratings`
      again, using Retool's upsert verbatim including the conflict target (`research_ratings_pkey` is
      `(userId, imageId)`, confirmed against production). Best-effort: the research dataset must not be
      able to fail the moderation action it describes. This unfreezes Queue Stats' "Research ratings"
      board, which sat beside a `ModActivity`-backed board that never stopped counting.
- [x] **Front Page Audit: the shared resume point.** `FrontPageTimers` is now read as the sweep's start
      and advanced by a "Mark swept up to here" button — Retool's green Log. The checkpoint sets
      `lastCheckedAt` to the `createdAt` of the last row swept, never `now()`: the sweep is oldest-first,
      so anything posted while the moderator worked has not been looked at. Disabled on the reactions
      ordering, as Retool disabled it, because that view ranks by popularity and its last row is not a
      position in a queue. An explicit `?hours=` still overrides, for looking outside the checkpoint.

      This also settles the contradiction: Queue Stats' Split control has been forking
      `FrontPageTimers`/`_catchup` all along and telling the moderator so, while the sweep read neither
      and the page said the resume point "is not ported yet". Both are now true statements.

## Still open

- [ ] **`RatingChanges` (`LogNsfwLevel` + `LogNsfwLevel2`) — unblocked, not built.** The credential
      blocker is gone: the table's columns were confirmed 2026-08-20 and match the export's changesets
      (see the canonical block above). This is now ordinary porting work. Until it lands,
      `recordModActivity` stores no before/after, so "who changed this image from X to XXX" stays
      answerable for the Retool era and not for ours.
- [ ] **`numberOfImages` on `FrontPageTimers`.** **Confirmed to exist** (integer) 2026-08-20, and typed
      since the schema introspection, so `markSweepChecked` can write it. Not blocked, and no type work left.
- [ ] **Scheduled mute start.** Not blocked on a cron — expiry runs hourly (`processTimedUnmutesJob`).
      There is no `muteStartsAt` column, so this is a schema change plus a second job. Confirm anyone
      wants it before building.

## Review pass on the fixes (2026-08-20)

Four agents over the diff — correctness, Svelte idiom, abstraction, comments. Everything below was
verified against the code or production before acting.

🔴 **The chat-report predicate shipped wrong and is now fixed.** `chatReportSubject` required the
subject to be a non-reporting member of a two-party chat but **never required the reporter to be a
member at all**. `Automated` reports are filed by user `-1`, who is in no chat, so both parties passed
every clause — and those are 96% of the table. Measured: **121,148 attributions across 20,452 accounts**
instead of 2,226 across 1,186. Every account that had merely *received* an auto-flagged DM read as
having reported content — the exact harm the predicate was written to avoid, at fifty times the scale of
the bug it replaced. The docstring asserted the opposite ("they match nobody here") and that assertion
was never tested. One extra `EXISTS` fixes it; the clause is now marked as load-bearing so it is not
dropped as redundant.

Also fixed from the same pass:

- **Mark-swept could advance the SHARED point from a private window**, discarding everything between —
  a moderator on a 24h window whose shared point was five days back would silently drop four days.
  The action now requires the sweep to have started from the checkpoint and refuses a backwards move.
- **The video sweep (20 rows) shared the image sweep's checkpoint (200 rows)**, so marking it skipped
  every image in the same span. Checkpoint is now scoped to the newest-first *image* sweep only.
- **The checkpoint banner rendered over the reactions ordering**, which ignores the window entirely.
- **`Sweep` always wrote `hours` into the URL**, so the first press permanently abandoned the shared
  resume point — the feature was reachable only on a bare landing.
- **The banner rendered the Split control's `splitQueue` sentinel as a moderator's username.**
- **`?report=` echoed the default filter chips** over a list that ran unfiltered, so an Actioned or
  Automated report appeared under chips claiming Pending+Processing.
- **`datetime-local` mute end resolved in the server's timezone**, not the moderator's — 23:00 local
  became 23:00 UTC. The client now submits the resolved instant.
- **Chat Audit's "Newest" filter looked like the site-wide search** but filters the loaded 100; the
  label and empty state now say so and link to the real search.
- `ShowMoreButton`'s `capped` was inverted under an active filter; the Moderation-activity heading
  counted one of the two lists it rendered; the lifecycle metadata line rendered as an empty row when
  every field was absent.

Four comments were **false** and are corrected: the "not yet ported" note above the code that ports it,
the `ownerColumn: null` doc (no longer "the one type"), an "11-way union" that is now 14, and a claim
that every `sendModNotification` call site omitted `url` when User Lookup passes it.

### Known and not fixed

- **`getRetoolActivity` matches a bare number in free text** (`"ActionType" ~ '\y<id>\y'`), so an
  imageId or a Buzz amount can match an unrelated account. Pre-existing, but this pass put it under a
  heading on the strike screen and folded it into the count. Needs a look at real `ReToolActions`
  phrasings — no `RETOOL_DATABASE_URL` in this checkout.
- **The lifecycle log's `ip`/`userAgent` are the ACTOR's**, and on `Delete`/`DeleteTOS`/`Restore` rows
  that is a moderator. They render unlabelled beside the owner link; a ban-evasion hunt could
  misattribute a colleague's address. Label or suppress on those types.
- **`nsfw` on lifecycle events is the deprecated `None/Soft/Mature/X/Blocked` vocabulary**, and its `X`
  is not today's X. Rendered raw, so a 2024 event reads as a current rating.
- **`chatReportSubject` counts `ChatMember` rows of every status**, including `Left`/`Kicked`. Exactly
  one human-filed report is lost to this today; a future "leave conversation" flow would make it worse.
- **`front-page-audit/+page.svelte` is ~340 lines** and holds three panels. Split as siblings.
- **`user-reports.service.ts` builds the same report query four times**, and `ReportQueryOptions.reasons`
  is honoured by only one of the three exported readers while being documented for all.
- **`UserReportRow.entityType` carries a display LABEL, not the enum**, so `entityUrl` already produces
  dead links for ResourceReview / ComicProject / Model3D on User Lookup while working on `/reports`.
  Carry `type: ReportEntity` and `reportActionPath`'s reverse map disappears with it.
- **`FrontPageTimers` is read and written by two services** with private understandings of the row
  semantics. One `front-page-timers.ts` owning both, plus the sentinel, is the fix.

### Review follow-ups closed

- [x] **Dead links on User Lookup's report rows.** `UserReportRow.entityType` carried a display *label*,
      and both `entityUrl` and `reportActionPath` reverse-mapped it — but 'Review' / 'Comic' / '3D Model'
      do not lowercase to `resourceReview` / `comicProject` / `model3d`, so those three types rendered as
      grey text here while linking fine on `/reports`. The row now carries `type: ReportEntity` beside the
      label, and `reportActionPath`'s reverse map is gone rather than being a third map of one fact.
- [x] **Four copies of the report query in one file**, which had already drifted: `reasons` was
      documented for all three readers and honoured by one. One `reportBase` builder now owns the joins
      and both filters.
- [x] **`FrontPageTimers` owned by two services** → `front-page-timers.ts` owns the tables, the
      `splitQueue` sentinel and both resume points. Queue Stats re-exports the split API for its callers.
      The unused `stream: 'catchup'` parameter is dropped rather than left as a half-built path.
- [x] **`front-page-audit/+page.svelte` was 340 lines / three panels** → 216, with `SweepFilterBar` and
      `SweepCheckpointBar` as siblings. The window picker now hides while the shared point is in force,
      instead of displaying a window that is not running.
- [x] **Lifecycle-log labelling**: `ip` reads "from <ip>" and is documented as the ACTOR's (a moderator
      on Delete/Restore rows), and `nsfw` reads "legacy rating" — its vocabulary is the deprecated
      `None/Soft/Mature/X/Blocked`, whose `X` is not today's X.

⚠️ **Do not narrow `chatReportSubject` to `ChatMember.status = 'Joined'`.** It looks like a tightening
and drops the result from 2,226 to 751: the recipient of an unsolicited DM is usually `Invited`,
`Ignored` or `Left`, which is exactly the harassment case the predicate exists to find. Recorded in the
docstring.

### `getRetoolActivity` matched image counts, not just user ids — fixed 2026-08-20

`ReToolActions.ActionType` is free text and **56% of its 132,041 rows carry more than one number**
(`ToS 5 images from <id>`, `Strike 2 on user <id>`, `Banned 47 accounts`, `ToS N images from modelId
<id>`). The predicate was a bare word-boundary match on the id, so every image count and strike number
was attributed to whichever account shared that value:

| Probe user id | Rows matched (bare `\y<id>\y`) | Rows matched (subject-anchored) |
| --- | --- | --- |
| 1 | 22,130 | 0 |
| 2 | 7,289 | 0 |
| 5 | 2,331 — 2,204 of them `ToS 5 images…` | 0 |
| 100 | 438 | 0 |
| real 6–7 digit subject ids | 7 / 5 / 6 | 7 / 5 / 6 — identical |

**101 accounts have an id under 100**, and this session had just put the result on the User Reports
strike screen and folded it into the "Moderation activity" count. The id must now follow a subject label
(`from `, `User `, `UserID `, `on user `, `for user `, `to (`). `from ` requires digits immediately
after, which is what excludes `from modelId <id>` — a model, not the account.
