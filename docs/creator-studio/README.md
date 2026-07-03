# Creator Studio — feature/page specs

Per-page design docs for `creator.civitai.com`. These sit **under** the umbrella docs — read those first:

- [../creator-studio-plan.md](../creator-studio-plan.md) — the implementation plan (scope, decisions, architecture).
- [../creator-studio-overview.md](../creator-studio-overview.md) — one-page packages + pages summary.
- [../buzz-client-handoff.md](../buzz-client-handoff.md) — the `@civitai/buzz` client (built).

Each page doc follows the same template: **Route & purpose → User story → Layout & components → Data (reads) →
Actions (writes) → States → Gating → Shared/cross-refs → Open questions.**

## Pages

| Page | Doc | v1 | Notes |
|---|---|---|---|
| Dashboard / overview | [dashboard.md](dashboard.md) | ✓ | at-a-glance earnings + entry points |
| Model management | [models.md](models.md) | ⭐ | access toggles, per-version licensing fee, sell-indefinitely |
| Analytics | [analytics.md](analytics.md) | ⭐ | `/earnings/analytics` — ClickHouse usage/earnings charts |
| Earnings | [earnings.md](earnings.md) | ✓ | `/earnings` — earnings by source (ClickHouse) |
| Licensing fees (bulk) | [licensing.md](licensing.md) | ✓ | bulk fee editor — a mode of `/models`, not a separate page (v1-critical) |
| Settings | [settings.md](settings.md) | ✓ | Tipalti/membership status, default fee suggestions |
| Membership upsell | [join.md](join.md) | ✓ | `/join` — for non-members |

⭐ designer-prioritised · ✓ in v1 · ~ v1 if it lands, else fast-follow

## Cross-cutting (not a page — referenced by several)

- **Nav** — one app-local `nav.ts` constant drives the desktop sidebar + mobile header ([plan §3](../creator-studio-plan.md#3-page-list-v1)).
- **Member gate** — all gated write actions are gated on **Creator Program membership** (one bar for everything;
  resolved 2026-07-02).
- **Monetization module** — `setLicensingFee` / `bulkSetLicensingFee` / `setUnlimitedAccess`
  ([plan §5.3](../creator-studio-plan.md#53-new-monetization-operations-creator-studio-module-extract-to-a-package-at-consolidation)).
- **Analytics reads** — ClickHouse via `@civitai/clickhouse`, daily aggregates ([plan §7.6](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views)).

## Cross-cutting decisions (resolved 2026-07-02)

These surfaced in ≥2 page docs; deciding them once keeps the specs from drifting. All resolved from the Q&A roundup.

| # | Question | Affects | Decision |
|---|---|---|---|
| 1 | **`/licensing`: separate page vs a mode/tab of `/models`** (they share rows + the fee action) | [licensing](licensing.md), [models](models.md) | **Mode of `/models`** — a bulk-edit column/mode; no separate page. |
| 2 | **Owner-keyed earnings rollup** (§7.6 gap #1) — earnings tables key on `modelVersionId`, not the creator's `userId` | [dashboard](dashboard.md), [analytics](analytics.md), [earnings](earnings.md) | **ClickPipe/CDC → `modelVersion → ownerUserId` CH dictionary → owner-keyed AggregatingMergeTree MV.** Build handoff at [../plans/creator-studio-owner-rollup-handoff.md](../plans/creator-studio-owner-rollup-handoff.md); version-ID query is the fallback. |
| 3 | **Charting library** + **date-range/calendar** control (none in `@civitai/ui`) | [analytics](analytics.md), [earnings](earnings.md), [dashboard](dashboard.md) | **LayerChart** (via shadcn-svelte, primitives in `@civitai/ui`; LayerChart 2.0) + **adopt a date picker**. |
| 4 | **CP cash + withdrawal home** — dashboard vs `/earnings` vs `/settings` | [dashboard](dashboard.md), [earnings](earnings.md), [settings](settings.md) | **`/earnings`** — single entry point (dashboard shows a condensed preview + links out). |
| 5 | **`/earnings` vs `/earnings/analytics` vs dashboard boundary** | [dashboard](dashboard.md), [earnings](earnings.md), [analytics](analytics.md) | **Analytics = non-buzz usage** (generations, downloads); **earnings = buzz + real-dollar cash**; dashboard = condensed preview. |
| 6 | **Member gate: subscription `tier` vs full CP membership** | [join](join.md), [models](models.md), [licensing](licensing.md), [settings](settings.md) | **Creator Program membership — a single bar for all gated actions** (no feature-specific / tier hedging). |
| 7 | **Access-sale + cosmetic-sale earnings** (§7.6 gap #2, a per-`toAccountId` buzz rollup) — in v1 or defer? | [earnings](earnings.md), [dashboard](dashboard.md) | **In v1** (all sources day 1 ideally); needs the gap #2 per-`toAccountId` MV. |
| 8 | **Default fee suggestion — per-account vs per-version** *(settlement currency: not a creator choice — Civitai-only)* | [settings](settings.md), [models](models.md) | **Per-account baseline in Settings**, overridable per version in `/models`. |
