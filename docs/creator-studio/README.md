# Creator Studio — feature/page specs

Per-page design docs for `creator.civitai.com`. These sit **under** the umbrella docs — read those first:

- [../creator-studio-plan.md](../creator-studio-plan.md) — the implementation plan (scope, decisions, architecture).
- [../creator-studio-overview.md](../creator-studio-overview.md) — one-page packages + pages summary.
- [../buzz-client-handoff.md](../buzz-client-handoff.md) — the `@civitai/buzz` client (built).

**Implementation tracking — the single source of truth for status:**

- [implementation-checklist.md](implementation-checklist.md) — **everything open lives here**: per-page build status, open decisions, backend blockers, flagged bugs, deferred work. Start here.

**Decisions & Q&A (answered — reference/rationale):**

- [pre-implementation-decisions.md](pre-implementation-decisions.md) — the A/B/C decision log (mostly decided; the checklist tracks the few still-open ones).
- [questions-koen-backend.md](questions-koen-backend.md) — backend/data Q&A for **Koen** (A1–A5, answered).
- [questions-justin-product.md](questions-justin-product.md) — product/business Q&A for **Justin** (B1–B11, answered).
- [questions-justin-models-scope.md](questions-justin-models-scope.md) — `/models` scope Q&A for **Justin** (B12–B13).
- [feedback-justin-round-2.md](feedback-justin-round-2.md) / [models-feedback-justin.md](models-feedback-justin.md) — Justin's review notes (open items tracked in the checklist).
- [owner-rollup-handoff.md](owner-rollup-handoff.md) + [cdc-koen.md](cdc-koen.md) — the A1 owner-keyed rollup spec / the CDC ask for Koen.

Each page doc follows the same template: **Route & purpose → User story → Layout & components → Data (reads) →
Actions (writes) → States → Gating → Shared/cross-refs → Open questions.**

## Pages

| Page | Doc | v1 | Notes |
|---|---|---|---|
| Dashboard / overview | [dashboard.md](dashboard.md) | ✓ | at-a-glance earnings + entry points |
| Model management | [models.md](models.md) | ⭐ | access toggles, per-version licensing fee, sell-indefinitely |
| Analytics | [analytics.md](analytics.md) | ⭐ | `/earnings/analytics` — ClickHouse usage/earnings charts |
| Earnings | [earnings.md](earnings.md) | ✓ | `/earnings` — earnings by source (ClickHouse) |
| Licensing fees (bulk) | [licensing.md](licensing.md) | ~ | bulk fee editor; may trail the per-version editor |
| Settings | [settings.md](settings.md) | ✓ | Tipalti/tier status, default fee suggestions |
| Membership upsell | [join.md](join.md) | ✓ | `/join` — for non-members |

⭐ designer-prioritised · ✓ in v1 · ~ v1 if it lands, else fast-follow

## Cross-cutting (not a page — referenced by several)

- **Nav** — one app-local `nav.ts` constant drives the desktop sidebar + mobile header ([plan §3](../creator-studio-plan.md#3-page-list-v1)).
- **Member gate** — most write actions are member-`tier` gated; the exact bar (tier vs full CP membership) is a
  [pending confirm](../creator-studio-plan.md#9-decisions--open-questions).
- **Monetization module** — `setLicensingFee` / `bulkSetLicensingFee` / `setUnlimitedAccess`
  ([plan §5.3](../creator-studio-plan.md#53-new-monetization-operations-creator-studio-module-extract-to-a-package-at-consolidation)).
- **Analytics reads** — ClickHouse via `@civitai/clickhouse`, daily aggregates ([plan §7.6](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views)).

## Cross-cutting decisions

The recurring cross-page questions that once lived here are **now decided** and captured in
[pre-implementation-decisions.md](pre-implementation-decisions.md): `/licensing` = `?mode=bulk` on `/models` (C2),
owner-keyed rollup = build it (A1), charting = Chart.js (C1), cash home = `/earnings` (C6), page boundaries (C5),
member gate = full CP membership (B1), access/cosmetic sales in v1 (A5/B3), no per-account default fee (B9).

The few still-open ones (fee-defaults editability #17, early-access reframing #23, publish/schedule B13) are tracked
in the **[implementation checklist](implementation-checklist.md) → "Open — needs a decision"**.
