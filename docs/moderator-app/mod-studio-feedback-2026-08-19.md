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

- [ ] **A strike is issued but never appears.** Issuing a strike from User Lookup marks the account as
      carrying an active strike, but the Strikes section on both Basic Info and Notes & Strikes shows none
      — after a refresh. So the write lands and the read does not show it.

      Two things worth separating before diagnosing. The strike *write* was repointed this week to
      `/api/mod/strike/create`, authenticated as the acting moderator rather than by a shared API key
      (`d0820283c0`), which removed the old "`CIVITAI_MOD_API_KEY` is not configured" refusal — so a strike
      that now succeeds where it used to be rejected is expected. The report is about the display half,
      which that change did not touch. The reporter also checked Retool and saw no strike there either,
      but flagged that as possibly the cutoff rather than a second symptom; that half can no longer be
      re-checked after today.

- [ ] **The Chats panel in User Lookup shows nothing.** Reported as showing only a moderator contact, on
      an account confirmed — against Retool, while that was still possible — to have chat history. The
      reporter's own follow-up concluded it was a permissions problem.

      **Likely already fixed, and needs confirming rather than building.** `e14a5428dd` repaired a bug in
      which a permission required the page it was declared under: `/users` exists only as a "Not built
      yet" placeholder, so every permission naming it seeded to nobody, could not be granted on `/admin`
      (any save re-trimmed it), and silently became admin-only. That is the shape of "it works for
      an admin and shows nothing for me". Grants are now page grants and action grants, independent, and
      the storage prefix moved from `capability:` to `grant:` — **the existing rows must be repointed and
      the actions re-ticked on `/admin` before this can be judged fixed.**

## P1 — reported defects

- [ ] **Comment highlighting does not work on article comments.** Flagged by the reporter as a
      pre-existing bug rather than a regression: following a report or a deep link to an article comment
      does not highlight the row it landed on. It works elsewhere, so the highlight helper is reached but
      the article-comment surface does not apply it.

## P2 — needs a decision or clarification

- [ ] **A paged list has no "load more".** Reported as loading a fixed number of rows with no way to page
      further back. The report identifies the list by screenshot only and several panels page this way, so
      **the first step is confirming which one** — not building a control on all of them.

## P3 — improvements, after parity

- [ ] **Open Image Lookup and Article Lookup from the image and article context menus**, as moderator-only
      items. Both menus already have a `Moderator` section to hang them off —
      `ImageMenuItems.tsx` (the `{isModerator && …}` block under `<Menu.Label>Moderator</Menu.Label>`)
      and `ArticleContextMenu.tsx` — and both moderator pages already take the id as `?q=`:
      `<mod app>/retool/image-lookup?q=<imageId>` and `<mod app>/retool/article-lookup?q=<articleId>`.
      So this is two menu items, not a feature.

      **The thing this asked to settle is settled.** It proposed choosing between one env var per target
      and a single moderator-app base URL; the repoint P0 above took the second, so there is now one
      `NEXT_PUBLIC_MODERATOR_APP_URL` and the per-target paths live in
      [`~/shared/constants/moderator-app`](../../src/shared/constants/moderator-app.ts). Adding image and
      article is two menu items plus two path helpers there, and no new configuration.

- [ ] **Put Buzz send/deduct on the dashboard audit list.** The request came with a restatement of an
      existing decision — that sending and removing Buzz should be limited to two people — which was
      already true and was confirmed in-channel by another moderator, so no permission change is implied.
      The new part is surfacing those actions in the dashboard's audit list, where the highest-blast-radius
      actions are already visible.

      Related and already shipped: `user.buzz.send` is a declared action grant, ticked per role on
      `/admin` (`e14a5428dd`). If it currently appears to be held by nobody, that is the prefix rename in
      the P0 Chats item above, not a policy change.

---

## Shipped this round

- **The four lookup env vars are off Retool**, closing the carried P0 and the re-reported "lookup user"
  button with it. The one that needed code rather than config was **Lookup Post**: `3239ac735b` deleted it
  believing the spoke had no post page, when Bulk Image Manager is that page. It is back on the post
  context menu, and the empty `Moderator` label that deletion left behind is no longer empty. Full
  per-target breakdown in the carried P0 below.

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

## P2 — decisions, not implementation

- [ ] **`ReToolActions` vs `ModActivity`** *(08-17)* — two mod-action logs that nothing reconciles. A
      recommendation is on the table; it needs a human's yes.
- [ ] **Two strike systems** *(08-17)* — this app writes the Retool-era `UserStrikes`, not the main app's
      newer `Strike`. **Worth re-reading against the strike display report above**: two stores is a
      candidate explanation for a strike that writes and does not appear.
- [ ] **`aiNsfwLevel` / `aiModel` exist in production but not in `schema.full.prisma`** *(08-17)* — add
      them to the schema, or accept the raw `sql` read.
- [ ] **`FrontPageTimers` / `RatingChanges`** *(08-17)* — the two schemas Front Page Audit needs before it
      can resume or log. The sweep works without them; the shared resume point and the audit trail do not.
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
