# Moderation Emails — Strikes, Bans, Restrictions, Appeals

ClickUp: [868k09up1 — Emails for Strikes and Bans](https://app.clickup.com/t/868k09up1)

## Goal
Reduce the support-ticket queue ("why was I restricted?") by emailing users a brief
explanation when a moderation action is **upheld** (kept) or a **ban** is applied, and a
positive email when an action is **overturned** (reversed).

## Scope (confirmed)
Six transactional emails across three surfaces. **Always-send** — bypass
`UserNotificationSettings` (account-restriction mail is critical/transactional, matching
the existing `strikeIssuedEmail` behavior).

Strikes are **out of scope** — `strikeIssued.email.ts` already covers "strike issued",
and strike-void has an in-app notification. This task adds the missing surfaces.

| # | Event | Tone | Hook | Today |
|---|-------|------|------|-------|
| 1 | Account banned | negative | `toggleBan()` `services/user.service.ts` | nothing |
| 2 | Ban lifted (overturn) | positive | `toggleBan()` (same) | nothing |
| 3 | Generation restriction **upheld** | negative | `routers/user-restriction.router.ts` | in-app notif |
| 4 | Generation restriction **overturned** | positive | same | in-app notif |
| 5 | Entity appeal **rejected** (= moderation upheld) | negative | `resolveEntityAppeal()` `services/report.service.ts` loop | in-app notif |
| 6 | Entity appeal **approved** (= overturned) | positive | same | in-app notif |

**"Upheld" mapping:** moderator decides to keep the restriction → email the user the
reason. **"Overturn":** moderator reverses → positive email. Restriction
`Upheld`/`Overturned` and appeal `Rejected`/`Approved` are already distinct DB states.
Bans have no appeal state machine — ban-applied carries the reason; ban-lifted is the
overturn.

## Design — single parameterized template
One template, `kind` discriminator carrying per-kind subject / heading / tone. DRY +
consistent copy. Built on `simpleEmailWithTemplate()` (`email/templates/util.ts` — logo,
brand colors, optional button).

**New file** `src/server/email/templates/moderation/moderationAction.email.ts`

```ts
type ModerationActionKind =
  | 'account-banned'
  | 'account-unbanned'
  | 'restriction-upheld'
  | 'restriction-overturned'
  | 'appeal-rejected'
  | 'appeal-approved';

type ModerationActionEmailData = {
  to: string | null;
  username: string;
  kind: ModerationActionKind;
  reason?: string;   // sanitized label only (e.g. publicBanReasonLabel). Mod free-text is NOT emailed — see "Policy links + free-text removal" below.
  ctaUrl?: string;   // defaults to https://support.civitai.com on negative kinds
};
```

`createEmail({ header, html, text, testData })`:
- `header` → subject per `kind`.
- `html` → `simpleEmailWithTemplate()` with per-kind heading, reason block (rendered only
  when `reason` present), and CTA button.
- Negative kinds → **Contact Support** button (`https://support.civitai.com`).
- Positive kinds → reinstatement copy, no CTA (or a link back to the site).

**Edit** `src/server/email/templates/index.ts`:
```ts
export { moderationActionEmail } from './moderation/moderationAction.email';
```

### Copy
> Updated 2026-06 — negative kinds now append a Terms of Service link and moderator
> free-text is no longer emailed. See "Policy links + free-text removal" below.
- **account-banned** — "Your Civitai account has been banned." + `publicBanReasonLabel`
  (`banReasonDetails`, `server/common/constants.ts`) + ToS link.
  **Use `publicBanReasonLabel`, never `privateBanReasonLabel`.** `detailsExternal` is no
  longer emailed.
- **account-unbanned** — standard reinstatement wording, no stored reason (`banDetails` is
  wiped on unban): "Your account has been reinstated and full access restored."
- **restriction-upheld** — kept-decision wording + ToS link. `resolvedMessage` no longer emailed.
- **appeal-rejected** — kept-decision wording + ToS link. (Still emails `resolvedMessage` —
  see the gap note below.)
- **restriction-overturned / appeal-approved** — positive wording, no reason, no link.

## Hook changes

### 1. Ban — `toggleBan()` `services/user.service.ts`
Single choke point — the `mod/ban-user.ts` webhook routes through this service fn too.
- Add `email: true` to the `getUserById` select.
- After `updatedUser` + cleanup, branch:
  - just-banned (`!bannedAt`) → `kind: 'account-banned'`,
    `reason = publicBanReasonLabel + detailsExternal`.
  - just-lifted → `kind: 'account-unbanned'`.
- **Skip entirely when `force === true`** (admin force-clear path — not a user-facing
  overturn).
- Wrap send in `try/catch` → `logToAxiom`; never block the ban.

### 2. Restriction — `routers/user-restriction.router.ts` `resolve`
- `restriction` select only has `userId` → add a `{ email, username }` fetch.
- `Upheld` → `restriction-upheld`; `Overturned` → `restriction-overturned`;
  `reason = resolvedMessage`.
- try/catch → logToAxiom.

### 3. Appeals — `resolveEntityAppeal()` `services/report.service.ts` (bulk)
- Batch-fetch `{ id, email, username }` for all `appeal.userId`s **once** before the loop
  (avoid N+1).
- In the existing per-appeal loop: `Rejected` → `appeal-rejected`,
  `Approved` → `appeal-approved`, `reason = resolvedMessage`.
- Send to all appeal users regardless of `entityType` (matches the existing notification,
  which fires for every appeal even though the entity switch only handles `Image`).
- try/catch per send.

## Cross-cutting
- **Failure isolation** — every send wrapped, logged to Axiom, never throws into the
  moderation flow. Mirrors `strikeIssued` + ban-cleanup patterns.
- **No in-app notif for ban** — a banned user can't see the in-app feed; email is the only
  channel. Don't add a notification.
- **Missing email** — skip silently when `user.email` is null.
- **Volume** — appeal resolution is bulk; batched email fetch + sequential sends is
  acceptable (inline pattern). If batches grow large, revisit with a queue.
- **CTA caveat** — there's no self-serve appeal *page* for account bans/strikes; users
  appeal via support email. Entity appeals happen in-app (`AppealDialog.tsx`) and a
  rejected appeal can't be re-appealed. So the CTA is **Contact Support**
  (`https://support.civitai.com`). Add a real Appeal deep-link only if/when an appeal
  surface exists.

## Build sequence
1. Template + `index.ts` export.
2. Ban hook (biggest gap) + add `email` to the `getUserById` select + `force` skip.
3. Restriction hook.
4. Appeal hook (batched email fetch).
5. Visual QA all six `kind` variants via the email test harness (`testData`); finalize copy.
6. typecheck / lint.

## Resolved decisions
- Unban / overturn copy → standard reinstatement wording. Positive kinds carry no reason and
  no ToS link (updated 2026-06).
- `force` unban → **skip** email.
- Negative emails → **Contact Support** CTA (`https://support.civitai.com`); no dead appeal link.

## Policy links + free-text removal (update 2026-06)

Mod-team follow-up. Two goals: (1) link emails to the ToS instead of a blunt reason, so
users retaliate less from over-explicit text; (2) stop emailing moderator free-text — a mod
could otherwise send a hateful/targeted message via the email.

**Principle:** emails render only structured, pre-approved content (sanitized label + ToS
link). Moderator free-text stays internal (`meta.banDetails`, `UserStrike.description`, the
in-app restriction notification) for appeal/Retool/audit — never emailed.

**Behavior:**
- A `/content/tos` link is appended on **negative** kinds only (`account-banned`,
  `restriction-upheld`, `appeal-rejected`). Positive kinds get no reason and no link.
- **Ban** — `reason` = `publicBanReasonLabel` only; `detailsExternal` dropped from email,
  still stored in `meta.banDetails`.
- **Restriction** — `resolvedMessage` dropped from email; in-app notification keeps it.
- **Strike** (`strikeIssued.email.ts`) — shows `strikeReasonPublicLabel` + ToS link instead
  of the raw `description`; `description` still stored on `UserStrike` and shown in-app/Retool.

Single ToS target — no per-reason-code page mapping, and no ToS section anchors (`tos.md`
sections are bold paragraphs, not headings, and the renderer has no `rehype-slug`).

**`strikeReasonPublicLabel`** (`src/server/schema/strike.schema.ts`):

| StrikeReason | Email label |
|---|---|
| BlockedContent | Blocked content |
| RealisticMinorContent | Realistic minor content |
| CSAMContent | Child safety violation |
| TOSViolation | Terms of Service violation |
| HarassmentContent | Harassment |
| ProhibitedContent | Prohibited content |
| ManualModAction | Moderator action |

**Files touched:** `moderationAction.email.ts`, `strikeIssued.email.ts`,
`user.service.ts` (`toggleBan`), `user-restriction.router.ts`, `strike.schema.ts`.

**Known gap:** the appeal path (`resolveEntityAppeal()`, `services/report.service.ts:706`)
still passes `reason: resolvedMessage` to `appeal-rejected`, so moderator free-text is still
emailed there. Ban / restriction / strike were stripped; appeals were not. Strip for
consistency if the same targeting concern applies.

**Strike availability:** strikes remain `['dev','granted']` (not GA — Phase 1, no automated
issuer), so the strike email only fires when a dev/granted moderator issues a strike. The
email changes above are independent of that flag.
