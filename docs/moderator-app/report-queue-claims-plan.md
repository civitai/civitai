# Report queues: parking, presence, second opinions — and later claims and escalation

**Status:** plan, revised 2026-10-16 after mod feedback (below). The page standard (§2) is done (45a3e3ca87). Nothing else is built. Next: Pending-only default, parking, presence, second opinions (§11). Claims, work mode and skip (§3–5) are **deferred**; escalation (§6–7) is **later**, built on the second-opinion table. Open questions are at the top of §10.

Two pieces of work that turned out to be one:

1. **A standard for non-table report pages.** `/reports/user` and `/reports/model` were rebuilt as a
   queue layout with the open item in the path. More types will follow. Before that, the two pages
   need to agree on one shape (§2).
2. **Splitting `Processing`.** It is used for two things: "a moderator is on this", which it can't
   do (no owner, no expiry, blocks nobody), and "this is waiting on something", chiefly an ownership
   claim under investigation. The second **stays Processing** — shown as parked, with a note and an
   age alert (§8). The first was going to move to a live **claim**, with **skip** and **escalation**
   beside it; after asking the mods, it moves to lighter **presence** (§2a) and a **second opinion**
   (§2b) first, with claims kept on file (§3–5).

---

## Mod feedback, 2026-10-16 — what it changed

Briant asked the mods four questions in the mod channel before building any of this (2026-10-16):
whether they run into each other, what they do when unsure, whether they leave reports for someone
more experienced, and whether they can tell who is on a Processing report and why. Three answered —
Daz, dolirama126 and CHESHIRE.

| Need | Daz | dolirama126 | CHESHIRE | Plan before |
|---|---|---|---|---|
| Running into another mod | "Not really" — maybe once, possibly the buttons | "No, not recently" | "A couple times recently" — clicks a report and it says already actioned; "isn't a huge issue". Suggests a blue dot or highlight when a queue was worked recently | Claims + work mode (§3–4) |
| Unsure how to rule | Processing if it needs evidence; asks in Discord or DMs a mod he knows is on for a second opinion. "From time to time" | On their own queue, leaves it a day or two, then rules themselves | Asks for a second opinion; complex user reports passed on with their own notes on what to look into | Skip (§5), escalation (§6) |
| Leaving it for someone else | Leaves it, pings if it isn't picked up. "Something we need to become better at" | Own queue: rules in the end. Other queues: picks what to do | Fence-sitters and serious-but-vague ones. Suggests a **tentative decision** the next mod sees | Escalation (§6–7) |
| Who is on a Processing report, and why | No way to see. Writes a note signed "~Daz" by hand. Some take ages — waiting for a pattern of behaviour | Can't tell. Found Pending/Processing user reports from 2023/2024, some with tens of reports | "Tons" sit in Processing; "there isn't usually a clear indication as to why" | Parking (§8) |

What follows from it:

1. **Parking is wanted by everyone** — all three can't see why something is in Processing, and Daz
   already does parking by hand. It moves up to straight after the Pending-only default (§11).
2. **Collisions are rare and minor.** One of three has hit them, and asked for a signal, not a lock.
   Claims, work mode and skip are **deferred**, not dropped (§3–5 stay as written). In their place,
   **presence** (§2a): who is looking at an item right now, shown on its row and on the item.
3. **Handing on happens, informally.** Second opinions go through Discord and pings, and slip.
   CHESHIRE's "tentative decision" is the shape: a **second opinion** (§2b) — a suggested ruling with
   a note, visible to the next mod, in a table that escalation later reuses. The senior grant, the
   Escalated view and automatic escalation (§6–7) wait until second opinions show reports that need
   a senior and don't get one.

Also raised, outside this plan: reported **collections** are a needle in a haystack to review
(Kesler42), and dolirama126 found the stale 2023/2024 user reports the overdue alert (§8) is for.

---

## 1. What Processing does today

- **As a claim, nothing sets it any more.** New reports start Pending
  (`src/server/services/report.service.ts:270`, `:490`). The moderator app stopped claiming on
  2026-08-21 (`d489795468`). The 404 Processing user reports were all set more than 30 days ago.
