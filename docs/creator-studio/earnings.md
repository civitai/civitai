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
  total, each with the window's sum and a `badge` for delta vs. prior window. A **source filter** lets creators focus a
  single source; **compensation + licenses can share a chart** (comp is being retired).
- **`table`** — earnings by source × period (or a breakdown table under the chart); a **granularity switcher**
  (daily / weekly / monthly) and a **date-range picker** (last 7 / last 30 / last month / custom), default **last 30 days**.
- **Time-series chart** — earnings-over-time stacked by source. Charting lib is **LayerChart** (via shadcn-svelte,
  primitives in `@civitai/ui`) — the shared decision with [analytics.md](analytics.md).
- **Currency** — display earnings **in the currency they were received in** (buzz or USD); **no conversion/mapping**
  (there is no rate). USD is only relevant for select users.
- **CP cash panel** — pending + settled cash. This is the **single home for cash + withdrawal**; for v1 the **Withdraw**
  button **links out** to the existing CP cash flow (`/user/buzz-dashboard`) and setup links to `/tipalti/setup` —
  copy the withdrawal gate as **"$50 Ready to Withdraw"** (settled cash, not pending); see Shared.
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
  ([§7.6](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views) **gap #1**). Resolved approach: build it
  via **ClickPipe/CDC → a `modelVersion → ownerUserId` ClickHouse dictionary → an owner-keyed AggregatingMergeTree MV**
  (build handoff: [docs/plans/creator-studio-owner-rollup-handoff.md](../plans/creator-studio-owner-rollup-handoff.md)).
  The per-owner version-ID query stays as a fallback for small creators until the MV lands.
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

**Any logged-in user can access** — this is a read, and Creator Program membership gating is per-*action* (fee-setting on
[models.md](models.md)), not per-view. Non-members see their own earnings normally.

## Shared / cross-refs

- **[analytics.md](analytics.md)** (`/earnings/analytics`) — the usage side (generations/downloads/funnels) that
  *drives* these earnings; shares the ClickHouse read module and the charting-lib decision.
- **[models.md](models.md)** — where fees/access are *set* (the writes); `/earnings` shows what they *earned*.
- **[dashboard.md](dashboard.md)** — the at-a-glance total; `/earnings` is the full by-source breakdown.
- **CP cash / withdrawal** — the existing main-app / Creator Program flow
  ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices)); linked, not rebuilt.
- Legacy `getDailyCompensationRewardByUser` (main app) is being redirected; both converge on one CH read module at the
  full cutover ([§7.6](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views)).

## Decisions (resolved 2026-07-02)

- **EARN-1 — v1 sources.** **All sources day 1** ideally, with a **source filter** (model access, cosmetic, comp,
  licenses, tips; merch later). **Comp + licenses can share a chart** (comp is being retired). This means access-sale +
  cosmetic-sale are in v1 and need the **gap #2** per-`toAccountId` buzz-earnings MV.
- **EARN-2 — Owner-keyed rollup.** Build via **ClickPipe/CDC → a `modelVersion → ownerUserId` ClickHouse dictionary →
  an owner-keyed AggregatingMergeTree MV** (reusing the existing Buzz ClickPipe pattern; CH can't reach the
  Bastion-gated prod DB directly). Build handoff:
  [docs/plans/creator-studio-owner-rollup-handoff.md](../plans/creator-studio-owner-rollup-handoff.md). The per-owner
  version-ID query is the launch fallback.
- **EARN-3 — Boundary.** **Analytics = non-buzz usage** (generations, downloads); **earnings = everything buzz +
  real-dollar cash/banking/withdrawal**. `/earnings` owns the by-source money detail and the cash surface.
- **EARN-4 — Cash + withdrawal home.** Lives here on `/earnings` as the **single entry point** — surfaced inline. For
  v1 the actual withdrawal **links out** to the existing CP cash flow (`/user/buzz-dashboard`); the dashboard only shows
  a condensed preview and links here.
- **EARN-5 — Granularity + window.** A **switcher (daily / weekly / monthly)**, default **last 30 days**, plus a custom
  range (last 7 / last 30 / last month / custom). Shared with [analytics.md](analytics.md).

**Still open / deferred:** access-sale + cosmetic-sale earnings depend on the **gap #2** MV being built; the owner-keyed
rollup (EARN-2) lands v1 if it's ready, else fast-follow with the version-ID fallback.
