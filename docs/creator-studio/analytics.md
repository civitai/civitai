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
- **charts** — **generations-over-time** (with a **weekly** option, **split by buzz color** blue/yellow/green) and
  downloads-over-time line/area, per-resource. Charting lib is **LayerChart** (via shadcn-svelte, primitives in
  `@civitai/ui`; LayerChart 2.0). A real v1 dependency, not a detail.
- **`table`** — **top models / versions** breakdown (per-week earnings · generations · **the fee currently set**,
  sortable). Depends on the owner-keyed rollup (see Data) — may be deferred if that rollup slips.
- **Pricing-reference metric** — avg buzz cost per image by **base model + type**, so creators know what to price at
  (the same reference surfaced inline in the [licensing.md](./licensing.md) bulk editor).
- **`tabs`** (optional) — switch metric views (usage vs. downloads vs. engagement) to keep each view basic.
- **`badge`** for deltas vs. prior period (week-over-week); **`skeleton`** while loading; **`popover`** for metric
  definitions.
- **Date-range control** — adopt a **date-picker** plus a **granularity switcher** (daily / weekly / monthly),
  default **last 30 days**, with a custom range.

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
([plan §1](../creator-studio-plan.md#1-what-this-app-is)). No Creator Program membership action gate here (that's a
per-*action* concern, and this page has no actions). **Member vs non-member is a data-visibility nuance**: usage is only interesting
where a fee is *active* (member) — a non-member's usage doesn't drive fees, so copy should frame usage as potential and
point to [join.md](./join.md). Nav item is not `memberOnly`.

## Shared / cross-refs

- **Earnings by money/source** → [earnings.md](./earnings.md) — analytics = *usage that drives fees*; earnings =
  *money by source*. Draw the boundary cleanly (see open questions).
- **Dashboard** headline stats → [dashboard.md](./dashboard.md) pulls a subset of these tiles.
- **Model management** → [models.md](./models.md) (which versions have an active fee → what usage is monetized).
- **ClickHouse client** `@civitai/clickhouse` is shared; the creator-usage **query logic is new** here
  ([plan §7.6](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views)).

## Decisions (resolved 2026-07-02)

- **ANALYTICS-1 — v1 metric/chart list.** Lock to: **generations-over-time** (weekly option + split by buzz color
  blue/yellow/green), **earnings-over-time by source** (weekly, week-over-week delta), a **top-models table** (per-week
  earnings + generations + the fee set), **stat tiles**, and a **pricing-reference metric** (avg buzz cost/image by
  base model + type). Richer analytics (cohorts, per-model funnels) is post-v1.
- **ANALYTICS-2 — Per-model breakdown.** Depends on the **owner-keyed rollup** (EARN-2). v1 if the rollup lands, else
  fast-follow with the version-ID fallback.
- **ANALYTICS-3 — Date control + charting lib.** **Adopt a date picker** (not just presets). Charting lib is
  **LayerChart** (via shadcn-svelte, primitives added to `@civitai/ui`; LayerChart 2.0 approved).
- **ANALYTICS-4 — Default range + granularity.** Default **last 30 days** with a **granularity switcher** (daily /
  weekly / monthly) and a custom range.
- **ANALYTICS-5 — Earnings-over-time boundary.** **Usage time-series (non-buzz: generations, downloads) lives here** in
  analytics; the **money time-series lives on [earnings.md](./earnings.md)**. Split on buzz vs non-buzz.

**Still open / deferred:** the per-model breakdown table (ANALYTICS-2) hinges on the owner-keyed rollup (EARN-2) landing.