- **As a hold, it is still in use.** Moderators set it on model reports while an ownership claim is
  investigated, which can take weeks (confirmed, §10 Q17). That's why the model queue still offers it.
  The report already has what a park needs — `internalNotes` for what is awaited, `statusSetAt` and
  `statusSetBy` for since when and by whom — but nothing shows them together, and nothing flags one
  left too long, so a live investigation looks the same as an abandoned claim.
- **It costs.** Every queue's default view is Pending + Processing, so the stale rows sit in every
  queue. The sidebar badge counts Pending only — which is why the badge and `/reports/user` disagreed.
- **It can't be a claim.** It has no owner and no expiry, so an abandoned claim is permanent. It
  doesn't block anyone. And it writes to the report itself, where status changes have side effects
  (Actioned pays the reporters).

---

## 2. The page standard (the base this builds on)

What `/reports/user` and `/reports/model` now share:

| | Standard |
|---|---|
| **Route** | `/reports/<type>` is a layout holding the queue. `/reports/<type>/<id>` (plus `/<tab>` where there are tabs) is a page holding the open item. |
| **Layout load** | The queue's rows, status counts and permissions. Reads the URL one parameter at a time, never the path, so moving between items doesn't rerun it. A test checks this. |
| **Page load** | Only the open item's own data. The bare path opens the queue's first item. |
| **URL** | Path: which item and which tab. Query string: only what was changed from the defaults — filters, the queue page, the item's own filters. Defaults are never written in. An empty `?status=` means every status. `?report=<id>` opens one report with the filters off. |
| **Screen** | Page header with the queue's title, then the queue column (`ReportFilters`, listbox, a range footer with Prev/Next) flush against the item: header and evidence in the middle, actions in a right sidebar. Every scrolling column is `relative`. |
| **Actions** | Exported by both pages, the bare one and `[id]`. |

What the parent session settled since this was first written (committed in 45a3e3ca87):

1. **Report status.** Both queues share `ReportStatusButtons`, which offers `REPORT_RULINGS`
   (Actioned/Unactioned) unless it is passed `statuses`. The user queue uses the default. The model
   queue passes all four (`reportStatuses`) and its server accepts all four, for now, on Briant's call,
   because Processing means "parked" — for example an ownership claim under investigation (§8). Setting
   Processing or Pending does not move the list on to the next report; only a ruling does.
   `reportStatusActions({ rulingsOnly: true })` is the server switch once that's settled.
2. **One queue loader.** Both layouts use `loadReportQueue`, with options for status counts, the
   reported-date range, canonicalizing defaults and page size.
3. **Paging** opens the new page's first item on both pages (Q15).
4. **What the path names:** the item, with **all its open reports** listed, loaded for the item rather
   than picked out of the queue page (Q16). Ruling on one opens the next; when none are left the page
   moves to the next item in the queue.
5. **Shared components** in `lib/components/report-queue/`: `ReportQueueShell`, `ReportQueueColumn`,
   `ReportDetailColumns`, `ReportList` (the compact report rows, which replaced `ReportSummary`) and
   `ReportStatusButtons`. The whole pattern is written up in
   [`report-queue-pattern.md`](report-queue-pattern.md).
6. **Form errors:** each form holds its own error (`FormState`) on both pages.

Still open from that list: none beyond Processing. "Apply to all N open reports" is on hold.

---

## 2a. Presence — who's looking

CHESHIRE's "blue dot", made specific: show who has an item open, without locking anything.

### Storage: Redis, one sorted set per item

```
report-viewers:<type>:<entityId>  →  sorted set of "<userId>:<username>", scored by last-seen time
```

- The open item's page sends a small `fetch` every **30 seconds** (not an `invalidate`, so the queue
  layout doesn't reload): `ZADD` with the current time, and an `EXPIRE` of 90 seconds on the key.
- Leaving the item sends one last call that removes you; a closed tab or sleeping machine drops off
  within ~60 seconds anyway, because readers ignore entries older than that.
- The queue column reads the page's 50 items in one pipelined `ZRANGEBYSCORE`, and refreshes it on
  the same 30-second beat, again by `fetch`.

Same reasons as claims for Redis over a table (§3): the reports are in the main database, and the
entries should expire on their own. No schema change anywhere.

### Showing it

