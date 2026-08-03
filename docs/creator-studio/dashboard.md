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

- **`card`** — one per headline stat (earned this period, CP cash pending, CP cash settled, top-earning model) and one
  "earnings by source" summary card. **`separator`** between groups.
- **`badge`** for source labels (comp / license fee / tip) and member/non-member state; **`tooltip`** for metric
  definitions and the pending/settled distinction.
- **Section link cards** (`card` + `button`) as entry points into `/models`, `/earnings`, `/licensing`, `/settings`.
- **`skeleton`** for each card while server data resolves.
- **No chart component exists in `@civitai/ui`** — a trend sparkline on the summary card would need a new primitive or
  a raw SVG; flag this and default v1 to numbers-only. See [analytics.md](analytics.md) for the charted view.

## Data (reads) — `+page.server.ts`

All scoped to `locals.user.id`. **No monetization writes on this page.**

- **Earnings summary** — ClickHouse via `@civitai/clickhouse`, from **daily aggregates / materialized views**, never
  the buzz service (too slow) ([plan §7.6](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views)):
  recent-window total + split by `source` — `orchestration.resourceCompensations` covers **comp / licenseFee only**
  (tips + access/cosmetic come from other tables — see [earnings.md](earnings.md) / A5).
- **⚠ Owner-keyed rollup dependency** — those tables are keyed by `modelVersionId`, **not** the creator's `userId`, so
  a per-creator total and the "top-earning models" widget need the **owner-keyed earnings rollup** MV
  ([plan §7.6 gap #1](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views)). Until it lands, the
  dashboard either app-side `WHERE modelVersionId IN (…)` (doesn't scale for prolific creators) or drops top-earners.
- **CP cash** — `creatorProgram.getCash` / `getBanked` / `getCompensationPool` ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices))
  for pending/settled figures. Not ClickHouse.
- **Member `tier`** — `CustomerSubscription → Product.metadata.tier` (via `@civitai/db` kysely) to decide member vs
  upsell rendering. *(Tier vs full-CP gate is a pending confirm — [plan §9](../creator-studio-plan.md#9-decisions--open-questions).)*
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
everyone who has them. The member vs non-member split only changes whether the upsell card renders. Exact member bar
pending ([plan §9](../creator-studio-plan.md#9-decisions--open-questions)).

## Shared / cross-refs

- Earnings-by-source detail and any withdrawal flow live on [earnings.md](earnings.md); the charted usage/earnings view
  is [analytics.md](analytics.md) (`/earnings/analytics`).
- The creator-earnings ClickHouse query logic is **shared with `/earnings`** — build it once as a server-side read
  module, not duplicated here ([plan §7.6](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views)).
- CP cash reads (`getCash`/`getBanked`) are the same as [settings.md](settings.md)'s Tipalti/tier surface.
- Nav lives in the shared app-local `nav.ts` ([plan §3](../creator-studio-plan.md#3-page-list-v1)).

## Open questions

- **Headline metrics + default window** — which 3–4 stats, and this-month vs last-30-days as the default period?
- **CP cash here or defer?** — surface pending/settled + a withdrawal CTA on the dashboard, or keep cash entirely on
  [/earnings](earnings.md) and just link out?
- **"Top-earning models" widget** — depends on the owner-keyed rollup ([plan §7.6 gap #1](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views));
  v1 or fast-follow? Fallback if the MV isn't ready at launch.
- **Overlap with `/earnings`** — what is *unique* to the dashboard vs a condensed preview of earnings? Risk of two
  places showing the same numbers that can drift.
- **Sparkline** — worth adding a chart primitive to `@civitai/ui` for a trend line, or numbers-only in v1?
- **New-creator empty state** — copy + which CTA (upload on main app vs set a fee on `/models`).
