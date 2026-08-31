# `/earnings` — Earnings by source ✓

> **v1.** The "how much money, from what" view: a creator's earnings broken down **by source** (license fees, tips,
> generation compensation, model-access + cosmetic sales), with totals and a time-series, plus a link out to CP
> cash/withdrawal. **Read-only.** Umbrella: [plan §3](../creator-studio-plan.md#3-page-list-v1); reads
> [plan §7.6](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views).
>
> **Unblocked 2026-07-14 (D2).** All five sources read from `default.buzzTransactions`, which is already
> owner-keyed — **gap #1 and gap #2 no longer gate this page**, and no source is deferred.

## User story

As a creator, I open `/earnings` and see **how much I've earned and where it came from** — a total for the selected
window, split by source (license fees / tips / compensation / sales), a time-series of daily earnings, and my current
CP cash (pending + settled) with a way to withdraw. It answers *"how much money, from what"*; the *"what usage drives
it"* view (generations, downloads, per-model funnels) lives on [analytics.md](analytics.md) at `/earnings/analytics`.

## Layout & components

`@civitai/ui` (shadcn-svelte) primitives — don't hand-build:

- **Totals `card`s** — one per source (License fees · Tips · Compensation · Access sales · Cosmetic sales) + a grand
  total, each with the window's sum and a `badge` for delta vs. prior window.
- **`table`** — earnings by source × period (or a breakdown table under the chart); `tabs` to switch window
  (7d / 30d / all) or granularity (daily / monthly).
- **Time-series chart** — daily/stacked-by-source earnings. ⚠️ **No chart primitive in `@civitai/ui`** — the charting
  lib is a shared decision with [analytics.md](analytics.md) (flag, don't pick here).
- **CP cash panel** — pending + settled cash and a **Withdraw** button that **links out** to the existing CP flow
  (don't rebuild payout); see Shared.
- **`skeleton`** for load; **`sonner`** only for the (rare) refresh/error toast.

## Data (reads) — `+page.server.ts`

**All earnings reads come from ClickHouse** via `@civitai/clickhouse` (daily aggregates / materialized views — the buzz
service is too slow) ([plan §5.1](../creator-studio-plan.md#51-the-core-architectural-decision--where-does-business-logic-run),
[§7.6](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views)). Scoped to `locals.user.id`:

- **Earnings by source** — **all five sources read from `default.buzzTransactions`**, filtered on
  `toAccountId = locals.user.id`, grouped by `toAccountType` to keep currencies separate (B8: no conversion).
  Justin's **D2** call (2026-07-14): creators are paid *via buzz transactions*, so that is where earnings live —
  **not** `resourceCompensations`. One table, one query, no union.

  | Source | Filter |
  |---|---|
  | Tip | `type = 'tip'` |
  | Compensation | `type = 'compensation'` |
  | License fee | `type IN ('licenseFee','27')` — ⚠️ ingest bug, see below |
  | Access sale | `type = 'purchase' AND externalTransactionId LIKE 'early-access-%'` |
  | Cosmetic sale | `type = 'sell'` |

  ⚠️ **`type='purchase'` alone is NOT a sale** — it is dominated by users topping up their **own** buzz (90d:
  39,402 `np-deposit-` rows / 686M buzz vs 29,993 `early-access-` / 54.8M), and those carry `toAccountId` = the
  buyer. A naive `toAccountId = X AND type='purchase'` counts a creator's own buzz purchases as earnings. Always
  filter on the `externalTransactionId` prefix. Exclude `accountId = 0` (system/platform account).
  ⚠️ **License fees currently land as `type='27'`** — the ingest MV's int→string map stops at 26 and falls back to
  `toString(Type)`. Justin owns the fix + backfill; filter both values until it lands, or the card reads zero.
- **No owner-keyed rollup dependency, and no dictionary.** That `modelVersionId`-keying problem is real for
  *usage* tables, but not for buzz transactions: `default.buzzTransactions.toAccountId` **is** the creator's
  `userId` (verified 1:1), and the table ships a `PROJECTION byToAccount (SELECT * ORDER BY toAccountId, date, …)`
  making owner-keyed reads cheap. **Gap #1 and gap #2 no longer block this page** — the dictionary survives only
  for the per-model table on [analytics.md](analytics.md). See [owner-rollup-handoff.md](owner-rollup-handoff.md).
- **Amounts are integers, and that is correct.** `resourceCompensations` is fractional **accrual**;
  `buzzTransactions` is integer **settlement** (the nightly job floors once at the daily boundary, per A2). This
  page reports what the creator was actually paid, so integers are the right unit.
- **CP cash / banked** — `creatorProgram.getCash` / `getBanked`
  ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices)) for the pending/settled panel.
- **Not** the buzz service; **no** per-version monetization writes here (those are [models.md](models.md)).

## Actions (writes) — none

This page is **read-only**. The only "action" is **Withdraw**, which is a link out to the existing CP cash/withdrawal
flow ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices)) — not a form action here.

