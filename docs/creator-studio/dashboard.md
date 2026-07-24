# `/` — Dashboard / overview

> **v1.** The landing surface: at-a-glance earnings across all sources + a few headline stats, and entry points into
> each section (`/models`, `/earnings`, `/licensing`, `/settings`). Read-heavy, essentially read-only. Umbrella:
> [plan §3](../creator-studio-plan.md#3-page-list-v1); analytics source [plan §7.6](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views).

## User story

As a creator, I open `/` and immediately see **how much I've earned recently** (totalled and split by source), a handful
of headline numbers (e.g. earned this period, top-earning model), and my **CP cash pending/settled**. From here I click
into `/models` to manage monetization, `/earnings` for the full breakdown, `/licensing` for bulk fee edits, or
`/settings`. A non-member still sees any earnings, plus an upsell card pointing at [/join](join.md).

## Layout & components

`@civitai/ui` (shadcn-svelte) primitives — don't hand-build:

- **`card`** — one per headline stat (~3-4: **generation count · buzz earned · downloads · access spend**; later
  cosmetic/merch sales once the shop lands) and one "earnings by source" summary card. **`separator`** between groups.
- **`badge`** for source labels (comp / license fee / tip) and member/non-member state; **`tooltip`** for metric
  definitions and the pending/settled distinction.
- **Section link cards** (`card` + `button`) as entry points into `/models`, `/earnings`, `/licensing`, `/settings`.
- **`skeleton`** for each card while server data resolves.
- **Sparkline** — a trend sparkline on the summary card is worth a **shared chart primitive** (LayerChart, added to
  `@civitai/ui`; see [analytics.md](analytics.md)). Include it in v1 rather than numbers-only.

## Data (reads) — `+page.server.ts`

All scoped to `locals.user.id`. **No monetization writes on this page.**

- **Earnings summary** — ClickHouse via `@civitai/clickhouse`, from **daily aggregates / materialized views**, never
  the buzz service (too slow) ([plan §7.6](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views)):
  recent-window total + split by `source` (comp / licenseFee / tip) off `orchestration.resourceCompensations`.
- **⚠ Owner-keyed rollup dependency** — those tables are keyed by `modelVersionId`, **not** the creator's `userId`, so
  a per-creator total and the "top-earning models" widget need the **owner-keyed earnings rollup** MV
  ([plan §7.6 gap #1](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views)). Until it lands, the
  dashboard either app-side `WHERE modelVersionId IN (…)` (doesn't scale for prolific creators) or drops top-earners.
- **CP cash** — `creatorProgram.getCash` / `getBanked` / `getCompensationPool` ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices))
  for pending/settled figures. Not ClickHouse.
- **Creator Program membership** — via `creatorProgram.getCreatorRequirements` (the single gate) to decide member vs
  upsell rendering.
- **Headline counts** — model/version count from `@civitai/db` kysely; period earnings from the rollup above.

## Actions (writes)

None in v1. The dashboard is read-only; every write (fee changes, withdrawals) lives on its owning page. A withdrawal
CTA here would only **link** to `/earnings` or `/settings`, not perform the action.

## States

- **Loading** — skeleton cards per metric (`skeleton`).
- **New creator (empty)** — no models / no earnings yet → friendly empty state with a "monetize your models" prompt
  linking to `/models` and to upload on the main app.
- **Non-member** — earnings still render (they may have earned pre-membership); a prominent **upsell card** links to
  [/join](join.md). Member-gated section links stay visible but note the gate.
- **Rollup not ready** — if the owner-keyed MV isn't deployed, hide the "top-earning models" widget and show the
  by-source summary only.
- **Error** — per-card error fallback (a failed ClickHouse read shouldn't blank the whole page).

## Gating

Any logged-in user can access `/`. Nothing on this page is member-gated to *view* — earnings and CP cash show for
everyone who has them. The member vs non-member split only changes whether the upsell card renders. The member bar is
**Creator Program membership**.

## Shared / cross-refs

- Earnings-by-source detail and any withdrawal flow live on [earnings.md](earnings.md); the charted usage/earnings view
  is [analytics.md](analytics.md) (`/earnings/analytics`).
- The creator-earnings ClickHouse query logic is **shared with `/earnings`** — build it once as a server-side read
  module, not duplicated here ([plan §7.6](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views)).
- CP cash reads (`getCash`/`getBanked`) are the same as [settings.md](settings.md)'s Tipalti/membership surface.
- Nav lives in the shared app-local `nav.ts` ([plan §3](../creator-studio-plan.md#3-page-list-v1)).

## Decisions (resolved 2026-07-02)

- **DASH-1 — Headline metrics + window.** Default **last 30 days**. ~3-4 stats: **generation count, buzz earned,
  downloads, access spend** (the amount others spent to access their models); add cosmetic/merch sales later once the
  shop lands. Stats shown depend on what the creator actually does.
- **DASH-2 — CP cash.** Cash lives on [/earnings](earnings.md). The dashboard shows a **condensed preview + links out**;
  no full withdraw flow here.
- **DASH-3 — "Top-earning models" widget.** Depends on the owner-keyed rollup (EARN-2). **v1 if the rollup lands, else
  fast-follow** with the version-ID fallback.
- **DASH-4 — Overlap with `/earnings`.** Dashboard = **condensed preview**; `/earnings` = full buzz + cash detail.
  Boundary is buzz vs non-buzz per EARN-3.
- **DASH-5 — Sparkline.** **Yes** — worth a **shared chart primitive** (LayerChart in `@civitai/ui`); there will be many
  charts in this app.
- **DASH-6 — New-creator empty state.** Stats render empty; the CTA is a **dual action**: **Train** (primary, → the
  training experience where they pick a dataset) + **Upload** (secondary, → upload their first model).

**Still open / deferred:** the "top-earning models" widget (DASH-3) hinges on the owner-keyed rollup (EARN-2) landing.
