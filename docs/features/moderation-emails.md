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
| 1 | Account banned | negative | `toggleBan()` `services/user.service.ts:1571` | nothing |
| 2 | Ban lifted (overturn) | positive | `toggleBan()` (same) | nothing |
| 3 | Generation restriction **upheld** | negative | `routers/user-restriction.router.ts:119` | in-app notif |
| 4 | Generation restriction **overturned** | positive | same `:127` | in-app notif |
| 5 | Entity appeal **rejected** (= moderation upheld) | negative | `resolveEntityAppeal()` `services/report.service.ts:578` loop | in-app notif |
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
  reason?: string;   // brief explanation (publicBanReasonLabel + detailsExternal / resolvedMessage)
  ctaUrl?: string;   // defaults to mailto:support@civitai.com on negative kinds
};
```

`createEmail({ header, html, text, testData })`:
- `header` → subject per `kind`.
- `html` → `simpleEmailWithTemplate()` with per-kind heading, reason block (rendered only
  when `reason` present), and CTA button.
- Negative kinds → **Contact Support** button (`mailto:support@civitai.com`).
- Positive kinds → reinstatement copy, no CTA (or a link back to the site).

**Edit** `src/server/email/templates/index.ts`:
```ts
export { moderationActionEmail } from './moderation/moderationAction.email';
```

### Copy
- **account-banned** — "Your Civitai account has been banned." + `publicBanReasonLabel`
  (`banReasonDetails`, `server/common/constants.ts:1496`) + `detailsExternal` free text.
  **Use `publicBanReasonLabel`, never `privateBanReasonLabel`.**
- **account-unbanned** — standard reinstatement wording, no stored reason (`banDetails` is
  wiped on unban): "Your account has been reinstated and full access restored."
- **restriction-upheld / appeal-rejected** — kept-decision wording + `resolvedMessage`.
- **restriction-overturned / appeal-approved** — positive wording + `resolvedMessage`.

## Hook changes

### 1. Ban — `toggleBan()` `services/user.service.ts:1571`
Single choke point — the `mod/ban-user.ts` webhook routes through this service fn too.
- Line 1581: add `email: true` to the `getUserById` select.
- After `updatedUser` (line 1605) + cleanup, branch:
  - just-banned (`!bannedAt`) → `kind: 'account-banned'`,
    `reason = publicBanReasonLabel + detailsExternal`.
  - just-lifted → `kind: 'account-unbanned'`.
- **Skip entirely when `force === true`** (admin force-clear path — not a user-facing
  overturn).
- Wrap send in `try/catch` → `logToAxiom`; never block the ban.

### 2. Restriction — `routers/user-restriction.router.ts` `resolve` (~after line 150)
- `restriction` select only has `userId` → add a `{ email, username }` fetch.
- `Upheld` → `restriction-upheld`; `Overturned` → `restriction-overturned`;
  `reason = resolvedMessage`.
- try/catch → logToAxiom.

### 3. Appeals — `resolveEntityAppeal()` `services/report.service.ts:548` (bulk)
- Batch-fetch `{ id, email, username }` for all `appeal.userId`s **once** before the loop
  (avoid N+1).
- In the existing per-appeal loop (~line 645): `Rejected` → `appeal-rejected`,
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
  (`mailto:support@civitai.com`). Add a real Appeal deep-link only if/when an appeal
  surface exists.

## Build sequence
1. Template + `index.ts` export.
2. Ban hook (biggest gap) + add `email` to the `getUserById` select + `force` skip.
3. Restriction hook.
4. Appeal hook (batched email fetch).
5. Visual QA all six `kind` variants via the email test harness (`testData`); finalize copy.
6. typecheck / lint.

## Resolved decisions
- Unban / overturn copy → standard reinstatement wording (overturns include `resolvedMessage`).
- `force` unban → **skip** email.
- Negative emails → **Contact Support** CTA (`mailto:support@civitai.com`); no dead appeal link.
