# Entity Metrics

How per-entity counters (tips, followers, reactions, reads, views, downloads, …)
are computed, stored, and read across the site.

## TL;DR

There are **two** metric subsystems running side by side:

| | A. Postgres `*Metric` tables | B. ClickHouse event pipeline |
|---|---|---|
| Storage | One denormalized row per entity | Event log → rolled-up aggregate |
| Kept fresh by | Cron recompute from source (`*.metrics.ts`) | Materialized views, continuously |
| Source of truth | Other Postgres tables (`BuzzTip`, engagement, reactions…) | The events themselves |
| Self-healing? | **Yes** — recomputes from source each run | **Not on its own** — drifts on dropped/duplicate events unless a reconciler corrects it |
| Read via | Prisma (`dbRead.modelMetric…`) | `MetricService` (image feed) |
| Good for | **State** counters with a DB source | **Event** counters with no DB source, + scale |

The coexistence is **partly deliberate and partly a mid-migration artifact**
(see [“Why is the same data in two places?”](#why-is-the-same-data-in-two-places)).

---

## Subsystem A — Postgres `*Metric` cron tables

The original pattern. Each entity has a denormalized metric table
(`ModelMetric`, `ArticleMetric`, `BountyEntryMetric`, `Model3DMetric`,
`ImageMetric`, `ComicProjectMetric`, …) holding pre-computed counters.

```
source-of-truth PG tables                cron (every ~1 min)              read path
─────────────────────────        ─────────────────────────────        ───────────────
BuzzTip ───────────────┐
ComicProjectEngagement ─┼──►  src/server/metrics/<entity>.metrics.ts ──►  "<Entity>Metric"  ──►  Prisma select
reactions, comments… ──┘       (createMetricProcessor.update)              (one row/entity)        in the router
                                          │
                              registered in src/server/jobs/update-metrics.ts
```

- A module is a `createMetricProcessor({ name, update })`
  ([base.metrics.ts](../../src/server/metrics/base.metrics.ts)), wired into the
  `update-metrics` cron via [update-metrics.ts](../../src/server/jobs/update-metrics.ts).
- `update()` recomputes counters from the source-of-truth tables and upserts the
  metric row. Most modules do this **incrementally** (only entities changed
  since `lastUpdate`, found via `getAffected`); small ones (comics) do a **full
  recompute** each pass.
- **Key property: self-healing.** Because every run recomputes from source, a
  bad/missing value is corrected on the next pass. It can only be wrong if the
  cron itself stops running.
- Reads are a single PK lookup of a denormalized row — no aggregation on the hot
  path, and the columns are sortable/filterable (feed “sort by most-tipped”).

## Subsystem B — ClickHouse event pipeline

The newer pattern (the “v2 + watcher” cutover, ~v5.0.1871). Counters are a
**running sum of delta events**.

```
events                         ClickHouse (materialized views)                read path
──────                  ──────────────────────────────────────        ────────────────────
a tip / view / read ──►  entityMetricEvents_month
                              │  (every metric is kind='additive')
                              ▼
                          entityMetricSum_v3  ──►  entityMetricTotal_v3  ──►  entityMetricDailyAgg_v2 (view)
                              (sumState)            (refresher, every 1m)             │
                                                                                       ▼
                                                                          MetricService (image feed)
                                                                          (Redis-cached) ──► router
```

- `total = sum(metricValue)` over all events for `(entityType, entityId, metricType)`.
- Read through `MetricService` (images), Redis-cached over ClickHouse.
- **Key property: NOT self-healing.** Nothing reconciles the running sum against
  a source of truth, so a dropped event under-counts forever and a duplicate
  over-counts forever. (`entityMetricSum_v3` also consumes each insert *before*
  ReplacingMergeTree dedups, so duplicate inserts inflate the total even when the
  raw event table looks correct.)
- Good for **event-only** counters that have no DB ledger (`viewCount`,
  `generationCount`) and for very high read volume (the image feed). (Comic reads
  *used* to live here — see the comics example for why they moved to Postgres.)

---

## Why is the same data in two places?

Two reasons, and it’s worth separating them:

**1. A legitimate split by counter type.**

- **State counters** — tips, followers, hides, collects. These are *current
  facts* with a clean Postgres source (`BuzzTip`, engagement tables). A
  `SELECT count(…)` is always exact, so subsystem A fits perfectly.
- **Event counters** — views, generations. These are *cumulative over time* with
  **no** Postgres ledger, so only the event stream can reconstruct them →
  subsystem B. (Counter-example: comic reads *looked* like this — the
  `readChapters[]` array was wiped on republish — but we gave them a real ledger
  instead of accepting ClickHouse; see the comics example below. The test isn't
  "is there a DB ledger?" but "is one worth creating?")

**2. A mid-migration artifact (the genuinely wasteful part).**

Image/comic metrics were moved from subsystem A to subsystem B, but
Models/Articles/Bounties were never migrated, and the old `ImageMetric` cron was
left running. So for some entities (notably **Image**), the *same* tip total is
computed **twice** — once into `ImageMetric` (Postgres cron) and once through the
ClickHouse pipeline — and different read paths pick different copies. That
duplication is not by design; it’s an unfinished migration.

> **So: the inefficiency you noticed is real, but localized.** Storing a state
> counter in *both* a self-healing PG table *and* a drift-prone CH pipeline buys
> nothing — it’s the migration that didn’t finish. The non-redundant case is
> event counters, which genuinely only live in ClickHouse.

---

## Who reads what (current state)

| Entity | Tips / followers (state) | Views / reads (event) |
|---|---|---|
| **Model / ModelVersion** | Postgres `*Metric` | — |
| **Article** | Postgres `ArticleMetric` | — |
| **Bounty / BountyEntry** | Postgres `*Metric` | — |
| **Model3D** | Postgres `Model3DMetric` | — |
| **Comic** | Postgres `ComicProjectMetric` | **Postgres** `ComicProjectMetric` (reads via `ComicChapterRead`) |
| **Image** | **ClickHouse** (feed) *and* `ImageMetric` (some paths) | ClickHouse |

Image is the one that reads tips from ClickHouse on the hot feed, and ClickHouse
image tips also feed **search ranking** (`stats.tippedAmountCountAllTime:desc`)
and **user scoring** — so it can’t be casually moved back to Postgres.

---

## Drift (why this matters)

Because subsystem B doesn’t reconcile, its counters drift. Measured on comics
(ClickUp 868k4y401):

- Tips: comic 2373 showed **0** vs a true **330** (dropped events).
- Followers: **~92% of comics** showed the wrong count — 125 showed **0
  followers** while having dozens (e.g. comic 424: displayed 1, actual 52).

Subsystem A entities (Models/Articles/Bounties) don’t have this problem — their
cron recomputes from `BuzzTip` every run.

Fixing drift for the entities that *must* stay on ClickHouse (Image family) is
tracked separately: **ClickUp 868k5m8bk** (a reconciliation job that injects a
corrective delta = `truth − current` into the event stream).

---

## Comics — worked example (the current code)

Comics are now **fully Postgres-owned** — every counter is computed into
`ComicProjectMetric` by [comic.metrics.ts](../../src/server/metrics/comic.metrics.ts)
and read via `getComicMetricRows` in
[comics.router.ts](../../src/server/routers/comics.router.ts). **There is no
ClickHouse read path for comics** — `comicMetricsCache` and its populator were
deleted, along with the in-app `entitymetric:*` Redis cache subsystem they were
the last consumer of.

- **State counters** (`tippedCount`, `tippedAmountCount`, `followerCount`,
  `hiddenCount`) recompute from `BuzzTip` + `ComicProjectEngagement`.
- **Read counters** (`readerCount`, `chapterReadCount`) recompute from
  **`ComicChapterRead`** — a per-(user, chapter) table keyed by the *stable*
  `ComicChapter.id`. `readerCount = COUNT(DISTINCT userId)`,
  `chapterReadCount = COUNT(*)`, filtered to `unread = false`.

The cron is **incremental** (`getAffected` over `BuzzTip`,
`ComicProjectEngagement.updatedAt`, and `ComicChapterRead.updatedAt`) and **fully
recomputes** each affected comic from source, so any drift self-corrects on the
comic's next activity. (Correctness across a deploy comes from the migration's
one-time full backfill of every comic — the incremental cron only maintains it.)

This fixed the original tip + follower drift bugs and put comics on the **same
`*Metric` pattern** as Models/Articles/Bounties.

### Why reads moved to Postgres (the interesting part)

Comic reads *looked* like a CH-only event counter, but only because of a storage
defect. They were stored as a position array
(`ComicProjectEngagement.readChapters Int[]`) keyed by chapter **position** — and
`position` is a mutable ordinal (`ComicChapter`'s PK is `(projectId, position)`),
so it shifts on reorder/republish. The code therefore **wiped `readChapters` on
every republish**, Postgres couldn't reconstruct a cumulative count, and the
watcher's ClickHouse total became the de-facto (drifting) source of truth.

The fix wasn't to accept ClickHouse — it was to give reads a **durable Postgres
ledger**. Reads became first-class `ComicChapterRead` rows keyed by the stable
chapter `id`, so they survive reorder/republish and never need wiping (a deleted
chapter's reads drop via FK cascade; reorders/duplicates leave them untouched).
At comic volume (~50K reads/month) a row-per-read table is trivial. So the
"no DB ledger → must use ClickHouse" rule had a third option: **create the
ledger** when the counter is worth owning and the scale is modest.

### Soft-delete for incremental detection

Both removals soft-delete so the incremental cron catches them:
`toggleComicEngagement` sets `type = 'None'` (never a hard delete), and
`markChapterUnread` sets `ComicChapterRead.unread = true`. Each bumps the row's
`updatedAt`, so `getAffected` re-counts the comic and the count goes *down* —
even on a dormant comic. Article/Model still hard-delete engagement (and have no
`updatedAt`), so they hold a stale over-count until the entity next sees
activity. Comics are the reference for "incremental engagement done right";
applying the same recipe (`updatedAt` + soft-delete) to the other `*Engagement`
tables is the general fix.

---

## Where this should go (open question)

**This is not "move everything to Postgres."** Both stores are right for different
jobs; the goal is to remove the *duplication*, not ClickHouse. The end-state is a
**hybrid**, chosen per counter:

- **Event-only counters at large scale** (views, generation — no DB ledger and
  not worth creating one) → **ClickHouse**. The drift here is fixed by
  **reconciliation** (868k5m8bk), not by moving them.
- **Counters that *look* event-only but are worth owning at modest scale**
  (comic reads) → **create a Postgres ledger** (`ComicChapterRead`) and use the
  `*Metric` cron. "No DB source" is often a storage choice, not a law — if the
  volume is modest and the counter matters, give it a source. Self-healing, no
  drift, sortable.
- **State counters at modest scale** with a clean DB source (tips, follows on
  comics/articles/bounties) → **Postgres `*Metric` cron** — simplest and
  self-healing.
- **State counters at large scale** (the Image family) → **genuinely undecided.**
  Continuously-materialized ClickHouse aggregates may scale better than a
  periodic PG cron recompute at hundreds of millions of rows — that's the likely
  reason images moved to CH. But Models run the PG cron at large scale and it
  works fine, so it's not proven. Decide this with the historical context (why
  images were cut over ~v5.0.1871), not by default.

The redundancy to remove is **state counters computed in *both* stores** (e.g.
image tips in `ImageMetric` *and* the CH pipeline). Pick one canonical store per
counter and repoint the readers; don't keep both.

Rule of thumb when adding/reading a counter:

> 1. Has a DB source and the entity is modest-scale? → `*Metric` cron
>    (self-healing, sortable, can't drift).
> 2. *Looks* like a pure event stream, but the counter matters and scale is
>    modest? → **create** a DB ledger (what comics did with `ComicChapterRead`),
>    then → `*Metric` cron. Don't reach for ClickHouse just because no source
>    exists *yet*.
> 3. Genuinely event-only at large scale (raw views), or a huge / read-hot entity?
>    → ClickHouse, but commit to one store and add **reconciliation** so it
>    doesn't drift. Don't read the same counter from both.
