# Mod Studio feedback — round 2026-08-19

The moderation team reviews the app in a feedback channel and reports as they go. This file is the single
place to see what this round asked for and whether it is done.

**Scope:** everything reported between 2026-08-18 afternoon and 2026-08-19 morning — from the feedback
channel and from the team directly — PLUS everything still open from earlier rounds, carried into the
second half of this file.

**This is the live list.** A round gets its own dated file so it is clear when something was first asked
for, and unfinished items move to the newest file rather than being ticked across several — so the
newest file is the only one with open boxes, and an older one is the record of what its round reported
and what shipped. Earlier rounds: [`mod-studio-feedback-2026-08-17.md`](mod-studio-feedback-2026-08-17.md).

Reporter identities, message links, quotes and the account ids used as examples are deliberately absent:
this repo is public (CLAUDE.md → Security). The private triage keeps attribution.

> **Update this file in the same commit as the fix**, with a one-line outcome and the sha. An unticked box
> with no note reads as "nobody looked", which is the failure mode this file exists to prevent.

**Items are not announced back to the reporters individually.** Release notes carry what changed and this
file carries the state, so a ticked box means shipped — not "shipped and acknowledged".

---

## Context this round arrived in

Retool goes dark at the end of 2026-08-19. Three of the six reports below were made while comparing the
two tools side by side, which is a comparison that stops being possible today. Anything relying on
"check it in Retool" needs settling now.

---

## P0 — blocking, needed before the Retool shutdown

