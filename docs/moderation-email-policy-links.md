---
title: Moderation email — policy links + free-text removal
status: implemented (pending review/QA)
author: ai
date: 2026-06-16
---

## Resolved decisions (2026-06-16)

Mod team chose **simplicity over per-code page mapping**:
- **All moderation emails link to `/content/tos`** (single target), shown on **negative kinds only** (`account-banned`, `restriction-upheld`, `appeal-rejected`) — never on lifts/overturns/approvals.
- **Ban**: email shows `publicBanReasonLabel` + TOS link. `detailsExternal` (mod free-text) **dropped from email**, still stored in `meta.banDetails`.
- **Strike**: new `strikeReasonPublicLabel` map (mirrors `publicBanReasonLabel`); email shows that label + TOS link. `UserStrike.description` (mod free-text) **dropped from email**, still stored + shown in-app/Retool.
- **Restriction**: `resolvedMessage` (mod free-text) **dropped from email**; in-app notification keeps it. TOS link shown on upheld.

The per-code → per-page mapping tables below are **superseded** by the single-TOS-link decision, but kept for history / future per-page work.

---

# Moderation email: policy links + free-text removal

Two mod-team asks:
1. Link mod-action emails to the relevant policy instead of a blunt raw reason (reduce wrong-target retaliation).
2. Stop exposing mod free-text in the email (a mod could write a hateful/targeted message that lands in the user's inbox).

This doc is the **mapping table + design for review**. Nothing is built yet. Leave `@dev:` comments inline; I'll action them.

---

## Design principle

> Emails render **only structured, pre-approved content**: a sanitized public label + a policy link derived from an enum code. **Mod free-text is never emailed** — it stays internal (stored in `meta` / `internalNotes`, visible in Retool + appeal flow).

This single rule satisfies both asks: the link gives a non-explicit reference, and removing free-text closes the "hateful message in the inbox" vector.

---

## 1. Ban reason → policy link mapping

Source enum: `BanReasonCode` (`src/server/common/enums.ts:326`), labels in `banReasonDetails` (`src/server/common/constants.ts:1496`). The email already uses `publicBanReasonLabel` (sanitized) — we keep that and add a link.

| Code | publicBanReasonLabel (shown today) | Proposed link target | Page exists? |
|---|---|---|---|
| `SexualMinor` | Content violated ToS | `/content/rules/minors` | ✅ |
| `SexualMinorGenerator` | Content violated ToS | `/content/rules/minors` | ✅ |
| `SexualMinorTraining` | Content violated ToS | `/content/rules/minors` | ✅ |
| `SexualPOI` | Content violated ToS | `/content/rules/real-people` | ✅ |
| `Bestiality` | Content violated ToS | `/content/moderation` | ✅ (general) |
| `Scat` | Content violated ToS | `/content/moderation` | ✅ (general) |
| `Nudify` | Content violated ToS | `/content/rules/real-people` | ✅ ⚠️ see note |
| `Harassment` | Community Abuse | `/content/tos` ⚠️ | ❌ no dedicated page |
| `LeaderboardCheating` | Leaderboard manipulation | `/content/tos` ⚠️ | ❌ no dedicated page |
| `BuzzCheating` | Abusing Buzz System | `/content/buzz/terms` | ✅ |
| `RRDViolation` | Violated Responsible Resource Development | `/content/rules/real-people` ⚠️ | ❌ no RRD page |
| `Other` | (empty) | `/content/tos` (whole) | ✅ fallback |

**Notes / open questions:**
- ⚠️ `Nudify` — nudify resources usually target real individuals → mapped to real-people. Could also be `/content/moderation`. `@dev:` which?
- ⚠️ `Harassment`, `LeaderboardCheating`, `RRDViolation` — **no dedicated policy page exists.** Options: (a) point to whole `/content/tos`, (b) you create short policy pages for these, (c) add TOS section anchors (heavier — see §4). `@dev:` pick per row.
- `Bestiality`/`Scat` → `/content/moderation` is the general content-policy page; fine, but not specific. `@dev:` ok, or do you want a "Prohibited Content" page?

---

## 2. Strike reason → policy link mapping

Source enum: `StrikeReason` (`prisma/schema.full.prisma`). Today the strike email shows only the free-text `description`; the enum is passed but unused. Proposal: show an enum-derived label + link, drop/soften free-text (see §3).

| Code | Proposed user-facing label | Proposed link target | Page exists? |
|---|---|---|---|
| `BlockedContent` | Blocked content | `/content/moderation` | ✅ |
| `RealisticMinorContent` | Realistic minor content | `/content/rules/minors` | ✅ |
| `CSAMContent` | Child safety violation | `/content/rules/minors` | ✅ |
| `TOSViolation` | Terms of Service violation | `/content/tos` | ✅ |
| `HarassmentContent` | Harassment | `/content/tos` ⚠️ | ❌ no dedicated page |
| `ProhibitedContent` | Prohibited content | `/content/moderation` | ✅ |
| `ManualModAction` | Moderator action | `/content/tos` (whole) | ✅ fallback |

`@dev:` confirm the user-facing labels above — these are first-draft wording.

---

## 3. Free-text removal (the second fear)

What's free-text today and where it lands in the email:

| Email | Free-text field | Is it the ONLY content? | Proposed change |
|---|---|---|---|
| Ban (`moderationAction.email.ts`) | `detailsExternal` (appended after public label) | No — public label still there | **Drop `detailsExternal` from email.** Keep storing it in `meta.banDetails` for appeal/Retool. Email = public label + link. |
| Restriction (`moderationAction.email.ts`) | `resolvedMessage` | **Yes** — nothing else | Restrictions have no enum. Either (a) email a neutral generic line + `/content/tos` link, or (b) add a mod **category dropdown** so it becomes enum-linkable. `@dev:` (a) or (b)? |
| Strike (`strikeIssued.email.ts`) | `description` | **Yes** — nothing else | Replace with enum label + link from §2. `description` still stored on `UserStrike` + shown in-app/Retool, just not emailed. `@dev:` ok to also drop it from the in-app notification, or email-only? |

**Net effect:** no mod-authored prose ever reaches the user's inbox. A malicious mod can't use the email as a delivery channel. Internal record-keeping (appeals, audit) keeps the free-text.

`@dev:` One tradeoff to confirm: today `detailsExternal` lets a mod give a *specific, legitimate* reason ("your model X violated…"). Dropping it makes every email generic. Acceptable? Or do we want a **pre-approved snippet picker** (mod selects from a fixed list) instead of free typing — best of both?

---

## 4. (Optional) TOS section deep-links — only if you reject whole-page links

The TOS (`src/static-content/tos.md`) has **no anchors** — sections are bold numbered paragraphs, not `#` headings, and the renderer has no `rehype-slug`. The existing `/content/tos#content-policies` link is **dead**. To deep-link a TOS subsection we'd need to:
1. Inject raw `<a id="...">` targets into `tos.md` before each linked section (`rehypeRaw` is enabled, so this works), AND
2. Add a hash-scroll-on-mount fix (content loads async via tRPC; native hash scroll fires before render).

Recommendation: **skip this.** Whole friendlier pages (§1/§2) read less explicit and need none of this surgery. Listed only for completeness.

---

## Implementation surface (once mapping is approved)

- `src/server/common/constants.ts` — extend `banReasonDetails` with `policyUrl`; add new `strikeReasonDetails: Record<StrikeReason, { label; policyUrl }>`.
- `src/server/services/user.service.ts` `toggleBan` — pass `reasonCode` (not just composed string) to email; stop appending `detailsExternal`.
- `src/server/services/strike.service.ts` — pass `reason` enum through; template renders label+link instead of `description`.
- `src/server/email/templates/moderation/moderationAction.email.ts` + `strikeIssued.email.ts` — render a link block from the code; remove raw free-text rendering.
- Restriction path (`user-restriction.router.ts`) — depends on §3 (a) vs (b) decision.

No DB migration needed (all fields already exist).