- **On the row:** a small dot in the presence colour and "Daz" (or "Daz +1") on the second line. Your
  own presence isn't shown to you.
- **On the open item:** "Daz is also looking at this" above the ruling buttons. Nothing is disabled,
  and there is no Take over — there's nothing to take.
- **The "already actioned" error** names who and when — "Ruled Actioned by Daz 40 seconds ago" — so the
  collision CHESHIRE describes explains itself. The report row has `statusSetBy` and `statusSetAt`.

### Where it applies

The layout queues (§6, "Where it applies" lists them). Not the table queues or `/reports/image`.

---

## 2b. Second opinion — "what do you think?"

For a report a moderator could rule on but wants another pair of eyes on — Daz's Discord pings and
CHESHIRE's "tentative decision" in one place. Not a hand-off to a senior: anyone can answer.

### Asking

- **Ask for a second opinion…** beside the ruling buttons on the open item. It asks for an optional
  **suggested ruling** (Actioned, Unactioned, or none) and a **note** — what they're unsure about.
- The reports stay **Pending**, so they stay in the default queue. Asking doesn't rule, pay reporters
  or park.
- One open request per item. The asker can **withdraw** it.

### Showing it

- **On the row:** a "2nd opinion" badge, with the suggestion if there is one ("2nd opinion — leans
  Actioned").
- **On the open item:** a banner — *"Daz asks for a second opinion, 2 hours ago, leaning Actioned:
  'Profile links to a commission site I can't verify.'"*
- **A view** on the switch above the list: `All · Parked · 2nd opinion` (Escalated joins it later,
  §7). It shows open requests, oldest first, with a count.
- **For the asker:** the same view filtered to their own requests, including answered ones, so they
  see what was decided. That replaces pinging.

### Answering

- **Ruling** on the item answers it — whoever rules, with the normal buttons. Agreeing with the
  suggestion is just ruling that way; the banner offers the suggested ruling as the first button.
- **Reply…** adds a note without ruling ("I'd action it — the site is a known scam"), for when the
  asker should make the call. The request stays open until someone rules or the asker withdraws.
- The asker can rule on their own item as normal; that closes the request too.

### Storage: the escalation table, built now

The table §6 describes, with a `kind` column, so second opinions and later escalations share it:

```
ReportHandoff
  id, entityType, entityId               -- the account or model, as claims are
  kind                                   -- 'opinion' now; 'escalation' with §6
  askedBy, askedAt, note
  suggestedStatus                        -- Actioned | Unactioned | null
  resolvedBy, resolvedAt, outcome        -- 'ruled' | 'withdrawn' (+ 'sentBack' with §6)
  resolutionNote
ReportHandoffReply
  id, handoffId, userId, createdAt, note
```

One open row per item (a partial unique index on rows with no `resolvedAt`). A moderator-database
migration — the only schema change in this round. It's a table, not Redis, for the reasons in §6:
it has to last and keep who, when and why. The history doubles as training material: what gets
asked about, and how it was ruled.

---

## 3. Claims — deferred

> **Deferred 2026-10-16** (mod feedback, above): collisions are rare and minor, so presence (§2a)
> comes first. Kept as written in case presence shows they aren't.

### What gets claimed

The thing the path names: the **account** on `/reports/user`, the **model** on `/reports/model`.
Moderators collide over the account or model, through any of its reports, so claiming one report
would let two people work the same account from different reports.

### Where claims live: Redis

The moderator app already uses Redis (`$lib/server/cache.ts`, `auth.ts`). One key per item:

```
report-claim:<type>:<entityId>  →  { userId, username, since }
```

| Operation | Redis |
|---|---|
| Take | `SET key value NX EX 120` — fails if someone else holds it |
| Renew | reset the expiry, only if you hold it |
| Release | delete, only if you hold it (check-and-delete in one script, so you can't delete a claim that just passed to someone else) |
| Who holds what in this page | `MGET` over the page's 50 entity ids |

Not a moderator-database table. Reports live in the main database, so a table there can't be joined
into the queue query, and keys that expire on their own are exactly what this needs. (The scan-label
queue does use a table — `ScanLabelClaim`, a 2-minute lease — but its items live in the same database
as the lease.)

### How long a claim lasts: while it's open

Neither "until released" nor a fixed time:

- **Until released** rebuilds Processing. Closed tabs, crashed browsers and ended shifts each leave a
  lock nobody owns.
- **A fixed time** is always wrong for someone. A 500-image account outlasts it mid-review; a
  two-second spam ruling holds the item for the whole period.

So the page renews the claim about every 60 seconds while that moderator has it open, against a
~2-minute expiry (§10 Q2). It ends when they rule, skip or release, and lapses within ~2 minutes of the tab
closing or the machine sleeping.

Renewal is a small `fetch` to an endpoint, not an `invalidate`, so the queue layout still doesn't
reload.

### Only "Start working" claims

Browsing the All view and opening an item claims nothing (§10 Q1). A moderator holds only the items in
their batch (§10 Q4).

### What a claim covers, and when it ends

The item with **all its open reports** — the page lists them together (§2, item 4). Ruling on one
report doesn't release the claim; the claim ends when the item has no open reports left, when it's
skipped, set to Processing (parked) or escalated, or when work mode stops.

### Someone else's

Warn, don't block. A forgotten tab must never lock anyone out.

- Opening an item someone else holds shows "Josh is working this", with **Take over**. Taking over
  doesn't notify the previous holder (§10 Q3).
- Ruling on an item someone else holds, from outside work mode, asks first: "Josh is working this —
  rule anyway?" (§10 Q18).

---

## 4. Work mode — deferred, with claims

The same page, not a separate one.

1. **Start.** "Start working" beside the filters claims the next few unclaimed items under the current
   filters — 5 (§10 Q2) — and switches the queue column to **My batch**.
2. **Work.** As now: the first item opens, and ruling moves through its reports. When the item has
   none left, its claim is released, the next item opens, and the batch **tops itself up** with the
   next unclaimed item. It feels like a steady "next", with a few items of lookahead.
3. **Stop.** "Stop" releases what's left and returns to the full queue. Closing the tab does the same
   within ~2 minutes.

A batch you work down to zero ends with an empty column and a "claim more" step, and holds items you
haven't reached. One item at a time gives no lookahead. A small refilling batch avoids both.

- **Filters** decide what gets pulled in next. Changing them doesn't drop what you already hold.
- **URL:** My batch is a non-default, so it's `?view=mine`, and a reload stays in work mode.
- **The All view stays.** It's for searching and picking a specific item, for example from a
  `?report=` link. Rows others hold are dimmed and show who holds them.
- **Views:** the switch above the list is `All · My batch · Skipped · Parked · Escalated`. Parked is
  the Processing reports (§8). Escalated appears only with its grant.
- **Batches pull Pending items only.** A parked item isn't work anyone can do yet.
- **Counts:** the status chips add a "claimed by others" count, so it's visible how much of the queue
  is actually free (§10 Q5).
- **Timings:** batch of 5, claim expiry 120s, renewal every 60s (§10 Q2).

---

## 5. Skip — "not for me" — deferred, with claims

> Skip only matters inside a work-mode batch; outside one, moderators already just leave a report.

For "I'm not the right person", "I'm stuck", or "later".

- Releases the claim; the batch refills as if the item were done.
- Keeps the item out of **your** batch for **48 hours** (§10 Q6). Otherwise the refill would hand it
  straight back, since it's still first in the queue.
- No limit on how many you skip (§10 Q4).
- **Skipped view:** your skipped items that are still open, so you can come back to them (§10 Q4).
- **Automatic escalation:** when **3 different moderators** skip the same item within 48 hours, it is
  escalated automatically (§10 Q7, Q19), recorded as escalated by the system with the note "Skipped
  by A, B and C".

Storage, all Redis:

| Key | Holds |
|---|---|
| `report-skip:<userId>` | sorted set of `<type>:<entityId>` scored by skip time; entries older than 48h are dropped on read |
| `report-skippers:<type>:<entityId>` | sorted set of user ids scored by skip time, expiring 48h after the last skip; its 48h count is what triggers escalation |

---

## 6. Escalate — "needs someone more experienced" — later

> **Later** (mod feedback, above). When it comes, it's `kind = 'escalation'` in the `ReportHandoff`
> table built for second opinions (§2b), adding the `sentBack` outcome. The table below is that
> table's original sketch. Build it if second opinions show items that need a senior and sit
> unanswered. Automatic escalation from skips (§5) waits for skip.

Unlike a skip, this lasts, and others see it. It's what Processing never managed to be.

### Storage: a moderator-database table

```
ReportEscalation
  id, entityType, entityId          -- the account or model, as claims are
  escalatedBy, escalatedAt, note    -- note optional (§10 Q9); escalatedBy null = automatic (§10 Q7)
  resolvedBy, resolvedAt, outcome   -- outcome: 'ruled' | 'sentBack' | 'withdrawn'
  resolutionNote
```

At most one open escalation per item (a partial unique index on rows with no `resolvedAt`). It can't
be Redis: it has to survive restarts and keep who, when and why.

Same cross-database shape as claims: the queue reads the open escalations first (few rows) and leaves
those items out of normal batches.

### Why a table, not an `Escalated` report status

Decided 2026-10-15 (§10 Q28). Parking is a status plus a note (§8), so a status looked like the matching
choice here. Both need a schema change; the status needs the bigger one, and loses what escalation is for.

What a status would change:

- **The main database:** `ReportStatus` is a Postgres enum (`packages/civitai-db-schema/prisma/schema.prisma:1681`) — a Prisma
  migration and a main-app deploy.
- **ClickHouse:** the tracker writes report status to an enum column
  (`src/server/clickhouse/tracker.ts:979`), and `tracker-enum-drift.test.ts` fails if the app can
  send a value ClickHouse doesn't accept, so it needs an `ALTER` too.
- **Everything that lists statuses:** the main site's pickers, the moderator app's badges and filters,
  and the table queues, which would start showing a fourth open status.

What it would lose:

1. **History.** A status is overwritten: once a senior rules, `statusSetBy` is them, and nothing records
   who escalated, why, or whether it was sent back — no "Mine" view, no training history. The moderator
   activity log doesn't fill the gap; it records "reviewed", not which status was set.
2. **The unit.** A status is per report; escalation is per account or model. A report filed after the
   escalation would arrive Pending, outside it.
3. **The note.** `internalNotes` is the park note (§8), a single field.
4. **Sending back.** It has to restore the previous status, Pending or Processing, which a status
   can't remember.

The table costs one moderator-database migration and the cross-database read above.

### Who handles them

Moderators with the grant `reports.escalated`, labelled "Handle escalated reports" on `/admin`
(§10 Q8, Q20). It's the last step: there is no further escalation to legal or trust & safety from
here (§10 Q10).

### Where it applies

The layout queues only — `/reports/user`, `/reports/model`, `/reports/post` and the shared `/reports/[queue=entityQueue]` (article, chat, collection, bounty, bounty entry) — not the table queues or `/reports/image` (§10 Q12).

### Vocabulary

The decisions feature already has an `escalate` ruling and an `escalated` item state
(`$lib/decision-rulings.ts:33`, `:93`). Reuse its labels and badge, so "escalated" means one thing
across the app.

---

## 7. How escalations appear

### Queue column

- The Escalated view on the switch, with its count, appears only with the grant.
- Escalated rows get a coloured left edge from a new theme token and an "Escalated" badge. The second
  line says who, how long ago, and the start of their note, so a senior can pick without opening
  each one.
- Sorted like the normal queue (§10 Q13).
- Claiming, work mode and skip all work in this view.

### In the All view, for everyone else

Shown dimmed with the badge, never pulled into My batch. Not hidden: a moderator searching for an
account should see that it's with a senior, not conclude it was never reported.

### On the open item

A banner under the account or model card:

> **Escalated by Josh, 2 hours ago:** "Profile links to a site I can't verify — might be legit art
> commissions, might be a scam."

- **With the grant:** a **Send back** button (optional note) on the banner, and the normal ruling
  buttons below it.
- **Without the grant:** ruling disabled, with "Escalated — a senior moderator will rule on this".
  The evidence stays readable.
- **The person who escalated** can **Withdraw** it ("I figured it out").

### "Mine"

A view of what you've escalated and what happened to each, including the note when one was sent back.

### Sidebar

A second count on the Reports entry for grant holders, e.g. `User reports  405 · 3⬆`. That's the only
notification — no Discord or hub message (§10 Q11).

### Resolution

- Ruling on the report closes the escalation as `ruled`.
- Send back closes it as `sentBack`, with a note.
- Withdraw closes it as `withdrawn`.

All three stay in the table, which gives a history of what gets escalated and how it turned out —
useful for training.

---

## 8. Parked — Processing with a note

For a report that can't be ruled on yet because the answer depends on something outside the queue —
chiefly an **ownership claim** under investigation, which can take weeks (§10 Q17).

No new status and no new table (§10 Q22). Processing already is this, and the report row already holds
the rest:

| Needed | Already on `Report` |
|---|---|
| What is awaited | `internalNotes`, saved by the existing `saveNotes` action |
| Since when, by whom | `statusSetAt`, `statusSetBy` |

What changes is how it's set and shown.

### Setting it

- **Any layout queue** (§10 Q23) — user, model, post and the shared entity route.
  Anyone who can rule can park (§10 Q21).
- The Processing button becomes **Park…**: it asks for a note — what is being waited on — and saves the
  note and the status together. The note isn't required, but it's the point (§10 Q22), so the form
  asks for it rather than leaving a blank box.
- No revisit date (§10 Q22).
- **Unpark** sets it back to Pending. Ruling Actioned or Unactioned closes it, as now.

### Showing it

- In the queue it's labelled **Parked**, with the note's first line and "since 3 Oct, by Josh" on the
  row. The **Parked** view on the switch lists them.
- The open item shows a banner: *"Parked by Josh on 3 Oct: waiting on the claimant's proof of
  ownership."*
- Parked items never enter a work-mode batch (§4).

### The age alert

When a park has been open longer than **14 days** (§10 Q25), measured from `statusSetAt`, it's flagged:

- an **Overdue** badge on its row and on the banner;
- a count on the Parked view, e.g. `Parked (12 · 3 overdue)`.

This also deals with the stale Processing reports without a migration (§9): the 404 Processing user
reports would all show as overdue parks with no note, which is exactly what they are, and can be
cleared from the Parked view.

---

## 9. What changes for Processing

1. **It stays, as "parked".** Labelled Parked in the layout queues, set through Park… with a note,
   with the age alert (§8).
2. **It stops meaning "a moderator is on this".** Presence shows that (§2a); claims would later (§3).
3. **No migration for now** (§10 Q24). Existing Processing reports simply appear as parked; the
   overdue alert surfaces the stale ones for clearing by hand. If there turn out to be too many for
   that, a bulk "Unpark all overdue with no note" is the fallback, and it would need explicit approval
   because it writes to the main database.
4. **Every queue defaults to Pending only** (§10 Q27) — the layout queues and the table queues under
   `/reports/[slug]`. The sidebar badge already counts Pending only, so the badge and every queue
   finally count the same thing. Processing reports are reached through the **Parked** view on the
   layout queues and through the status filter on the tables.

   In code that's `DEFAULT_REPORT_STATUSES` (`lib/reports.ts`) becoming `[Pending]`. Two things read
   it for something else and need their own list:
   - `getReportStatusCounts` counts the **open** statuses for the status chips. It should keep counting
     Processing, so the Parked view can show its count.
   - `ReportFilters` decides which chips carry a count from the same list.

   The table queues write the default into the URL (`?status=Pending&status=Processing` today), so
   their links change to `?status=Pending`. An old link with both still works; it just shows both.

This step is independent of the rest and can ship first.

---

## 10. Open questions

Every question in this plan, with its answer. The body above reflects every answer.

**Still open:** Q26, and Q29–Q32 from the mod feedback. (Q14 is replaced by Q24. Q1–Q7 and Q18–Q19 are about claims and skip, now deferred; their answers stand for when those are built.)

Answer on the `@dev:` line under each.

### Claims

1. Claim automatically when someone opens an item in the All view, or only through "Start working"? (Leaning: automatic for the open item, "Start working" for the lookahead batch.)

   @dev: Not sure what you mean by "automatic" for the open item. I think that, generally speaking, a mod should click "start working" to claim items.

   > **Update (from the parent session):** "Automatic" meant: just *opening* an item in the All view would claim it, with no button. Your answer settles it — browsing claims nothing; only "Start working" does. What's left is what happens when someone outside work mode rules on an item another moderator holds — see Q18.

2. Batch size, claim expiry and renewal interval? (Proposed: 5 items, 120s expiry, 60s renewal.)

   @dev: This sounds good

3. Does "Take over" notify the previous holder?

   @dev: Don't need to notify the previous holder.

4. Should there be a limit on how many items one moderator can hold or skip?

   @dev: A moderator should only hold the current items they are working on. We have that limit already set. They can skip as many as they want. They should be able to view skipped items that are still open.

   > **Update (from the parent session):** "Current items" is now an **item with all its open reports**, not a report (Q16). So a claim is released when the item has no open reports left — not after each ruling — which matches how the page now moves on. The "Skipped" view joins the queue switch: `All · My batch · Skipped · Parked · Escalated` (§4).

5. Should the status chips show a "claimed by others" count (§4)?

   @dev: yes

### Skip

6. How long should a skip last — the end of a shift (say 8 hours), the end of the day, or until the moderator stops work mode?

   @dev: Make a skip last 48 hours. The user can always review their skipped items if they want to come back to them.

7. Should items skipped by several moderators be surfaced somewhere (§5), or just counted?

   @dev: Items skipped by several moderators should be automatically escalated

   > **Update (from the parent session):** This needs a per-item skip count across moderators, kept as long as a skip lasts (48 hours, Q6), and a threshold — Q19. An automatic escalation would be recorded as escalated by the system, with a note like "Skipped by 3 moderators" listing who.

### Escalation

8. Who holds `reports.escalated` — a role, or granted per person?

   @dev: I'm thinking that escalated can be a permission grant

   > **Update (from the parent session):** The grant needs a name and a label for `/admin` — Q20.

9. Is the note required?

   @dev: no

10. Can a senior escalate further, e.g. to legal or trust & safety? Or is that a separate path?

   @dev: no

11. Should escalations notify anyone — Discord, the hub — or is the sidebar count enough?

   @dev: sidebar count should be enough

12. Does escalation apply to the table queues too, or only layout pages?

   @dev: let's restrict it to the layout pages for now

13. Should the Escalated view sort oldest first (§7), unlike the normal queue?

   @dev: no

   > **Update (from the parent session):** So the Escalated view sorts like the normal queue (newest first).

### Processing

14. Approve the stale Processing → Pending reset (§9, step 2), and when?

   @dev:

   > **Update (from the parent session):** New information makes this premature. A comment in `lib/reports.ts` (the badge definition) says a moderator sets Processing *"while investigating an ownership claim, which can run for weeks"*. Ownership claims are model reports. If that's still how mods work, some of the 404 Processing reports may be live investigations, not stale claims, and a blanket reset would lose that. This waits on Q17.

### Page standard (§2)

15. Paging: keep the open item, or open the new page's first?

   @dev: open the new page's first

   > **Update (from the parent session):** Done in code, on both pages.

16. What the path names for a new type: the content (all its reports together) or one report?

   @dev: It will be all its reports together. We've already made changes to support this.

   > **Update (from the parent session):** Done in code, on both pages. It also changes what a claim covers — see the note on Q4.

### Added after the answers

17. Do moderators still set Processing on model reports to mean "ownership claim under investigation", sometimes for weeks? If yes, a 2-minute claim can't carry that, and it needs its own lasting state. Options: (a) keep Processing for that one use on the model queue only; (b) make it an escalation with a note; (c) a separate "on hold" record in the moderator database, like escalation but without the senior hand-off.

   @dev: yes. I wonder if we need to have a better way to "park" a model report

   > **Update:** Designed as **Park** (§8): Processing plus the report's own `internalNotes` — no new table. Q21–Q23 settle its details.

18. Outside work mode, someone rules on an item another moderator has claimed. Warn first ("Josh is working this — rule anyway?"), or just show the holder's name and let it through?

   @dev: warn

19. How many distinct moderators skipping an item (within the 48 hours) triggers the automatic escalation? (Proposed: 3.)

   @dev: 3

20. The escalation grant's name and `/admin` label. (Proposed: `reports.escalated`, "Handle escalated reports".)

   @dev: yes

### Parking

21. Who can park: anyone who can rule on the queue, or a grant like escalation?

   @dev: anyone

22. Is the revisit date required, and is there a default (say 14 days)? Without one, a park can sit forever — Processing's problem again.

   @dev: dates aren't required. I'm not sure if we actually need a "parked" status. It depends on if I can set a model to processing and leave a note. The important thing is that we are able to leave a note. We should probably show some sort of alert when parked/processing models have been that way for longer than a certain period of time.

   > **Update:** You can, today: `Report` has `internalNotes` (the model page's "Internal notes" box, saved by `saveNotes`), plus `statusSetAt` and `statusSetBy`. So parked **is** Processing with a note — no new status or table. §8 now describes it that way, with the age alert; the threshold is Q25.

23. Parking for model reports only, or every layout queue? (Proposed: both layout queues, since it costs nothing extra; only models need it today.)

   @dev: We can do it for any layout queue

   > **Update:** This reverses an earlier call. On 2026-10-14 the user queue was set to Actioned/Unactioned only ("Don't enable it", when Processing still meant claiming). Parking on the user queue means offering Processing there again, as Park… — Q26 confirms.

24. Approve the Processing migration in §9 step 2 (model reports → parks, everything else → Pending), and when?

   @dev: Not sure if we need a migration yet.

   > **Update:** With Processing kept as "parked", none is needed to start. §9 step 3.

### Added after the parking answers

25. After how long is a park flagged overdue? (Proposed: 30 days — most ownership claims should move within that, and every one of the 404 stale user reports is past it.)

   @dev: 14 days

   > **Recorded** in §8. With ownership claims often running for weeks, expect many parks to show as overdue; that is the point — someone looks at each one every 14 days.

26. Confirm Processing comes back on the user queue as Park… (see the note on Q23), reversing "Don't enable it" from 2026-10-14.

   @dev:

27. Should the All view default to Pending only, with parked items in the Parked view? Today it defaults to Pending + Processing, which is why the sidebar badge (Pending only) and the queue disagree.

   @dev: pending only. Should be the same for all queues

   > **Recorded** in §9 step 4, table queues included. Two places read the default list for something else and need separating — noted there.

### Decided outside the questions

28. Escalation: a moderator-database table, or a new `Escalated` report status?

   @dev: I think your plan is good.

   > Recorded as: the `ReportEscalation` table. Reasons in §6, "Why a table, not an Escalated report status".

### Added after the mod feedback (2026-10-16)

29. Presence: show it on queue rows as well as on the open item? (Proposed: both — a row is where you decide what to open.)

   @dev:

30. Second opinion: can anyone answer, or only someone other than the asker? (Proposed: anyone, asker included — they may just have been waiting for a reply.)

   @dev:

31. Second opinion: should an item with an open request be left out of the default All view, so it isn't ruled by someone who didn't see the banner? (Proposed: no — it stays in, with its badge, since anyone may answer.)

   @dev:

32. Should second opinions also go to the table queues and `/reports/image`? dolirama126's own queue is images, which has no Processing either. (Proposed: layout queues first, as with everything else here.)

   @dev:

---

## 11. Order of work

1. **Page standard** — done (45a3e3ca87, §2).
2. **Pending-only default** — §9 step 4. Every queue, one constant and the two readers it needs
   separating from. Small, and fixes the badge mismatch on its own.
   ⚠️ Until the Parked view (step 3) exists, parked model reports drop out of the default view and are
   reachable only by ticking Processing in the status filter. If that is too hidden for ownership
   claims, ship this together with step 3.
3. **Parking** (§8) — Park… with a note, the Parked label and view, the banner, the overdue alert.
   No schema change. Asked for by all three mods.
4. **Presence** (§2a) — the Redis set, the 30-second beat, the dot on rows, the banner, and the
   "already actioned by whom" message. No schema change.
5. **Second opinion** (§2b) — the `ReportHandoff` table and migration in the moderator database, the
   ask/reply/withdraw actions, the badge, the banner and the view.

Then, only if the feedback on 3–5 calls for it:

6. **Escalation** (§6–7) — `kind = 'escalation'`, the grant, the Escalated view, Send back, the
   sidebar count.
7. **Claims, work mode and skip** (§3–5) — if presence shows collisions are common after all.

Each step ships on its own.
