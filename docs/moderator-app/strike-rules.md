# User strikes

What the strike system does, what the moderation team decided about it in the 2026-08-24 review round,
and what is still open.

Code: `src/server/services/strike.service.ts`, `src/server/schema/strike.schema.ts`,
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

## 3. The escalation ladder

On the sum of `points` across strikes that are `Active` and not past `expiresAt`. Re-evaluated when a
strike is issued, voided, or expires.

| Total active points | What happens |
| --- | --- |
| 0–1 | Nothing (but see §4). |
| **2** | Muted for 3 days, session invalidated. A further strike restarts the 3 days. |
| **3+** | Muted with no expiry, flagged for moderator review, session invalidated. |
| Drops below 2 | Mute lifted automatically, user notified. |

Thresholds live in `strike.constants.ts` so the ladder and everything gating on it read one number.

⚠️ **The 3-day mute is really "muted until the points drop below 2".** `process-timed-unmutes`
re-evaluates hourly and re-applies another 3 days while the points stand, with no further
notification. At a 365-day strike lifetime that means a 2-point account can stay muted for a year,
having been told once that it was three days. See §10 — this is open.

**A mute a moderator set is never lifted or shortened by strikes.** De-escalation only releases mutes
the strike system itself applied (`mutedAt IS NULL` is the discriminator). Escalation *can* tighten a
moderator's timed mute to indefinite at 3 points.

## 4. What else an active strike costs

| While the account has… | It cannot… |
| --- | --- |
| 2+ active points | post, comment or generate (muted) |
| 2+ active points | create a challenge |

Challenge eligibility is the only consumer of strike state outside the strike system itself. It
**used** to block on any active strike regardless of points, which locked an account out for the whole
strike lifetime over one 1-point strike that mutes nobody — 82% of struck accounts never reach 2
points. Now gated on the same threshold as the mute.

## 5. Who can issue one

- **Any moderator at the API level** — no extra permission, same bar as mute/unmute.
- **In Mod Studio, every strike button also requires the `/users` page grant**, the same one gating
  mute/unmute and ban.
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
| Muted by strikes | "muted for 3 days" / "muted … and is pending review" | No |
| Unmuted by decay | "Your account mute has been lifted…" | No |

All five are non-toggleable. **The email never contains the moderator's free text** — only a sanitized
label per reason ("Content violated our Terms of Service", "Community Abuse"). The `description` goes
to the in-app notification only.

Canned reasons (`apps/moderator/src/lib/moderation-reasons.ts`): Depicting Real People · Real person
model not marked correctly · Minor displayed in mature context · Realistic minor · Bestiality ·
Rape/Forced Sex · Non AI content · Other. Roughly 85% of real strikes use one verbatim; the rest are
hand-written. Every strike carries a reason — the field is required.

## 7. Voiding

Only an **Active** strike can be voided, it needs a reason (which is sent to the user), it immediately
re-runs escalation, and there is no delete — voided strikes stay in the history.

## 8. Jobs

| Job | Schedule | Does |
| --- | --- | --- |
| `expire-strikes` | daily 02:00 | Flips past-expiry strikes to `Expired`, notifies, re-evaluates escalation |
| `process-timed-unmutes` | hourly | Unmutes accounts whose timed mute lapsed — unless they still hold 2+ points |

A strike stops counting the moment `expiresAt` passes; the job only updates the label and notifies.

## 9. Which part of the ToS a strike is for

Measured over real strikes: **95% fall under §9.6**, the prohibited-content list. The other two were
§11.

| Reason | Clause |
| --- | --- |
| Depicting Real People · Real person model not marked | 9.6(a) — likeness of real people, any context |
| Minor in mature context · Realistic minor · NSFW minor in school environment | 9.6(b) — minors in sexualized context; "photorealistic minors in any context" |
| Bestiality · Rape/Forced Sex · Graphic Violence/Gore | 9.6(c) — illegal or violent activities |
| Mind-altered NSFW | 9.6(e) |
| Scat/Fecal matter | 9.6(f) — bodily excretions |
| Likeness/DMCA | 9.3(b)(i) and 12 |
| Harassment | 11.2 |
| Multiple accounts / Buzz manipulation | 11.8 |
| **Non AI content** | **none — the ToS never requires uploads to be AI-generated** |

Two things make this awkward to hard-code, and both are handled:

- **The letters differ per domain.** `tos.green.md` inserts an adult-content clause at 9.6(a) and
  pushes the rest down, so 9.6(a) blue is 9.6(b) green. §11 is numbered identically in both.
- **Anchor the section, not the clause, and it stops mattering.** The agreed approach is to add the id
  **at render time** rather than in the ToS files, because re-acceptance is triggered by comparing the
  file's content hash — editing the file would prompt every user on the platform to re-accept a
  document whose meaning did not change. A reader is then scrolled to §9.6, failing soft to the top of
  the document so a missing anchor can never block accepting.

  ⚠️ **Not committed yet.** It is written and tested but held back with the rest of the ToS-modal work,
  which has no trigger until the re-acceptance flow in §10 is decided.

## 10. Decisions and open items

Settled in the 2026-08-24 round (Seb, chipshajen, Kesler, Manuel):

| # | Question | Answer | State |
| --- | --- | --- | --- |
| 1 | Default strike lifetime | 365 days, flat | ✅ shipped |
| 2 | Retroactively extend existing strikes | yes — the 40 moderator-issued ones | ✅ applied to production 2026-08-24 |
| 3 | Points/expiry pickers in Mod Studio | not wanted; stays one-click | closed |
| 4 | Is the 2pt/3pt ladder right | yes | closed |
| 5 | Should anything issue strikes automatically | not at the moment | closed |
| 6 | Canned strike reasons | fine as-is | closed |
| 7 | Duplicate legacy strikes | not a display bug — a second import carrying real points | ✅ cleaned up, see [legacy-strike-migration.md](legacy-strike-migration.md) |
| 8 | One strike blocking challenge creation for a year | gate on 2+ points instead | ✅ shipped |
| 9 | Bot/spam **strike** reason | no — ban reason only ([CU-868kw67xe](https://app.clickup.com/t/8459928/868kw67xe)) | closed |
| 10 | Should a `SpamBot` ban remove content by default | yes, with a warning on the confirm dialog | ✅ shipped |
| 11 | Add "Non AI content" to the ToS | no — point the user at §9.6 without citing a clause | ✅ shipped |

**Open:**

- **What should 2 points mean?** Seb's answer to the year-long mute was *"mute their account at two
  strikes, make them read the ToS and accept it again, and only then unmute"* — an unmute the user
  earns rather than waits out. Buildable from existing parts: clearing `OnboardingSteps.TOS` re-shows
  the acceptance step, and `completeOnboardingHandler`'s TOS case is where the unmute would hook.
  Three things to decide first: escalation re-mutes on the next job run unless acceptance is recorded
  somewhere it respects; the 3-point tier must stay moderator-review rather than self-serve; and the
  onboarding wizard blocks the whole site, which is stricter than a mute. **No task filed yet.**
- **Should the main app's ban modal get a comment-removal toggle?** It has none, so a `SpamBot` ban
  issued there leaves the spam comments up. Comment removal is Mod Studio only.
