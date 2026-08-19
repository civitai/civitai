# Mod Studio feedback — round 2026-08-19

The moderation team reviews the app in a feedback channel and reports as they go. This file is the single
place to see what this round asked for and whether it is done.

**Scope:** everything reported between 2026-08-18 afternoon and 2026-08-19 morning. Earlier rounds are in
[`mod-studio-feedback-2026-08-17.md`](mod-studio-feedback-2026-08-17.md), which this file continues rather
than replaces — items still open there are still open.

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

- [ ] **Repoint the main app's "lookup user" button off Retool.** Re-reported independently this round:
      the profile action still opens Retool. This is the same `NEXT_PUBLIC_USER_LOOKUP_URL` config change
      already tracked as P0 in the 08-17 doc and as handover blocker
      [5b](retool-migration-handover.md) — no code, and it breaks the moment Retool stops answering.

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

Nothing yet. The two `e14a5428dd` references above are work that landed *before* this round was triaged
and that plausibly resolves parts of it — they are marked open deliberately, because "probably fixed by
something adjacent" is not the same as verified, and the verification here needs a `/admin` pass and a
moderator who is not an admin.
