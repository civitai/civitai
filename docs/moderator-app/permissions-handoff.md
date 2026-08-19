# Moderator app — permission grants outstanding

Everything here is a change on `/admin` (or the auth hub), not code. Split out of the
[feedback checklist](mod-studio-feedback-2026-08-17.md) so it can be handed to whoever owns moderator
permissions rather than sitting in a list of engineering work.

Background on how the model works — page grants vs capability grants, and why a new page starts
invisible — is in [`page-feature-permissions.md`](page-feature-permissions.md).

---

## 1. Re-enable User Lookup

Switched off on 2026-08-13 pending sub-permissions. Those shipped on 08-14 (v0.0.24), so the reason no
longer applies. It is the most used page in the app and moderators have reported it missing on 08-16
and 08-17.

One reported defect is probably downstream of this and should be re-checked once it is back rather
than investigated first: `reportedUser` renders greyed out on the reports pages.

## 2. Grant the five newer pages

A page with no `AppPageAccess` row is reachable only by `moderator:admin`, so each of these is invisible
to ordinary moderators until granted:

- [ ] `/retool/article-lookup`
- [ ] `/retool/user-reports`
- [ ] `/retool/bulk-image-manager` — **grant narrowly.** Reaching it is gated on the page, but its
      actions remove images in bulk across accounts the moderator never looked up. It is an enforcement
      page, not a lookup one.
- [ ] `/retool/front-page-audit` — this grant also controls the rating buttons and tag votes, not just
      reaching the page. Without it the sweep renders read-only.
- [ ] `/retool/image-help` — the second-opinion queue. The same grant gates "Mark handled".

## 3. Chat Audit access

Reported 08-16 as unreachable. It is also why chat report links read as broken to some moderators: the
links were fixed on 08-12 and land on a page they cannot open, which looks identical to a dead link.

## 4. Confirm the sub-permission defaults

Shipped 08-14 and never confirmed by anyone who owns the policy:

- [ ] **Buzz send** — senior only
- [ ] **Email edit** — senior only
- [ ] **Granting cosmetics** — admin only. Chosen to match what Retool did; flagged in the channel as
      worth a second opinion and nobody answered either way.

## 5. Auth hub role admin

A dev working these tickets reported `Forbidden` on `auth.civitai.com/admin/roles` on 08-14, which
blocked them from verifying their own permissions work. Devs are understood to have admin access
already, so this is likely a specific role rather than a missing grant — recorded here only so it is
not rediscovered as a bug.
