# The `/admin` grant pass — for a human to do

Split out of [`mod-studio-feedback-2026-08-19.md`](mod-studio-feedback-2026-08-19.md) because none of it
is code. It is a pass over the `/admin` screen deciding who holds what, plus one verification login. An
agent can neither make those calls nor perform them.

**Why it is urgent, not housekeeping.** `e14a5428dd` split page grants from action grants and removed
`defaultRoles` — deliberately, because seeding defaults against an ungranted page is what silently
zeroed five permissions in the first place ([background](page-feature-permissions.md)). The consequence
is that **every action grant is now held by nobody until it is ticked**, and nothing reports that. Three
open feedback items are downstream of this pass and are not diagnosable before it happens.

Sources of truth, if any of the below has drifted: `apps/moderator/src/lib/permissions.ts` (the eight
permissions and the exact label text on each `/admin` checkbox) and
`apps/moderator/src/lib/server/access.ts` (`NAVIGATION`, the page tree). What each permission gates and
what Retool's rule was is in [`page-feature-permissions.md`](page-feature-permissions.md) — this file
does not restate it.

---

## 1. Confirm the prefix rename actually landed

Grant rows are keyed `grant:<id>`; they were keyed `capability:<id>` until 2026-08-19. The six rows that
existed were repointed by hand. **An un-repointed row is not revoked — it stops being found**, which
reads as a permission that quietly stopped working.

- [ ] No rows remain under the `capability:` prefix.
- [ ] Every row that was repointed still names a live id from the list in §2 (a typo orphans it the same
      way).

## 2. Tick each action grant

Eight permissions. Each is held by nobody until ticked. For seven the UI hides or refuses the control,
so the symptom is a missing button rather than an error. **`user.buzz.bank` is the exception**: the Buzz
history renders normally and simply omits the bank rows, with nothing on screen saying they were
withheld — so it is the one that cannot be spotted without ticking it and comparing.

- [ ] `user.identity.edit` — *Edit email, username & display name*
      → User Lookup ▸ Basic User Information, the identity panel's edit controls.
- [ ] `user.buzz.send` — *Send or deduct Buzz*
      → User Lookup ▸ Buzz, the send/deduct form. Confirmed in-channel as intentionally limited to two
      people; ticking it for exactly those two is the change, not widening it.
- [ ] `user.buzz.bank` — *See bank transactions in Buzz history*
      → User Lookup ▸ Buzz history. The only permission that worked under the old model, so it may
      already be correct.
- [ ] `user.moderator.toggle` — *Activate or deactivate moderator*
      → User Lookup ▸ Admin, the Account Actions panel.
- [ ] `user.cosmetics.grant` — *Grant cosmetics*
      → User Lookup ▸ Cosmetic Shop. **Has an open decision attached** — Retool restricted this to admin
      plus one person, and our port would let staff grant badges. Decide the width before ticking.
- [ ] `bulk-ban.execute` — *Run a mass ban*
      → `/retool/bulk-ban`. Without it the page still opens for investigation and refuses the ban.
- [ ] `audit.ban.execute` — *Ban an account from an audit queue*
      → `/audit/generator-restrictions` and `/audit/training-models`. Held apart from page access on
      purpose: a role can have the queues without the account-ending half of them.
- [ ] `csam.report.file` — *File a CSAM report*
      → `/audit/training-data/<versionId>`.

## 3. Tick the page grants

A page with no `AppPageAccess` row is visible to `moderator:admin` alone.

Two shapes on the `/admin` page tree, and they behave differently:

- **Groups** (`Images`, `Models`, `Articles`, `Audit`, `Retool`) store nothing of their own. Their
  checkbox is a tri-state bulk toggle over the pages beneath, and the group is reachable exactly when
  one of its pages is. **Grant the leaves.**
- **`/reports` alone** is `sharedAccess` — one grant covering every report queue, and its children have
  no rows of their own. Granting Reports grants all of them.

- [ ] `/retool/user-lookup` for the **staff** role. This is the whole of the open P1 "User Lookup
      unavailable for the staff role" — nothing to build.
- [ ] Walk the rest of `NAVIGATION` and confirm every page a role is expected to open has a row. Newer
      pages are the likely gaps, since a new page ships ungranted by design.

## 4. Verify as a non-admin

**Admins bypass all of it**, which is why the original breakage held for weeks — it worked for whoever
checked. This step is what makes the pass real.

- [ ] Log in as a moderator who is **not** `moderator:admin`.
- [ ] User Lookup ▸ Chat (DMs) shows the header's chat links and the "every chat this account has
      posted in" link resolving for a non-admin. *(The P0 this was filed under is closed and was
      scope, not permissions — the panel is deliberately moderator-contact only. What is unverified
      is whether Chat Audit itself is granted: the links go to `/retool/chat-audit`, a separate page
      grant.)*
- [ ] `reportedUser` on the reports page no longer renders greyed out. *(Open P1, suspected downstream of
      User Lookup access. If it does not clear once granted, it is its own defect — say so, and it goes
      back on the list as one.)*
- [ ] Each action ticked in §2 shows its control, and each one left unticked refuses with the wording
      from that permission's label.

---

## What this pass closes

Tick these back in [`mod-studio-feedback-2026-08-19.md`](mod-studio-feedback-2026-08-19.md) when done —
that file is the live list, and this one is only the working detail:

| Item | Priority | Closed by |
| --- | --- | --- |
| Tick the action grants, then check as a non-admin | P0 | this whole document |
| Chat Audit reachable from the Chats panel's links | — | §3 |
| User Lookup unavailable for the staff role | P1 | §3 |
| `reportedUser` renders greyed out on reports | P1 | §4, or it becomes a real defect |
| Buzz send/deduct appearing held by nobody | P3 note | §1 + §2 |
