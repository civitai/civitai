# `/earnings/analytics` — Basic analytics ⭐

> **v1 priority.** The "what's driving my earnings" view: the creator's own model **usage** — generations per resource,
> downloads, engagement over time — read-only from **ClickHouse** daily aggregates. **Keep it basic for v1**; richer
> analytics is post-v1. Umbrella: [plan §3](../creator-studio-plan.md#3-page-list-v1),
> analytics source [plan §5.1](../creator-studio-plan.md#51-the-core-architectural-decision--where-does-business-logic-run) /
> [§7.6](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views).

## User story

As a creator, I open `/earnings/analytics` and see **how my models are being used** — generations per resource and
downloads trending over time, plus a top-models breakdown. It answers "what's driving my fees?" so I can tie usage to
the money I see on [earnings.md](./earnings.md). I can change the date range and skim which versions carry my usage.

## Layout & components

`@civitai/ui` (shadcn-svelte) primitives — don't hand-build:

- **`card`** — headline stat tiles (total generations, total downloads, engagement) for the selected range.
- **charts** — generations-over-time + downloads-over-time line/area, per-resource. ⚠️ **`@civitai/ui` has NO chart
  primitive**, and the main app's Chart.js is React-only — a **Svelte charting library must be chosen** (see open
  questions). This is a real v1 dependency, not a detail.
- **`table`** — **top models / versions** breakdown (generations · downloads · engagement, sortable). Depends on the
  owner-keyed rollup (see Data) — may be deferred if that rollup slips.
- **`tabs`** (optional) — switch metric views (usage vs. downloads vs. engagement) to keep each view basic.
- **`badge`** for deltas vs. prior period; **`skeleton`** while loading; **`popover`** for metric definitions.
- **Date-range control** — ⚠️ `@civitai/ui` has **no calendar** primitive; a preset range control (7d/30d/90d) or a
  chosen date-picker is needed (see open questions).

## Data (reads) — `+page.server.ts`

**Read-only. ALL reads = ClickHouse via `@civitai/clickhouse`** (daily aggregates / materialized views), **never the
buzz service** (too slow) and **never individual rows**
([plan §5.1](../creator-studio-plan.md#51-the-core-architectural-decision--where-does-business-logic-run),
[§7.6](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views)). No monetization module, no writes.

Existing daily aggregates to read ([plan §7.6](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views)),
all keyed by **`modelVersionId, date`**:

- **Generations** — `default.daily_resource_generation_counts` (generations / version / day).
- **Downloads** — `default.daily_downloads`, `daily_downloads_unique`, `modelVersionUniqueDownloads`.
- **Engagement / metrics** — `default.entityMetric*` suite.
- *(Earnings-by-source lives on [earnings.md](./earnings.md) via `orchestration.resourceCompensations` — not re-charted
  here; see the boundary in open questions.)*

> **⚠️ Scoping gap — the load-bearing constraint.** **None** of these aggregates are keyed by the creator's `userId` —
> they are keyed by `modelVersionId` (the `userId` columns that exist are the *generator/downloader*, not the creator).
> Scoping to **"my models"** needs a **`modelVersion → ownerUserId`** mapping / the **owner-keyed rollup**
> ([plan §7.6 gap #1](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views)). Until that MV/dictionary
> lands, v1 must fall back to resolving the creator's `modelVersionId`s (from `@civitai/db`) and querying
> `WHERE modelVersionId IN (…)` — which **balloons for prolific creators**. This is a cross-team dependency on
> Koen/backend ([plan §7.4](../creator-studio-plan.md#74-cross-team-dependencies--coordination)).

## Actions (writes)

**None.** This page is **read-only** — no form actions, no mutations. (Monetization writes live on
[models.md](./models.md) / [licensing.md](./licensing.md).)

## States

- **Loading** — `skeleton` stat tiles + chart/table placeholders.
- **Empty** — creator has no models, or no usage in range → friendly empty state + link to [models.md](./models.md) /
  upload on the main app.
- **No-usage-in-range** — models exist but zero generations/downloads for the window → show zeros, not an error.
- **Data-lag** — daily aggregates trail real time; note "as of last daily rollup" so partial-today isn't read as a drop.
- **Rollup-missing fallback** — if the owner-keyed rollup isn't live, the per-model table may be hidden/capped; headline
  usage still renders via the `IN (…)` fallback.
- **Error** — ClickHouse query failure → inline error on the affected panel, other panels still render.

## Gating

**Any logged-in user can access** — this is a read, so gating is light
([plan §1](../creator-studio-plan.md#1-what-this-app-is)). No member-`tier` action gate here (that's a per-*action*
concern, and this page has no actions). **Member vs non-member is a data-visibility nuance**: usage is only interesting
where a fee is *active* (member) — a non-member's usage doesn't drive fees, so copy should frame usage as potential and
point to [join.md](./join.md). Nav item is not `memberOnly`.

## Shared / cross-refs

- **Earnings by money/source** → [earnings.md](./earnings.md) — analytics = *usage that drives fees*; earnings =
  *money by source*. Draw the boundary cleanly (see open questions).
- **Dashboard** headline stats → [dashboard.md](./dashboard.md) pulls a subset of these tiles.
- **Model management** → [models.md](./models.md) (which versions have an active fee → what usage is monetized).
- **ClickHouse client** `@civitai/clickhouse` is shared; the creator-usage **query logic is new** here
  ([plan §7.6](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views)).

## Open questions

- ~~**What counts as "basic" for v1?**~~ **Decided 2026-07-09 (B4):** two sections — a **Model** section (the
  proposed metrics + weekly granularity, generations split by buzz color, earnings WoW, per-model last 1–2 wk,
  cost-to-generate reference) and a **NEW Content/Creator** section (reactions, followers, images/posts
  published, profile views, top-content table, all-time stat tiles). See
  [pre-implementation-decisions.md B4](pre-implementation-decisions.md). Richer analytics (cohorts, funnels) is post-v1.
- **Per-model breakdown table** depends on the **owner-keyed rollup**
  ([plan §7.6 gap #1](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views)) — is it **v1** (needs the MV
  from backend) or **fast-follow** (v1 ships headline usage only)?
- **Which Svelte charting library?** No chart primitive in `@civitai/ui`; Chart.js is React-only. Pick one
  (LayerChart / LayerCake / d3-based) and decide whether it lands **in `@civitai/ui`** (shared) or app-local.
- **Date-range picker** — `@civitai/ui` has no calendar; ship **presets** (7d/30d/90d) for v1 or adopt a date-picker?
- **Default range + granularity** — proposed **last 30 days, daily** (matches the daily aggregates); confirm.
- **Earnings-over-time boundary** — does the money time-series live **here** or on [earnings.md](./earnings.md)? Proposed:
  usage here, money there, cross-linked — confirm so we don't double-build the same chart.
