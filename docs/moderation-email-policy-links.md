---
title: Moderation emails — ToS links + free-text removal
status: implemented
date: 2026-06-16
---

# Moderation emails: ToS links + free-text removal

Two mod-team concerns, both addressed:
1. Raw reasons read too explicit → users retaliate wrongly. Fix: link to the Terms of Service instead of a blunt reason.
2. Moderator free-text lands in the user's inbox → a mod could send a hateful/targeted message. Fix: never email mod free-text.

## Principle

Emails render only **structured, pre-approved content** — a sanitized label + a ToS link. **Moderator free-text is never emailed**; it stays internal (`meta.banDetails`, `UserStrike.description`, the in-app restriction notification) for appeal/Retool/audit.

## Behavior

- A `/content/tos` link is shown on **negative** outcomes only: `account-banned`, `restriction-upheld`, `appeal-rejected`. Positive outcomes (`account-unbanned`, `restriction-overturned`, `appeal-approved`) get no reason and no link.
- **Ban**: shows `publicBanReasonLabel` (already sanitized) + ToS link. `detailsExternal` dropped from email, still stored in `meta.banDetails`.
- **Restriction**: `resolvedMessage` dropped from email; in-app notification still shows it.
- **Strike**: shows `strikeReasonPublicLabel` (below) + ToS link instead of the raw `description`. `description` still stored on `UserStrike` and shown in-app/Retool.

Single ToS target for everything — no per-reason-code page mapping (considered, rejected for simplicity). ToS section deep-linking was also rejected: `tos.md` sections are bold paragraphs, not headings, and the renderer has no `rehype-slug`, so there are no stable anchors.

## Strike reason labels

`strikeReasonPublicLabel` in `src/server/schema/strike.schema.ts` (one neutral, non-explicit label per `StrikeReason`):

| StrikeReason | Email label |
|---|---|
| `BlockedContent` | Blocked content |
| `RealisticMinorContent` | Realistic minor content |
| `CSAMContent` | Child safety violation |
| `TOSViolation` | Terms of Service violation |
| `HarassmentContent` | Harassment |
| `ProhibitedContent` | Prohibited content |
| `ManualModAction` | Moderator action |

## Files

- `src/server/email/templates/moderation/moderationAction.email.ts` — ToS link block on negative kinds (html + text).
- `src/server/email/templates/strikeIssued.email.ts` — renders label + ToS link, drops `description`.
- `src/server/services/user.service.ts` (`toggleBan`) — ban email reason = `publicBanReasonLabel` only.
- `src/server/routers/user-restriction.router.ts` — omits `resolvedMessage` from email.
- `src/server/schema/strike.schema.ts` — `strikeReasonPublicLabel` map.

No DB migration (all fields already exist).

## Note

The strike system is still `['dev','granted']` (not GA — Phase 1, no automated issuer yet), so the strike email only fires when a dev/granted moderator issues a strike. The email improvements above are independent of that flag.
