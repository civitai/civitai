# Creator Studio — feature/page specs

Per-page design docs for `creator.civitai.com`. These sit **under** the umbrella docs — read those first:

- [../creator-studio-plan.md](../creator-studio-plan.md) — the implementation plan (scope, decisions, architecture).
- [../creator-studio-overview.md](../creator-studio-overview.md) — one-page packages + pages summary.
- [../buzz-client-handoff.md](../buzz-client-handoff.md) — the `@civitai/buzz` client (built).

**Implementation tracking:**

- [implementation-checklist.md](implementation-checklist.md) — per-page progress checklist (what's built vs. blocked/deferred).

**Pre-implementation review (open questions):**

- [pre-implementation-decisions.md](pre-implementation-decisions.md) — every open question, grouped by owner (A/B/C), with what it blocks + a recommended default.
- [questions-koen-backend.md](questions-koen-backend.md) — backend/data questions for **Koen** to answer inline (A1–A5).
- [questions-justin-product.md](questions-justin-product.md) — product/business questions for **Justin** to answer inline (B1–B11).
- [questions-justin-models-scope.md](questions-justin-models-scope.md) — follow-up `/models` scope questions for **Justin** (early-access config fields; publish/schedule in v1).

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

## Cross-cutting decisions needed (answer once — they recur across pages)

These surfaced in ≥2 page docs; deciding them once keeps the specs from drifting. **Justin's product/business review
questions** are consolidated in [plan §9](../creator-studio-plan.md#questions-for-justin--review-pass-2026-07-02).

| # | Decision | Affects | Owner |
|---|---|---|---|
| 1 | **`/licensing`: separate page vs a mode/tab of `/models`** (they share rows + the fee action) | [licensing](licensing.md), [models](models.md) | eng/design |
| 2 | **Owner-keyed earnings rollup** (§7.6 gap #1) — earnings tables key on `modelVersionId`, not the creator's `userId`; needed to scope "my" earnings/usage at scale | [dashboard](dashboard.md), [analytics](analytics.md), [earnings](earnings.md) | **backend / Koen** |
| 3 | **Charting library** (no chart primitive in `@civitai/ui`; Chart.js is React-only) + **date-range/calendar** control (no calendar primitive) | [analytics](analytics.md), [earnings](earnings.md), [dashboard](dashboard.md) | eng |
| 4 | **CP cash + withdrawal home** — dashboard vs `/earnings` vs `/settings` (pick one entry point) | [dashboard](dashboard.md), [earnings](earnings.md), [settings](settings.md) | design |
| 5 | **`/earnings` vs `/earnings/analytics` vs dashboard boundary** — what's unique to each so the same numbers don't appear (and drift) in three places | [dashboard](dashboard.md), [earnings](earnings.md), [analytics](analytics.md) | design |
| 6 | **Member gate: subscription `tier` vs full CP membership** (score ≥40k) — changes gating + `/join` CTA. Justin scoped **indefinite-sale to CP members**, so gates may be **feature-specific** (fee = `tier`, indefinite-sale = CP) | [join](join.md), [models](models.md), [licensing](licensing.md), [settings](settings.md) | **Justin** ([plan §9](../creator-studio-plan.md#9-decisions--open-questions)) |
| 7 | **Access-sale + cosmetic-sale earnings** (§7.6 gap #2, a per-`toAccountId` buzz rollup) — in v1 or defer? | [earnings](earnings.md), [dashboard](dashboard.md) | design + backend |
| 8 | **Default fee suggestion — per-account vs per-version** *(settlement currency resolved: not a creator choice — Civitai-only, special cases)* | [settings](settings.md), [models](models.md) | design |
