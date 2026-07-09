# `/earnings` — Earnings by source ✓

> **v1.** The "how much money, from what" view: a creator's earnings broken down **by source** (license fees, tips,
> generation compensation, and — pending [§7.6](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views)
> gap #2 — model-access + cosmetic sales), with totals and a time-series, plus a link out to CP cash/withdrawal.
> **Read-only.** Umbrella: [plan §3](../creator-studio-plan.md#3-page-list-v1); reads
> [plan §7.6](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views).

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

- **Earnings by source** — `orchestration.resourceCompensations` already carries `source` covering **compensation /
  licenseFee / tip** (available now). **Access-sale + cosmetic-sale** earnings are buzz *transactions*, **not** in
  `resourceCompensations` → they need a separate per-`toAccountId` daily buzz-earnings rollup
  ([§7.6](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views) **gap #2**) — see Open questions.
- **Owner-keyed rollup dependency** — every earnings table is keyed by `modelVersionId`, **not** the creator's
  `userId`; "creator X's earnings" needs the `(ownerUserId, date, source)` MV + `modelVersion → ownerUserId` dictionary
  ([§7.6](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views) **gap #1**). Blocks this page.
- **CP cash / banked** — `creatorProgram.getCash` / `getBanked`
  ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices)) for the pending/settled panel.
- **Not** the buzz service; **no** per-version monetization writes here (those are [models.md](models.md)).

## Actions (writes) — none

This page is **read-only**. The only "action" is **Withdraw**, which is a link out to the existing CP cash/withdrawal
flow ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices)) — not a form action here.

## States

- **Loading** — skeleton cards + chart placeholder.
- **Empty** — creator has never earned → friendly empty state + link to [models.md](models.md) (set a fee) / upload.
- **Partial sources** — if access/cosmetic-sale earnings are deferred (gap #2), those cards are hidden or show a
  "coming soon" note; comp/license/tip still render.
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

- **Which sources ship in v1?** comp / license / tip are ready today; **access-sale + cosmetic-sale** need the gap #2
  per-`toAccountId` buzz-earnings MV ([§7.6](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views)) —
  include in v1 or defer to fast-follow?
- **Owner-keyed rollup (gap #1)** is a hard dependency — is the `(ownerUserId, date, source)` MV + `modelVersion →
  ownerUserId` dictionary scheduled before v1?
- **`/earnings` vs `/earnings/analytics` vs dashboard boundary** — what is *unique* to `/earnings` (by-source totals +
  cash) so it doesn't duplicate the other two?
- **CP cash + withdrawal — inline or link-out?** Surface pending/settled + Withdraw here, or send fully to the existing
  CP flow?
- **Time granularity + default window** — daily vs monthly; default 30d? Shared with [analytics.md](analytics.md).
- **Charting lib** — none in `@civitai/ui`; pick jointly with [analytics.md](analytics.md).