- **Repoint the main app's "lookup user" button off Retool** — ✅ done, see
  **[Repoint the four lookup env vars](#p0--blocking-needed-before-the-retool-shutdown-1)** below. Not a
  new item and not a second box: it is the `NEXT_PUBLIC_USER_LOOKUP_URL` half of that one, first raised
  08-17. Recorded here because an independent re-report is what says an item is still live — and this one
  would have broken the moment Retool stopped answering.

- [x] **A strike is issued but never appears.** ✅ Fixed. Two stores, exactly as the open P2 below
      suspected: "Issue strike" writes the main app's `UserStrike`, and the Strikes list was reading the
      moderator database's Retool-era `UserStrikes`, which nothing writes. So every strike issued from
      this app was invisible on the panel that issued it, on both Basic Info and Notes & Strikes.

      `/api/user-memory/<id>` now serves `getLiveStrikes` alongside the legacy rows, and the panel renders
      the live ones with the Retool-era table demoted to a collapsed count beneath them. The rendering is
      the `StrikeList` component that User Reports already used, now shared, so the two lists cannot drift
      — the two surfaces previously disagreed about the same account.

      The strike *write* was repointed this week to `/api/mod/strike/create`, authenticated as the acting
      moderator rather than by a shared API key (`d0820283c0`), which removed the old
      "`CIVITAI_MOD_API_KEY` is not configured" refusal. That change was not the cause and is not the fix;
      it is why the reporter had a landed strike to not see.

- [x] **The Chats panel in User Lookup shows nothing.** ✅ Fixed — and **it was never a permissions
      problem**, which both the reporter's own follow-up and this file's first triage assumed. The panel
      is scoped by design: `getModeratorContact` counts only chats a **moderator** posted in, and the
      panel says so in its own subtitle. An account with a decade of ordinary DMs and no moderator contact
      correctly rendered "No moderator contact on record" — which reads as a broken panel, which is
      exactly how it was reported.

      The real gap was that the account's own chats had no route from here at all. The panel now links
      into Chat Audit's username search and the empty state says what it means rather than just being
      empty.

      **The link is labelled "every chat this account has posted in", and the wording is load-bearing.**
      Chat Audit's username search joins `ChatMessage` — message *authorship* — while membership lives in
      `ChatMember`. An account that received unsolicited DMs and never replied is in N chats and matches
      none of them. The first draft of this fix said "every chat this account is in", which would have
      recreated the same false-empty reading one page over. A membership-mode search is the fuller fix
      and nobody has asked for it; the builder in `entity-url.ts` carries the caveat so the next caller
      cannot re-make the mistake.

      The permissions half is still real and still in
      [`action-grants-review.md`](action-grants-review.md) — it just was not this.

## P1 — reported defects

- [ ] **Comment highlighting does not work on article comments.** Flagged by the reporter as a
      pre-existing bug rather than a regression: following a report or a deep link to an article comment
      does not highlight the row it landed on. It works elsewhere.

      **Read end to end and not reproduced from the code — needs a live repro before anyone changes
      anything.** The whole path is entity-agnostic and the article-specific hazards are each already
      handled: `/comments/v2/<id>` resolves an article thread through `rootThread` for replies,
      `threadUrlMap` emits `?highlight=` for `article`, the slug redirect passes the query through with
      `buildPassthroughQuery` and drops to 307 whenever a query is present so a cached 308 cannot strand
      it, and the article page force-mounts its comments on `?highlight=` rather than waiting for the
      IntersectionObserver. `ArticleDetailComments` renders `<Comment>` identically to the post, image and
      bounty surfaces, and the highlight class is applied in shared code from a shared context.

      So the next step is watching it fail with the URL in hand, not another reading pass. **No
      article-specific difference was found at all** — a second pass checked the one candidate, a loading
      gate of `isLoading || isFetching`, and article is not an outlier: bounty, challenge, Model3D and app
      listings gate the same way, and post and image are the two that use `isLoading` alone. Whatever is
      failing here is not visible in the article surface's own code.

## P2 — needs a decision or clarification

- [ ] **A paged list has no "load more".** Reported as loading a fixed number of rows with no way to page
      further back. The report identifies the list by screenshot only and several panels page this way, so
      **the first step is confirming which one** — not building a control on all of them.

## P3 — improvements, after parity

- [x] **Open Image Lookup and Article Lookup from the image and article context menus** — ✅ done, as
      moderator-only items in both. Two path helpers in
      [`~/shared/constants/moderator-app`](../../src/shared/constants/moderator-app.ts) plus one menu item
      each, on the single `NEXT_PUBLIC_MODERATOR_APP_URL` the repoint P0 above established, so no new
      configuration.

      One correction to the triage: `ImageMenuItems.tsx` did have a `Moderator` section to hang the item
      off, but `ArticleContextMenu.tsx` did not — its moderator-only items are interleaved with the
      owner's. It has one now, matching the post menu.

- [x] **Put Buzz send/deduct on the dashboard audit list.** ✅ Fixed, though not as filed: the actions
      were **already on the list and illegible**, rather than missing. `sendBuzz` has always written
      `ModActivity` as `buzz:send:<colour>:<type>:<amount>`, and the dashboard's own labeller turned that
      into **"User buzz flags"** — because it read the presence of a `:` as "this is a flag write", when a
      colon is just the separator every parameterised activity uses. `toggleModerator:true`,
      `grantCosmetic:<id>`, `restriction:<status>` and `comments:<action>:<count>` were all mislabelled
      the same way, and every Buzz row — send and deduct alike — collapsed into that one line.

      Flag activities are now named (`minor`, `poi`, `spamWhitelist`, `deservedMute`) instead of inferred,
      and `buzz`, `comments` and `reviews` keep their verb, so send and deduct are two rows. The amount
      and colour still go: this panel answers who last worked something, not what the row said.

      The restatement that came with the request — that sending and removing Buzz is limited to two
      people — was already true and needs no change; it is §2 of
      [`action-grants-review.md`](action-grants-review.md).

      Related and already shipped: `user.buzz.send` is a declared action grant, ticked per role on
      `/admin` (`e14a5428dd`). If it currently appears to be held by nobody, that is the `capability:` →
      `grant:` prefix rename, not a policy change — §1 and §2 of
      [`action-grants-review.md`](action-grants-review.md).

---

## Shipped this round

- **Issued strikes are visible again** — the P0 above. One shared `StrikeList` now renders both surfaces,
  so User Lookup and User Reports can no longer disagree about the same account.
- **The Chats panel reaches the account's chats** — the other P0 above, and not the permissions problem
  everyone took it for.
- **The dashboard audit list names what it is showing** — Buzz send and deduct were on it already, under
  the label "User buzz flags", along with five other mislabelled action families.
- **Image Lookup and Article Lookup are on their context menus** — the P3 above.

- **The four lookup env vars are off Retool**, closing the carried P0 and the re-reported "lookup user"
  button with it. The one that needed code rather than config was **Lookup Post**: `3239ac735b` deleted it
  believing the spoke had no post page, when Bulk Image Manager is that page. It is back on the post
  context menu, and the empty `Moderator` label that deletion left behind is no longer empty. Full
  per-target breakdown in the carried P0 below.

Two of the four fixes this round were **misdiagnosed in this file before anyone read the code** — the
strike display was filed as a display bug and was two stores, and the Chats panel was filed as
permissions and was scope. Both were repeated from a reporter's own guess. Worth a habit: a reporter says
what they saw, and that half is reliable; what they think caused it is a lead, not a finding.

The two `e14a5428dd` references above are work that landed *before* this round was triaged
and that plausibly resolves parts of it — they are marked open deliberately, because "probably fixed by
something adjacent" is not the same as verified, and the verification here needs a `/admin` pass and a
moderator who is not an admin.

---

# Carried forward from earlier rounds

Everything still open when this round opened, moved here so there is one live list. Each keeps the date
it was first raised — that is what the dated files are for, and an item that has been carried twice is
saying something.

The rounds they came from stay where they are, with their reasoning intact and their boxes removed, so a
round still reads as the record of what was reported that day.

## P0 — blocking, needed before the Retool shutdown

- [x] **Repoint the four lookup env vars off Retool** *(first raised 08-17)* — handover blocker
      [5b](retool-migration-handover.md). **This is the same change as the "lookup user" button
      re-reported above** — one task, one box. It did not end up as config only:

      - **user** — `NEXT_PUBLIC_USER_LOOKUP_URL` replaced by `NEXT_PUBLIC_MODERATOR_APP_URL`, which
        carries a default, so the item works with nothing provisioned (`3239ac735b`).
      - **post** — "Lookup Post" was *removed* by `3239ac735b` on the reasoning that the spoke has no
        post page. That was wrong: Bulk Image Manager is the post page. Re-added, pointing at
        `<mod app>/retool/bulk-image-manager?source=post&q=<postId>`. Note the param shape — the spoke
        takes `source` + `q`, not the `postId` Retool used.
      - **model** — stays removed. Explicitly waived: Bulk Image Manager sourced by model is not what
        the old Retool model lookup did, and nobody asked for it back.
      - **chat** — `NEXT_PUBLIC_CHAT_LOOKUP_URL` had no reader left in `src/`; its only call site went
        with the reports page in `95157404b0`. Removed from `client-schema.ts` rather than repointed.
- [ ] **Finish the environment and database steps** *(first raised 08-17)* — handover blockers
      [#1–#4](retool-migration-handover.md). Narrower than that list reads: `CIVITAI_MOD_API_KEY` is
      retired and must NOT be provisioned, so what remains is `RETOOL_DATABASE_URL` per deployed
      environment, the `FRESHDESK_TOKEN` rename, and verifying two of the three SQL migrations.
- [ ] **Tick the action grants on `/admin`, then check as a non-admin** *(replaces "confirm the
      sub-permission defaults", 08-17)*. That item asked whether the 08-14 defaults were right; there are
      no defaults any more. `defaultRoles` was removed with the page/action split (`e14a5428dd`) because
      seeding them against an ungranted page is what silently zeroed them. Every action grant is now an
      explicit tick, and until that pass happens the actions are held by nobody.

      **The pass itself is [`action-grants-review.md`](action-grants-review.md)** — every permission and
      page enumerated, with what breaks while each is unticked.

## P1 — reported defects

- [ ] **User Lookup unavailable for the staff role** *(08-17)*. Not a defect — the `/admin` grant in
      [`permissions-handoff.md`](permissions-handoff.md). Nothing to build; it is part of the `/admin`
      pass above.
- [ ] **`reportedUser` renders greyed out on reports** *(08-18)*. Suspected downstream of User Lookup
      being unavailable — confirm it clears once that is granted, otherwise it is its own defect. Not
      investigable before the `/admin` pass.
- [ ] **Comment rows are "funky" to read** *(08-18)*. Reported alongside the comment-highlight fix and not
      addressed: the complaint arrived as a screenshot and the layout problem is not reconstructable from
      the text. Needs the reporter to say what is wrong with it.
- [ ] **Why are banned users' comics queued for review at all?** *(08-18)*. Raised as a possible better
      fix for the comics 500. It is a queue-predicate question, not that defect.

      **The predicate is now known; the decision is not made.** `getComicReviewQueue` filters on the
      IMAGE only — `needsReview IS NOT NULL AND ingestion != 'Scanned'`, unioned with
      `tosViolation = true` — and joins the author purely to display them. It already selects
      `u.bannedAt` and `u.deletedAt` and does not filter on either, so a banned author's panels queue
      exactly like anyone else's. So this is one `where` clause away either direction.

      What is still missing is the volume: how much of the queue is banned-author panels decides whether
      this is a cleanup or a rounding error. That query needs a database connection this session did not
      have (the prod replica refused TLS), so it is unmeasured, not unanswerable.

## P2 — decisions, not implementation

- [ ] **`ReToolActions` vs `ModActivity`** *(08-17)* — two mod-action logs that nothing reconciles. A
      recommendation is on the table; it needs a human's yes.
- [ ] **Two strike systems** *(08-17)* — **the decision is narrower than it was, and it was the cause of
      the P0 above.** This app no longer writes `UserStrikes`: `d0820283c0` moved the write to the main
      app's system, and the display now reads it (P0 above). What is left is a data question, not a
      routing one — whether the 12.7k Retool-era `UserStrikes` rows get migrated into `UserStrike`, or
      stay where they are as read-only history. They are shown as history today, which is the safe
      default but not a decision.
- [ ] **`aiNsfwLevel` / `aiModel` exist in production but not in `schema.full.prisma`** *(08-17)* — add
      them to the schema, or accept the raw `sql` read.
- [ ] **`RatingChanges`** *(08-17, narrowed 08-20)* — the rating audit trail, the one Front Page Audit
      write still unported; `FrontPageTimers` is done. Current state, and the only place it is recorded:
      [Front Page Audit: port state](retool-exports/parity-findings.md#front-page-audit-port-state-canonical).
- [ ] **How queue sweeps get tracked** *(08-17)* — a new table, or an extension of `ModActivity`. Blocks
      the remaining queue requests.

## P3 — improvements, after parity

- [ ] **Show "recently worked" and "time sweeps" beside the queues they describe** *(08-17)*.
- [ ] **Whether the `/images/*` triage queues join the sweep tracking** *(08-17)* — a decision, not an
      oversight.
- [ ] **Link a report to the site it originated from** *(08-17)* — not implementable as asked: `Report`
      has no origin column.
- [ ] **The "Admin Attention" report reason is too vague to action** *(08-17)* — remove it or merge it.
      Changes what reporters see, so it is not a moderator-side call alone.
- [ ] **The mod changelog modal disappears once a model is unpublished** *(08-17)*, so the changes and the
      unpublish reason cannot be read together.
- [ ] **Unpublished articles have no republish path** *(08-17)*; authors are told to contact support.
- [ ] **A model marked as depicting a minor can still receive a new version containing X-rated images**
      *(08-17)*.
