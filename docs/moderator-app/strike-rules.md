# User strikes

What the strike system does, what the moderation team decided in the 2026-08-24/25 review round, and
what is still open.

Code: `src/server/services/strike.service.ts`, `src/server/common/tos-reacceptance.ts`,
`src/shared/constants/strike.constants.ts`, `src/server/jobs/process-strikes.ts`,
`apps/moderator/src/lib/server/user-actions.service.ts`.

---

## 1. What a strike is

A row in `UserStrike`, against one account.

| Field | Meaning |
| --- | --- |
| `points` | Severity, 1–3. **Only points drive enforcement.** |
| `reason` | One of seven categories. Chooses the sanitized wording in the email; does not affect points or expiry. |
| `description` | Free text, **shown to the user** in their notification. Required. |
| `internalNotes` | Never shown to the user. |
| `expiresAt` | When it stops counting. |
| `status` | `Active` → `Expired` (time) or `Voided` (a moderator removed it). |
| `entityType` / `entityId` / `reportId` | What it was about, optional. |

`reason` values: `BlockedContent`, `RealisticMinorContent`, `CSAMContent`, `TOSViolation`,
`HarassmentContent`, `ProhibitedContent`, `ManualModAction`.

## 2. Points and expiry

The API accepts `points` 1–3 and `expiresInDays` 1–365, defaulting to **1 point / 365 days**.

Every Mod Studio surface — User Lookup, User Reports, Post Reports, Bulk Image Manager — sends neither
field, so every strike issued from Mod Studio is 1 point for a year. Only the main app's
`/moderator/strikes` form lets a moderator choose.

## 3. The ladder

On the sum of `points` across strikes that are `Active` and not past `expiresAt`.

| Total active points | What happens |
| --- | --- |
| 1 | Nothing. A single strike never mutes. |
| **2** | Muted, and asked to re-read and accept the Terms (§9). |
| **3+** | Muted, flagged for moderator review. A person decides whether it becomes a ban. |

**The mute is applied only when a strike is issued.** Voiding, expiry and the daily sweep re-evaluate
to *release*, never to re-apply — so a moderator's manual unmute is not undone by the next job run.

**It ends in one of two ways:**

- the user accepts the Terms (§9) — the early exit, offered at 2 points only;
- their points fall below 2 and the daily job releases them — the backstop, which at a 365-day
  lifetime means up to a year.

A moderator voiding a strike also releases it: a strike taken back is not held against the account.
Expired strikes still count as "the last time we told them", because time served is not acceptance.

**A mute a moderator set is never touched by any of this** — not lifted, not extended, and its expiry
is left alone. `mutedAt` is the discriminator: a person's decision sets it, every automatic path
leaves it null.

## 4. What else an active strike costs

| While the account has… | It cannot… |
| --- | --- |
| 2+ active points | post, comment or generate (muted) |
| 2+ active points | create a challenge |

Challenge eligibility is the only consumer of strike state outside the strike system itself. It used
to block on any active strike regardless of points, which locked an account out for a strike's whole
lifetime over one 1-point strike that mutes nobody.

## 5. Who can issue one

- **Any moderator at the API level** — no extra permission, same bar as mute/unmute.
- **In Mod Studio, every strike button also requires the `/users` page grant.**
- Strikes issued by a person are classified `ManualModAction`.
- **Automatic strikes are limited to 1 per user per day**; `ManualModAction` is exempt. A rate-limited
  strike returns "skipped", which Mod Studio surfaces as *"The strike was rate-limited and NOT
  issued."* Nothing currently issues automatic strikes.

## 6. What the user sees

| Event | Notification | Email |
| --- | --- | --- |
| Strike issued | "You have received a strike: *(description)*." Adds the point count when > 1. | Yes |
| Strike voided | "A strike on your account has been removed: *(void reason)*." | No |
| Strike expired | "A strike on your account has expired…" | No |
| Muted at 2 points | "Review and accept our Terms of Service to lift it — you will be asked the next time you try to post or comment." | No |
| Muted at 3+ | "…and is pending review." | No |
| Unmuted | "Your account mute has been lifted…" | No |

All are non-toggleable. **The email never contains the moderator's free text** — only a sanitized
label per reason. The `description` goes to the in-app notification only.

Canned reasons (`apps/moderator/src/lib/moderation-reasons.ts`) each carry the ToS section they are
for; roughly 85% of real strikes use one verbatim.

## 7. Voiding

Only an **Active** strike can be voided, it needs a reason (which is sent to the user), it immediately
re-evaluates escalation — releasing the mute if the remaining points no longer justify it — and there
is no delete: voided strikes stay in the history.

## 8. Jobs