## States

- **Loading** — skeleton cards + chart placeholder.
- **Empty** — creator has never earned → friendly empty state + link to [models.md](models.md) (set a fee) / upload.
- ~~**Partial sources**~~ — **no longer needed.** All five sources read from the same table (D2), so there is no
  deferred-source state to design for.
- **Pre-cutover** — license-fee earnings may be **not-yet-payable** until the comp⇆fee cutover (~1 week after v1,
  [plan §7.1](../creator-studio-plan.md#71-schema--data-main-app-db)); label them so totals aren't misread as cash.
- **Error** — ClickHouse read fails → inline error card, CP cash panel can still render independently.

## Gating

**Any logged-in user can access** — this is a read, and member-`tier` gating is per-*action* (fee-setting on
[models.md](models.md)), not per-view ([plan §9](../creator-studio-plan.md#9-decisions--open-questions)). Non-members
see their own earnings normally.

## Shared / cross-refs

- **[analytics.md](analytics.md)** (`/earnings/analytics`) — the usage side (generations/downloads/funnels) that
  *drives* these earnings; shares the ClickHouse read module and the charting-lib decision.
- **[models.md](models.md)** — where fees/access are *set* (the writes); `/earnings` shows what they *earned*.
- **[dashboard.md](dashboard.md)** — the at-a-glance total; `/earnings` is the full by-source breakdown.
- **CP cash / withdrawal** — the existing main-app / Creator Program flow
  ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices)); linked, not rebuilt.
- Legacy `getDailyCompensationRewardByUser` (main app) is being redirected; both converge on one CH read module at the
  full cutover ([§7.6](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views)).

## Open questions

- ~~**Which sources ship in v1?**~~ **ANSWERED (D2, 2026-07-14): all five.** They are one query against
  `default.buzzTransactions`; there is no cost to including access/cosmetic, so nothing defers.
- ~~**Owner-keyed rollup (gap #1) is a hard dependency**~~ **ANSWERED: not for this page.** `buzzTransactions` is
  already owner-keyed (`toAccountId`) with a `byToAccount` projection. The dictionary is still scheduled, but only
  [analytics.md](analytics.md)'s per-model table needs it.
- ~~**"top-earning models"**~~ **ANSWERED (2026-07-14): it ships, so it keeps the A1 dependency.** It is not
  answerable from `buzzTransactions` (comp/licenseFee rows are per-creator daily aggregates with no
  `modelVersionId`), so it reads `resourceCompensations` via the gap #1 dictionary — `IN (…)` fallback until that
  lands. **Do not present per-model earnings and by-source totals as the same number**: the former is fractional
  *accrual*, the latter integer *settlement*.
- **`/earnings` vs `/earnings/analytics` vs dashboard boundary** — what is *unique* to `/earnings` (by-source totals +
  cash) so it doesn't duplicate the other two?
- **CP cash + withdrawal — inline or link-out?** Surface pending/settled + Withdraw here, or send fully to the existing
  CP flow?
- **Time granularity + default window** — daily vs monthly; default 30d? Shared with [analytics.md](analytics.md).
- **Charting lib** — none in `@civitai/ui`; pick jointly with [analytics.md](analytics.md).
