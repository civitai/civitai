# Retool → moderator app: task breakdown

Task list derived from ClickUp [868kkxqpn](https://app.clickup.com/t/868kkxqpn) — *Moderation Tooling — Retool
→ Civitai migration (design)*. Each item below is sized to be independently shippable and states what it
depends on.

Status column reflects what is in `apps/moderator` today, cross-checked against `NAVIGATION` in
[access.ts](../../apps/moderator/src/lib/server/access.ts) and the route tree.

## Where the ticket already meets reality

| Ticket § | Item | Status |
|---|---|---|
| Conventions | Permissions gated by mod role | **done** — per-role grants, `/admin` |
| 1.1 | Overview page, per-queue counts | **partial** — dashboard lists reachable queues by count; anti-overlap not started |
| 1.2 | User Lookup | **partial** — `/retool/user-lookup` ships; 97 of 170 export queries unported, see [user-lookup-audit.md](retool-exports/user-lookup-audit.md) |
| 1.3 | Bulk Image Manager | not started (`ImageQueueGrid` + cosmetics multi-select are reusable) |
| 1.5 | User / Post Reports | **partial** — `/reports` exists; no per-report image grid, no prior-mod-activity panel |
| 1.6 | Chat Audit | **done** — `/retool/chat-audit`, read-only; all 4 tabs + every export query ported or classified |
| 1.7 | Image Lookup | **done** — `/retool/image-lookup`, 10/10 queries, 4/4 tabs |
| 1.8 | Article Lookup | not started (`/articles/*` covers queues, not lookup) |
| 1.9 | Front Page Audit | not started — **blocked on an open question** |
| 1.12 | Buzz add/subtract | not started — **blocked on an open question** |
| 2.1 | Bulk Ban | not started |
| 2.2 | Moderation Rules | not started |
| 2.3 | Model notes | not started |
| 2 | Retool Workflows | not started |

Already migrated and not in the ticket's scope: image review queues, article queues, blocklists,
prohibited prompts / prompt tester / scanner audit, comics review, grant cosmetics.

## Phase 0 — cross-cutting foundations

These are named in the ticket's "Conventions" section and are prerequisites for most apps below. Doing them
first avoids each app inventing its own version.

**0.1 Shared entity resolver.** One resolver accepting user ID / username / email, extended for content
tools with post ID / model ID / model version ID. Returns a discriminated result so callers can branch.
Consumed by 1.2, 1.3, 1.7, 1.8, 2.1.

**0.2 Mod action log.** Every action recorded with actor, action, target, reason, timestamp. Backs the
"previous mod activity — show who did it" panels (1.2, 1.5) and the anti-overlap system (1.1).

`ModActivity` is now **append-only** — the `@@unique([activity, entityType, entityId])` that collapsed
repeats into a single row is dropped, and all three writers (main app `trackModActivity`, spoke
`recordModActivity`, auth-hub `trackImpersonation`) plain-INSERT. Indexes for the read patterns this
enables are in place: `(entityType, entityId, createdAt)` and `(userId, createdAt)`.

Remaining gap: **no reason/detail column.** The ticket wants reason recorded alongside the action, so 0.2
still needs a `details jsonb` (or equivalent) column before 1.2e/1.5 can show *why* an action was taken.

> **History starts from the migration.** Rows written before it were deduped in place, so the table holds
> only the last actor per entity for everything prior. Any "previous mod activity" panel will look sparse
> for older accounts — worth stating in the UI rather than implying the record is complete.

**0.3 Retool DB data migration.** Moderation notes, strikes, and timed mutes live in the Retool DB
(8 queries per the ticket's own inventory). Migrating the UI without the data leaves both systems
authoritative. Needs: target schema, backfill, cutover plan, and a decision on whether Retool keeps
writing during transition.

**0.4 Action attribution in shared services.** Route the actions the ticket lists (ban, ToS, strike, mute,
note, buzz) through the existing `mod-actions/registry.ts` seam rather than new ad-hoc endpoints, so the
main app and the spoke stay on one code path.

## Phase 1 — top priority (ticket's own labelling)

**1.1a Anti-overlap.** Pick a mechanism — check-in, action-logging warnings, or both (open question).
Depends on 0.2.

**1.1b Dashboard queue coverage.** The dashboard currently surfaces only queues carrying a `countKey`
(13, all under Images/Articles). Extend counts to the remaining queues so the overview is complete.

**1.2 User Lookup.** The single largest item — the Retool app is 603 components / 122 queries across 6
backends. Do **not** scope as one task. Suggested split, each shippable:

- 1.2a Shell: resolver input, identity/profile, content counts, Civitai score
- 1.2b Reports panel — filed against / by the user
- 1.2c Moderation memory — notes (editable by author), strikes, mute status + history
- 1.2d Security signals — registration/activity IPs, shared-IP accounts, spam heuristics, generation abuse
- 1.2e Prior mod activity panel (depends on 0.2)
- 1.2f Content actions — comments bulk delete / ToS, blocked prompts list
- 1.2g Account actions — ban/unban, purge content, mute, force logout, edit socials & bio
- 1.2h Subscription & Buzz — balances, receipts, payments, Stripe deep link. **No Paddle** (decided
  2026-08-07; the deep link was built anyway and removed 2026-08-21).
- 1.2i Support context — Freshdesk contact match
- 1.2j LoRA trainings, DMs sent
- 1.2k "Talked to another mod before" popup (depends on 0.2)

**1.3 Bulk Image Manager.** Masonry grid + multi-select reusing `ImageQueueGrid`; load by entity (0.1);
bulk ToS with reason + optional strike; filters for nsfwLevel (incl. Blocked) and dates.

## Phase 2 — remaining V1 apps

**1.5 Reports upgrade.** Per-report image grid inline, plus prior mod activity and prior reports on the
same screen (ticket's "everything on one screen"). Depends on 0.2.

**1.6 Chat Audit.** Shipped read-only at `/retool/chat-audit`. The open questions resolved as: read-only
(Retool's BANAPI/SetNote deliberately not ported — enforcement stays in User Lookup, which has the context
and the audit trail); visible to admin-tier grants only by default; no retention change. All four Retool
tabs are ported — search/transcript, reports queue, insights (top chatters/chats, all-time and 24h, repeated
messages), and Newest. Message bodies outside an opened transcript sit behind a "Show message text" toggle.

**1.7 Image Lookup.** Shipped at `/retool/image-lookup`. Audited complete against the export: 10/10 queries,
4/4 tabs.

**1.8 Article Lookup.** Full Article row by ID.

**1.12 Buzz add/subtract.** Blocked on open question — standalone app or folded into 1.2h.

## Phase 3 — V2 and lower priority

**2.1 Bulk Ban** — restricted tool; ban a list of users. Needs its own role restriction (the grant system
supports this) and 0.1 for list resolution.

**2.2 Moderation Rules** — ticket marks this low priority, "not used much."

**2.3 Model notes** — free-text mod notes on models; existing change history covers the rest.

## Phase 4 — workflows

Two Retool Workflows are confirmed active and need migrating:

- Daily Challenge — Not Prepared Check (`78e2bb67…`)
- Daily Challenge — Not Started Check (`ceb7402d…`)

The ticket author is not certain these are the only live ones — **audit remaining Retool workflows for
usage before decommissioning anything.**

## Open questions blocking scope

Carried from the ticket; each blocks the item next to it.

| Question | Blocks |
|---|---|
| Front Page Audit — drop, or keep a video-only slim version? | 1.9 |
| Buzz — standalone app or inside User Lookup? | 1.12 |
| Anti-overlap — check-in, action-logging warnings, or both? | 1.1a |
| Permissions — which role tier gets which tool/action? | grant config for every new page |

## Note on the ticket itself

Sections **1.4, 1.10, and 1.11 are absent** from the description — the numbering jumps 1.3 → 1.5 → 1.9 →
1.12. Either they were dropped deliberately or lost in editing; worth confirming nothing is missing before
treating this list as complete.