| Job | Schedule | Does |
| --- | --- | --- |
| `expire-strikes` | daily 02:00 | Flips past-expiry strikes to `Expired`, notifies, re-evaluates |
| `process-timed-unmutes` | daily 03:00 | **Releases only.** Unmutes strike mutes whose points have fallen below 2 |

Neither job can mute. Daily rather than hourly because strikes expire on a day boundary, so nothing
finer changes anything.

## 9. The ToS re-acceptance gate

A muted account is refused by one tRPC guard when it tries to post, comment or upload. That refusal
carries a marker, and the client opens the Terms at **§9.6** — the prohibited-content list, where 95%
of strikes come from. Browsing is untouched: the user is asked at the moment they try to act, rather
than the whole site being gated up front.

Accepting lifts the mute and refreshes the session, so they are unblocked immediately.

**Who gets the offer — and who deliberately does not:**

| | Offered? |
| --- | --- |
| Strike mute, exactly 2 points | **yes** |
| Strike mute, 3+ points | no — a moderator is deciding, and accepting would change nothing |
| Scam auto-mute, generation restriction | no — not the strike system's to release |
| Moderator's mute | no — never liftable by ticking a box |

Strike mutes stamp `meta.muteReason = 'strike-escalation'`, which is what tells them from the other
automatic mutes (all of which also leave `mutedAt` null). The acceptance endpoint runs the **same**
predicate as the guard, because it is callable directly by any signed-in account — suppressing the
modal is not a control.

Coverage is tRPC mutations. Generation is gated separately by prompt auditing, and REST endpoints
refuse on their own.

**Which part of the ToS**, measured over real strikes: 95% fall under §9.6; the rest were §11
(harassment 11.2, multi-accounting 11.8).

| Reason | Clause |
| --- | --- |
| Depicting Real People · Real person model not marked | 9.6(a) |
| Minor in mature context · Realistic minor · NSFW minor in school environment | 9.6(b) |
| Bestiality · Rape/Forced Sex · Graphic Violence/Gore | 9.6(c) |
| Mind-altered NSFW | 9.6(e) |
| Scat/Fecal matter | 9.6(f) |
| Likeness/DMCA | 9.3(b)(i) and 12 — not cited, as it is not the prohibited-content list |
| **Non AI content** | **none — the ToS never requires uploads to be AI-generated** |

The anchor is a section, never a lettered bullet: `tos.green.md` inserts a clause at 9.6(a) and pushes
the rest down, so 9.6(a) on civitai.com is 9.6(b) on green. Section numbers match across variants.

The id lives in the ToS files themselves so an editor can see something depends on that section;
`rehypeTosSectionIds` re-derives it for a document that has lost one. Editing a ToS file changes its
content hash — what the re-prompt compares — so the anchor edit is aliased in `tosHashOverrideMap` and
nobody was asked to re-accept. `tos-prohibited-content-anchor.test.ts` fails if either property breaks.

## 10. Decisions

2026-08-24/25 (chipshajen, Seb, Kesler, Manuel):

| # | Question | Answer |
| --- | --- | --- |
| 1 | Default strike lifetime | 365 days, flat |
| 2 | Retroactively extend existing strikes | yes — the 40 moderator-issued ones, applied 2026-08-24 |
| 3 | Points/expiry pickers in Mod Studio | not wanted; stays one-click |
| 4 | Does a single strike mute | no |
| 5 | What 2 points means | muted until they accept the Terms, or until the points decay |
| 6 | Should 3 points ban automatically | **no** — indefinite mute flagged for review; a person decides |
| 7 | Does a 3-point user see the ToS prompt | no |
| 8 | Should anything issue strikes automatically | not at the moment |
| 9 | Canned strike reasons | fine as-is |
| 10 | Duplicate legacy strikes | cleaned up — see [legacy-strike-migration.md](legacy-strike-migration.md) |
| 11 | One strike blocking challenge creation | gate on 2+ points instead |
| 12 | Bot/spam **strike** reason | no — ban reason only ([CU-868kw67xe](https://app.clickup.com/t/8459928/868kw67xe)) |
| 13 | `SpamBot` ban removing content by default | yes, with a warning on the confirm dialog |
| 14 | Add "Non AI content" to the ToS | no — point the user at §9.6 without citing a clause |
| 15 | Ladder measured in strikes or points | points |
| 16 | Where the mute is applied | when the strike is issued; jobs only release |

**Open:**

- **Should the main app's ban modal get a comment-removal toggle?** It has none, so a `SpamBot` ban
  issued there leaves the spam comments up. Comment removal is Mod Studio only.
- **Seb has not seen the final model.** He answered while the rule was "accepting is the only way
  out"; it is now "accepting early, expiry as the backstop", plus no auto-ban and no prompt at 3
  points.
