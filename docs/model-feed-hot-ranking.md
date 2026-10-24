# Model Feed: A "Hot" Sort Instead of a Default Period

A proposal to replace the model feed's default time window with a Reddit-style *hot* ranking: popular
models first, with newer ones favoured, and no hard cutoff that can empty a page. `period` stays as an
optional narrowing the user applies on purpose.

Status: **implemented** in `feat/model-feed-hot-ranking`, not yet merged. Four migrations are applied
by hand, **in order**. The first three must go in before the code ships, because the deploy names
their columns in an INSERT list unconditionally — `bulkInsertMetrics` for `ModelMetric`, the upsert in
`basemodel.metrics.ts` for `ModelBaseModelMetric` — so a missing column takes down the whole metrics
job, not just the new signal. The fourth needs no deploy at all:

| Migration | What it adds | Backfill | Applied to prod |
| --- | --- | --- | --- |
| `20261010120000_model_hot_score` (§11) | the score, its index, the mirror | in-file `CALL` | 2026-10-08 |
| `20261011120000_model_hot_score_generator_cap` (§14) | `uniqueGeneratorCount`, the cap | `/api/admin/temp/backfill-unique-generators` | 2026-10-08 |
| `20261012120000_base_model_metric_hot_score` (§15) | per-base-model scoring | `/api/admin/temp/backfill-base-model-hot-score` | 2026-10-12 |
| `20261013120000_model_hot_score_generator_floor` (§16) | the first generator earns nothing | in-file `CALL` | 2026-10-12 |

The last one carries an ordering constraint in the opposite direction from the others: it must go
**after** both generator backfills, because it makes `uniqueGeneratorCount = 0` mean "no generation
credit" rather than "not computed yet".

**Later sections correct earlier ones.** §13 supersedes the divisors in §2; §10 supersedes the
per-base-model conclusions in §6 and §7; §14 adds the generation cap and §16 then puts a floor under
it, so the formula in §2 is three revisions out of date; §15 replaces the mirrored per-base-model
score described in §7, §10, §11 and §12 (Trap 3) with a per-slice one, and drops
`trg_model_metric_hot_score_fanout`. Where an earlier section states a design as current fact and a
later one reversed it, the later one wins.

The formula as it now stands:

```
engagement = thumbsUpCount
           + downloadCount / 6.4
           + least(generationCount / 4.1, greatest(uniqueGeneratorCount - 1, 0) * 100)
hotScore   = round((log10(1 + engagement) + publishedAt_epoch / 2592000) * 10000)
```

computed per model on `ModelMetric` and per (model, base model) slice on `ModelBaseModelMetric`,
where `publishedAt` is the slice's earliest published version.

Follows from the tag-page soft-404 work in [seo-improvements.md](seo-improvements.md) (§1) and the
stop-gap in `e60d745f97`.

Code references are to `main` at `4650509937` and the line numbers are **pre-change** — this
branch moved several of them. Search by symbol.

---

## Why this came up

Tag pages were showing empty grids. The default model filter is `sort: Highest Rated, period: Month`,
and `period` drops every model whose latest version is older than 30 days. On a tag page that often
leaves nothing: **92% of the tags that have published models (224,624 of 243,469) render an empty
grid under the default**, while the same page's meta description and `CollectionPage` schema
advertise the full count. Google files those pages as soft 404s, and a visitor sees a broken page.

`periodFallback` (`e60d745f97`) retries at `AllTime` when the first page is empty. It only fires at
exactly zero results, so a tag showing 3 of its 255 models is still wrong. The underlying problem is
that the default *filters* for recency. This proposal moves recency into the *sort*, and a sort can
never remove rows.

---

## Summary

- **Today's `period` doesn't mean what its label says.** `ModelMetric` stores all-time counters only.
  `period: Month` keeps models that got a *new version* in the last 30 days and ranks them by
  all-time likes. The current default's top 50 has a median age of **555 days**, and 44 of the 50
  were published more than 90 days ago.
- **Use Reddit's formula, stored as a column:**
  `hot = log10(1 + engagement) + publishedAt_seconds / T`, where engagement blends likes, downloads
  and generations.
  The time term is the *publish time*, not the age, so a model's score only changes when its
  engagement changes. Nothing has to recompute on a timer.
- **It rides along on writes that already happen.** The metrics job already rewrites a model's
  `ModelMetric` row when its counts change (17,262 rows in a measured hour). The score changes in
  that same write. No new job.
- **The default becomes `sort: Hot, period: AllTime`.** No default can empty a page, the 3-of-255
  tag case is fixed along with the 0-of-255 case, and `periodFallback` can be deleted once saved
  preferences are migrated.
- **Measured on dev:** a 20 MB index, 1.0 ms for the default feed (today: 15.4 ms), 3.6 ms for a
  554k-model tag (today: 62.7 ms), and a full page for small tags where today's default returns nothing.
- **Rough size: 2–3 days**, plus a manually applied, staged migration.

---

## 1. How ranking works today

`getModelsRaw` (`src/server/services/model.service.ts`):

- **`period` is a WHERE clause, not a ranking input.** `:717` adds
  `mm."lastVersionAt" >= now() - 1 <period>` unless the period is `AllTime` or `periodMode` is
  `'stats'`.
- **`sort` is a fixed ORDER BY over all-time counters** (`:906–930`). Highest Rated is
  `thumbsUpCount DESC, downloadCount DESC, modelId`.
- **Paging is keyset on the ORDER BY columns** (`getCursorClauses`, `:936`), so a new sort must order
  by a stored column, not an expression.
- **There are no per-period metric columns.** `ModelMetric` (`schema.full.prisma:1444`) has one row
  per model. The `downloadCount${period}` keys at `:1217` relabel the all-time columns.

So "Highest Rated · Month" means *"all-time best among models updated in the last 30 days."* Measured
top 50 on the green feed:

| | Current default |
| --- | ---: |
| Median age | 555 days |
| Oldest | 1,363 days |
| Published > 90 days ago | 44 of 50 |
| Median likes | 2,022 |

The top of the feed is the same long-established models, surfaced again whenever they ship a
version.

---

## 2. The design

### The formula

```
engagement = likes + downloads / 6.4 + generations / 4.1
hot        = log10(1 + engagement) + extract(epoch FROM publishedAt) / T
```

All three inputs are existing all-time `ModelMetric` columns (`thumbsUpCount`, `downloadCount`,
`generationCount`). The divisors are the **median per-model** ratios of each signal to likes, so
all three carry equal weight on a typical model.

The first version of this used the platform-wide **sum** ratios — 8.5 downloads and 117 generations
per like. Those look like the same quantity and are not, and the difference broke the ranking (§13):
generations are concentrated in a handful of checkpoints with billions apiece, so the sum ratio
over-states the typical model's generation rate by about 28x. On the median published model — 56
likes, 371 downloads, 231 generations — generations contributed **2%** of engagement and downloads
43%. The median per-model ratios are 6.4 and 4.1, which put all three near a third each.

- **Why it's cheap:** `publishedAt` never changes, so the passage of time adds the same amount to
  nobody's score. The relative order of two models only changes when one of them gains likes. The
  score is written when likes change and read from an index. This is the property that makes
  Reddit's *hot* practical at scale.
- **Why `publishedAt`, not `lastVersionAt`:** `lastVersionAt` resets when an old model ships a new
  version, which is exactly what fills today's feed with old models. An age-decay expression over
  `lastVersionAt` was also measured at query time: 2,465 ms against 14.5 ms, and 39 of its top 50 were
  old models that had just added a version.
- **`T` sets the aging speed:** 10× the likes is worth `T` seconds of newness.

### Choosing `T`: measured

Top 50 on the green feed at different values of `T`, first with likes only:

| 10× likes is worth… | Median age | Oldest | Median likes |
| --- | ---: | ---: | ---: |
| 12 hours (Reddit's value) | 0.1 days | 1 day | 8 |
| 1 day | 0.3 days | 1 day | 15 |
| 1 week | 1.3 days | 4 days | 35 |
| **1 month** | **5.9 days** | **45 days** | **84** |
| **3 months** | **43 days** | **154 days** | **543** |
| 6 months | 79 days | 294 days | 1,006 |
| 1 year | 100 days | 602 days | 1,195 |

With the blended engagement (likes + downloads + generations) at the two useful settings:

| 10× engagement is worth… | Median age | Oldest | Median likes | Median downloads | Median generations |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 month | 7.0 days | 44 days | 100 | 1,354 | 2 |
| 3 months | 53.5 days | 189 days | 552 | 13,967 | 29 |

The blend shifts the lists only slightly toward established downloads; the same releases lead
either way. Generations barely move the top: most newly popular models aren't generatable on-site
yet, so their generation counts are near zero. Generations matter more further down, among older
generator-supported models.

Publication volume is high enough that Reddit's value only surfaces models a few hours old with a
handful of likes. The useful range is **1–3 months**:

- **1 month** reads as *"new and taking off"*: the current checkpoint wave plus LoRAs from the last
  few days with 65–145 likes.
- **3 months** reads as *"best of the season"*: the leading checkpoints from the last three months,
  575–2,877 likes each.

Both surface the current base-model wave, which the current default's top 12 doesn't show at all.
A reasonable starting point is **1 month for `/models` and 3 months for tag pages**, where a small
tag should still read close to "best of this tag". Each `T` is a separate column and index, so
shipping two doubles the storage in the next section.

**Superseded:** one `T` of 30 days shipped for every surface (decision 11), and §13 found that
widening it is the wrong lever anyway — it made the base-model mix worse, not better.

### Signals

Likes, downloads and generations all count, with the normalizing divisors above. Tuning the
weights means comparing top-50 lists at a few settings, as done here. Any further signal must
already be a `ModelMetric` column, or the score stops riding on the existing metrics write.

### Storage and maintenance

- **Column:** `hotScore int` on `ModelMetric`, holding `round(score * 10000)`. It must be an integer,
  not a float — the keyset cursor parser truncates float tokens with `parseInt` and silently drops
  rows ([§7](#7-how-hot-works-with-basemodel-filtering)). The dev experiment in §6 used `real`, before
  that was known.
- **`publishedAt` has to be copied onto `ModelMetric`** the same way `lastVersionAt` already is, by the
  `sync_model_to_metric` trigger (latest version in
  `migrations/20260501135000_tighten_sync_model_to_metric`).
- **Keeping it current:** a stored generated column would need no app code. `log` and
  `extract(epoch FROM timestamp)` are both immutable, which a generated column requires. But see the
  rollout caveat below. The alternative is computing it in the metrics upsert and in the trigger.
- **Index:** `(hotScore DESC, modelId)`. The bare version measured **20 MB** on dev. It probably needs
  to carry the feed's filter columns (`INCLUDE`) the way the other feed indexes do, because the
  base-model path depends on filtering inside the index scan — unmeasured, and the one open
  measurement left ([§7](#7-how-hot-works-with-basemodel-filtering)).

### Overhead, measured

| | Cost |
| --- | --- |
| Writes | Rides on existing writes. The metrics upsert already skips unchanged rows. 17,262 rows changed in a measured hour (159,300 in a day, of 951,190). About 5 extra index updates a second. |
| Background jobs | None new. |
| Reads | **1.0 ms** for the default feed on dev, against 15.4 ms for today's default. Full results in [§6](#6-dev-experiment-2026-09-16). |
| Paging | Stable. The order doesn't change with time, so pages don't skip or repeat rows between loads. |
| Storage | **Superseded by §10:** covering indexes shipped — `feed_hot` 45 MB plus `mbmm_feed_hot` 55 MB, against 318 MB for `feed_highest_rated` alone. |

### Why the index was tested on dev, not prod

The prod read replica uses every existing index, but it can't **create** one. It's a hot standby that
replays the primary's changes and accepts none of its own. Every index is built on the primary and
reaches the replica through replication, so building this one on prod *is* the migration.

Before building anything, the replica's `hypopg` extension was used as a design check. It lets the
planner assume an index exists for one session, without writing anything, and reports plan shapes but
no timings. It answered two questions:

- **Would the planner use an index on a stored score column?** Yes.
- **Would it use an index on the formula computed inline?** No, not even with sequential scans and
  sorts disabled. That's why the design stores the score as a column.

Its size estimate (91 MB) turned out to be about 4.5× the real index. Real numbers come from dev
(§6).

### ⚠️ Rollout: don't add a generated column in one step

`ALTER TABLE … ADD COLUMN … GENERATED ALWAYS AS (…) STORED` rewrites the whole table and rebuilds
~3 GB of indexes under an exclusive lock, which blocks the model feed for the duration. Stage it
instead:

1. Add a plain nullable `publishedAt` and `hotScore` (metadata-only, no rewrite).
2. Update the sync trigger and the metrics upsert to write both.
3. Backfill in batches.
4. `CREATE INDEX CONCURRENTLY`.
5. Deploy the code that sorts by it.

Migrations here are applied manually, so each step is a separate, reviewed SQL file.

---

## 3. Query changes

- Add `ModelSort.Hot`. The dropdown lists every non-hidden value (`SortFilter.tsx:37`), so it
  appears automatically.
- In `getModelsRaw`, order by `mm."hotScore" DESC, mm."modelId"` and extend the keyset cursor.
- **The per-base-model path needs its own shape.** See [§7](#7-how-hot-works-with-basemodel-filtering).
- `/api/v1/models` parses the same schema, so `Hot` becomes a documented API sort. Searches with
  `query` take ids from Meilisearch in relevance order and should keep that behaviour.

---

## 4. How it fits the filter system

Background (see [seo-improvements.md](seo-improvements.md) §1):

- The client store saves model filters to localStorage under `model-filters`.
- The client schema now defaults to **Hot / AllTime**; the server schema still defaults to
  **Highest Rated / AllTime** (`constants.modelFilterDefaults`). They differ on `sort` by design:
  the server default also answers `/api/v1/models` and the other server-side callers, and the
  decision was to change the default on `/models` and tag pages only.
- On the server, `getInitialValues` returns `schema.parse({})` because there is no `window`, so SSR and
  crawlers always get the schema default.

With `sort: Hot, period: AllTime` as the default:

- **Tag pages always show their content.** Nothing filters them, and recent popular models rank
  first. This covers the 3-of-255 case that `periodFallback` misses.
- **No per-surface period defaults are needed.** A per-surface `T` is a sort choice, not a filter,
  and can't empty a page.
- **Saved preferences are the catch.** A visitor who ever changed any model filter has
  `Highest Rated · Month` saved even if they never chose it, because the store writes defaults along
  with the change (`FiltersProvider.tsx:305–310`). A one-time migration should replace **only that
  exact pair** and bump a storage version. `periodFallback` is deleted in the same PR.
- **Page props:** the design reads no per-page server value, so it can't hit the client-navigation
  crash fixed in `9b7b5dcc6c`. Anything later passed from the server into the filter UI must be
  optional and tested through an in-app link.

---

## 5. What it gives up

- **An old model that's trending again won't rise.** Likes can't outrun the time term. A windowed
  score (engagement in the last N days, recomputed hourly) would catch that, at the cost of a
  scheduled job and a score that shifts under paging. That was the earlier version of this proposal;
  §17 measures the gap and designs it as a separate signal.
- **A new version doesn't bump a model.** That's deliberate, since it's the flaw in today's feed. A
  deliberate "new version" boost would need its own rule.
- **One more index** on a table that is already mostly index.

---

## 6. Dev experiment (2026-09-16)

Steps 1, 3 and 4 of the rollout were run on the **dev database**, and read performance was measured
there. Prod was not touched.

**Is dev a safe stand-in?** Dev is a separate server: different host, not in recovery, and ~8,500
models behind prod, so nothing written there reaches prod. It shares prod's `system_identifier`,
meaning it was cloned from a prod backup, which is why its size is close: `ModelMetric` has ~949k
rows on dev against ~951k on prod.

### What was run

| Step | SQL | Result |
| --- | --- | --- |
| Add column | `ALTER TABLE "ModelMetric" ADD COLUMN IF NOT EXISTS "hotScore" real` | **92 ms**, no table rewrite |
| Backfill | `UPDATE … SET "hotScore" = <formula> FROM "Model" m …`, 12 batches of 250k model ids | **949,065 rows in ~65 s** (3–13 s per batch) |
| Index | `CREATE INDEX CONCURRENTLY "ModelMetric_hot_score" ON "ModelMetric" ("hotScore" DESC, "modelId")` | **716 ms**, valid, **20 MB** |

- **The formula used:** blended engagement (§2), `T` = 1 month.
- **No `publishedAt` column on dev.** The backfill joined `Model` for it, which is fine for a
  one-off. Production still needs the column so the score can be kept current (§2).
- **Rows with no `publishedAt`** (71,017 on dev, mostly drafts) fell back to `createdAt`.
- **6 rows are unscored.** They were created by dev's own jobs while the backfill ran. In production
  the sync trigger covers new rows; on dev they stay `NULL`.
- **The scores on dev are frozen.** Nothing keeps them current, so re-run the backfill before using
  dev for ranking comparisons.
- **Backfilling before creating the index** let the updates skip index maintenance for `hotScore`.
  Keep that order in production.

### Read performance

`EXPLAIN ANALYZE`, green-feed visibility filters, first 101 rows, each query run twice with the second
(warm) run reported:

| Scenario | Query | Time | Rows | Plan |
| --- | --- | ---: | ---: | --- |
| Default feed | **Hot · all time** | **1.0 ms** | 101 | index scan, `ModelMetric_hot_score` |
| | Highest Rated · all time | 0.6 ms | 101 | index-only scan, `feed_highest_rated` |
| | Highest Rated · Month (today's default) | 15.4 ms | 101 | index scan, filtering by date as it goes |
| Small tag (`openpose`) | **Hot · all time** | **4.3 ms** | **101** | tag index → metrics row → sort |
| | Today's default | 1.4 ms | **0** | same shape; the page is empty |
| Large tag (`character`, 554k models) | **Hot · all time** | **3.6 ms** | 101 | index scan, `ModelMetric_hot_score`, tag checked per row |
| | Today's default | 62.7 ms | 101 | index scan, `feed_highest_rated`, date and tag checked per row |
| Deep paging (row 5,000) | **Hot · all time** | **9.6 ms** | 101 | index scan, `ModelMetric_hot_score`, keyset cursor |
| | Highest Rated · all time | 0.8 ms | 101 | index-only scan, `feed_highest_rated` |

- **Hot is faster than today's default where it matters:** 15× on the default feed and 17× on a
  large tag, because it has no date filter to discard rows against.
- **For small tags, the planner starts from the tag**, which is cheap for any sort. What changes is
  that the page has content.
- **Deep paging is the one weak spot** (9.6 ms against 0.8 ms). The bare index holds only the score
  and id, so each candidate row needs a table lookup for status, rating and the other filters.
  `feed_highest_rated` carries those columns and never touches the table. It's still well under the
  50 ms target.
- **Every Hot query came in under 10 ms.**

**What this didn't cover:** the four `getModelsRaw` FROM shapes (including the per-base-model path),
the real app query with all its joins, and the replica under prod load. The queries here are
simplified versions of the default and tag paths.

### Open experiment: a covering index

Rebuilding as `INCLUDE (status, availability, mode, "nsfwLevel", poi, minor, "userId")`, matching the
other feed indexes, should turn the hot scans into index-only scans and bring deep paging close to
1 ms. It would also make the index several times larger. It hasn't been built yet. Build it next to
the bare one on dev, rerun the same queries, and keep whichever is worth its size.

### Left on dev

The column and the index are still in place. To remove them:

```sql
DROP INDEX CONCURRENTLY "ModelMetric_hot_score";
ALTER TABLE "ModelMetric" DROP COLUMN "hotScore";
```

The measurement script lives in the session scratchpad, not the repo.

---

## 7. How Hot works with baseModel filtering

Investigated 2026-10-06 against `main` at `4650509937`. Two blockers, one semantic change, and one
revision to the index recommendation.

### The shape already exists

`getModelsRaw` picks between four FROM shapes (`:980–1013`). What decides them is **where the sort
key lives**:

| Path | When | Drives from | Sort key |
| --- | --- | --- | --- |
| 1 | no base-model filter (or the `base-model-feed-metrics` flag off) | `ModelMetric` | `mm.*` |
| 2 | one base model | `ModelBaseModelMetric` | `mbm.*` (per-base-model stats) |
| 3 | many base models, **Newest/Oldest** | **`ModelMetric`**, semi-join `mbm` via `EXISTS`, per-base-model stats via `LATERAL` | `mm."lastVersionAt"` |
| 4 | many base models, per-base-model-stat sort | aggregate subquery over `ModelBaseModelMetric` | summed `mbm.*` |

**Hot is a per-model score, exactly like `lastVersionAt`** — not a per-base-model statistic. So it
belongs in **path 3's shape**, which already exists and was built for this problem: the comment at
`:519–526` records that the aggregate path cost ~2.8 s per query at deep cursors, because it scanned
every matching `ModelBaseModelMetric` row before the cursor predicate could apply.

So the change is to make the path condition depend on the sort's *home table* rather than on the sort's
name:

- `useNewestOldestMultiBmPath` becomes something like `useModelMetricDrivenPath`, true for
  Newest, Oldest **and Hot**.
- ~~It must apply for **one** base model too, not just many. Hot should never drive from `mbm`.~~
  **Reversed by §10:** one base model *does* drive from `mbm`, via a `hotScore` mirrored onto
  `ModelBaseModelMetric` and the `mbmm_feed_hot` index — 81 ms down to 1.1 ms for a mid-sized base
  model. Only the several-base-models case needed path 3's condition extended.
- Keep path 3's `LATERAL` sum, or the cards show whole-model download counts where the feed promises
  per-base-model ones.

The `EXISTS` semi-join is cheap: `ModelBaseModelMetric` has a primary key on
`("modelId", "baseModel")`, so the lookup is index-only. The table is ~898k rows / 665 MB with three
`mbmm_feed_*` covering indexes, none of which Hot needs, because Hot never sorts from it.

### 🔴 Blocker 1: a float score breaks keyset paging

`parseCursor` in `src/server/utils/pagination-helpers.ts` classifies each composite cursor token with
`NUMERIC_CURSOR_TOKEN = /^-?\d+$/` (`:18`) and parses the numeric branch with
**`parseInt(value, 10)`** (`:211`).

A `real` score emits a cursor token like `686.1234`. That token contains no `-`, so it takes the
numeric branch, and `parseInt` silently truncates it to **686**. The strict predicate then reads
`mm."hotScore" < 686`, which **skips every remaining row in the 686.x range** — dropped models, not
merely duplicated ones, and no error anywhere.

**Fix: store the score as an `int`, scaled.** `round(score * 10000)` makes every cursor token exactly
what `parseInt` reads back. At `T` = 1 month a score is ~686, so the scaled value is ~6.9M — nowhere
near `int4`'s limit — and the resolution is ~4 minutes of publish time, finer than anything a reader
can perceive.

The alternative is threading per-field types through `getCursor`/`getCursorClauses`. The test file
pins that as a known gap and calls it "a wider change" (`pagination-helpers.test.ts:130–160`). Not
worth taking on for this.

**This replaces the earlier `real` vs `double precision` question: it should be neither.**

### 🔴 Blocker 2: Hot must work with the mbm path flag both ways

`useBaseModelMetrics` is gated on the Flipt flag `base-model-feed-metrics` (`:515`). With the flag
**off**, a base-model filter becomes an `EXISTS` over `ModelVersion` on path 1, which already drives
from `ModelMetric` and so works with Hot unchanged. With it **on**, Hot needs the path-3 shape above.
Both states need checking; the flag is pre-existing and this adds no new gating.

### Semantic change worth your call

On the `mm`-driven path, the denormalised filter columns — `status`, `availability`, `mode`,
`nsfwLevel`, `poi`, `minor` — come from `ModelMetric` (whole model) rather than
`ModelBaseModelMetric` (that base model's rows). Path 3 does this deliberately, so the covering index
can apply filters during the scan.

So with a base-model filter, **Hot would filter on whole-model ratings while Highest Rated filters on
per-base-model ratings**. A model whose SDXL versions are PG but whose overall level is R can appear
under one sort and not the other. That divergence already exists between Newest/Oldest and Highest
Rated; Hot would join the first group.

### Revision: the index may need to be covering after all

The reason path 3 is fast is that `feed_newest` is **covering**, so the filters are applied inside the
index scan instead of against the heap. A bare `(hotScore, modelId)` index can't do that, which is
the same effect that made deep paging 9.6 ms instead of 0.8 ms (§6).

With a base-model filter the penalty is likely worse than for deep paging, since every candidate row
also needs the `EXISTS` probe. **So "bare index" is no longer a safe default** — it depends on
measurement that hasn't been done.

### What to measure next

Needs the dev column rebuilt (as `int` this time) plus two indexes, bare and covering, then
`EXPLAIN ANALYZE` across:

1. one base model, Hot, shallow and at depth
2. several base models, Hot, shallow and at depth
3. the same with the `base-model-feed-metrics` flag path off (the `ModelVersion` `EXISTS` shape)
4. Highest Rated with the same filters, as the control

**Closing condition:** each scenario has an `EXPLAIN ANALYZE` under 50 ms on dev with the chosen
index, and the bare-vs-covering decision is recorded here with both numbers.

---

## 8. Every surface a new `ModelSort` value touches

Audited 2026-10-06. `ModelSort` is a shared enum, and several places enumerate it rather than listing
sorts explicitly, so **adding `Hot` changes more than the model feed** whether we want it to or not.

| Surface | What happens when `ModelSort.Hot` exists | Action |
| --- | --- | --- |
| Models feed dropdown | Appears automatically — `sortOptions.models` is `Object.values(ModelSort)` minus `ModelSortHidden` (`SortFilter.tsx:37`) | intended |
| **Collection sort menus** | **Appears automatically** in every model collection: `modelCollectionSortOptions` spreads all visible values (`collection-sort.ts`) | **decide** |
| **Contest collections** | **Enters the random re-roll pool** — `contestModelSorts` is the same spread, and contest feeds re-roll each render to spread entry visibility | **decide** |
| App Blocks API (`/api/v1/blocks/models`) | Accepts `sort: z.enum(ModelSort)` and forwards to `getModelsRaw` (`:78`, `:152`); works once the column exists | no work |
| Public API (`/api/v1/models`) | Same schema, so `sort=Hot` becomes a documented value | changelog only |
| Home-page blocks | Unaffected — `modelFeedDefaults` pins `HighestRated` explicitly (`home-block.service.ts:320`) | none |
| Profile / storefront sections | Unaffected — each passes its own sort | none |
| 3D models feed | Unaffected — `Model3DSort` is a separate enum, deliberately "limited to keys we can actually compute against Model3D + Model3DMetric" (`model3d.schema.ts:11–14`) | none |
| Generator resource picker | Unaffected — its own `ResourceSort`, served from Meilisearch via `meiliSortFor` (`resource-select.service.ts:56`) | see below |
| `sort-availability.ts` | No change needed. It withholds only `Newest`/`Oldest` by name, and `resolveFeedSort` rewrites image feeds only | none |

### Collections and contests are the decision

Both menus are built by spreading the enum, so Hot arrives in them with no code change — including
the random sort re-roll on contest feeds. It would *work* (collections pass `ids` and go through the
`mm` path), but nobody asked for it.

Decided and implemented: `modelCollectionSortOptions` and the contest pool are listed explicitly in
`collection-sort.ts`, with Hot left out of both, so neither menu tracks the enum any more. Adding Hot
to `ModelSortHidden` was the alternative and was rejected — it would also remove Hot from the feed.

### The resource picker can't have Hot

The generator's picker is Meilisearch-backed and sorts via `meiliSortFor`, so offering Hot there
would need a new sortable attribute on the models index — a reindex, and off the table under the
"no new Meilisearch work" rule. Not a loss: the picker's job is finding a known resource, not
browsing. Worth stating so nobody tries to make the two menus match.

### A ready-made test harness exists

`src/pages/api/internal/test-model-feed-filters.ts` already runs `getModelsRaw` through **both**
query paths — standard and `ModelBaseModelMetric`, via `_forceBaseModelMetrics` — with filters, and
reports per-path results. It's a token-guarded `JobEndpoint`. Extending it with Hot cases is the
cheapest way to prove §7's path work, and it beats hand-written EXPLAINs for the correctness half.

### Also worth knowing: green has no recency sort today

`isSortAvailable` withholds `Newest` and `Oldest` from **every** feed type for a viewer who can't
view NSFW, because a freshly posted image may not be rated yet. On the models feed that leaves
green with no recency-ordered option at all. Hot isn't withheld (the rule matches by name), so it
would become the only way a green visitor sees recent models — a stronger argument for it than
anything in §2.

**Closing condition:** the collections/contests decision is recorded here, and
`test-model-feed-filters.ts` covers Hot on both query paths.

---

## 9. Fresh lists (2026-10-06)

Pulled for item 2's sign-off, read-only against prod. Blended engagement, integer-scaled score,
green-feed visibility filters. `L` = all-time likes, `D` = downloads, `G` = generations.

### Today, Highest Rated (shown here at All Time, so the ranking is visible without the date filter)

```
1  2024-01-08   76,926L   1,103,573D  290,324,385G  Pony Diffusion V6 XL
2  2023-04-26   63,154L   1,257,730D      226,148G  majicMIX realistic
3  2023-01-12   58,178L   1,687,410D   16,127,039G  DreamShaper
4  2023-01-09   52,915L   2,337,809D    1,828,244G  Realistic Vision V6.0 B1
5  2023-02-10   51,418L     758,446D  133,018,407G  EasyNegative
6  2023-01-13   44,454L     482,852D      329,808G  Counterfeit-V3.0
7  2023-08-04   43,702L     456,338D  126,149,762G  Detail Tweaker XL
8  2023-02-07   40,780L     537,868D      754,656G  MeinaMix
```

Nothing newer than Jan 2024. With the Month filter on top, this becomes the same list restricted to
whichever of them shipped a version recently (§1).

### Hot, `T` = 1 month — "new and taking off"

```
1  2026-09-27      287L       2,466D       14,761G  Draco "Malfoid" Malfoy Redteneri Gen
2  2026-09-18      382L       5,085D       14,799G  [BSS] - DesireX - [Krea2]
3  2026-09-26      190L       3,149D           22G  Minimax H3 - Male Pov
4  2026-09-27      162L       2,907D            0G  Qwen Image 2.1 Consistency LoRA
5  2026-09-24      134L       4,294D            0G  [Qwen Image 2.1] Character Design Sheet
6  2026-09-29      157L       1,891D            0G  Ray Qwen2.1 编辑强化
7  2026-08-21    1,543L      46,725D            0G  DaSiWa MiniMax H3
8  2026-09-23      111L       3,921D            0G  Qwen 2.1 Turbo LoRas
```

Seven of eight published in the last three weeks, tracking the Qwen Image 2.1 and Minimax H3
releases.

### Hot, `T` = 3 months — "best of the season"

```
1  2026-08-21    1,543L      46,725D            0G  DaSiWa MiniMax H3
2  2026-08-03    2,005L      43,938D          218G  Minimax H3 INT8/INT6/INT4 ConvRot
3  2026-08-22      884L      28,009D            0G  Minimax H3 SEED HUNTER - Latent Upscale
4  2026-08-06    1,104L      40,614D       10,142G  Minimax H3 Turbo LoRas
5  2026-06-26    3,434L     112,986D       10,738G  Moody Krea 2 Mix (uncensored)
6  2026-07-13    2,467L      48,672D      284,755G  Krea2 TextFusion Refusal-Reduction LoRA
7  2026-06-29    1,674L      15,232D    1,262,505G  Krea 2 Turbo
8  2026-08-03    1,100L      29,142D            0G  DaSiWa MiniMax H3 Workflows
```

The two settings differ more than they did in September: 1 month now surfaces models with ~100–400
likes from the last fortnight, while 3 months holds the August checkpoint wave. Neither overlaps
today's list at all.

---

## Needs your review or input

### Needs you

1. **Period label wording — the only open question.** The filter means "updated in this window"
   today, with or without Hot. Proposed: the menu header becomes **"Updated in"**, options read
   "Updated today / this week / this month / this year / any time". Justin was unsure this is needed
   (2026-10-07); parked rather than decided, and it ships independently of everything else here.
2. **Sanity check, not a blocker:** with one base model Hot filters per base model (like Highest
   Rated), with several it filters whole-model (like Newest). §10 explains why. Same split as today,
   but say so if it should be uniform.

### Answered by Justin, 2026-10-07

3. **Top-50 ordering: signed off.** The §9 lists are approved.
4. **Default scope: `/models` and tag pages only**, not every model feed.
5. **Saved preferences: yes** to the one-time rewrite of the exact `Highest Rated · Month` pair.
   `periodFallback` is deleted in the same PR.
6. **Migrations: Justin applies each step by hand**, and the migration must be shippable before the
   code with no downtime. That requirement is what put the score computation in a database trigger
   rather than the app — see [§11](#11-zero-downtime-rollout).
7. **Index: covering, on both metric tables.** Measured (§10): covering beats bare on every scenario
   for 24 MB, and the base-model path needs `mbmm_feed_hot` as well or mid-sized base models cost up
   to 81 ms.

### Resolved 2026-10-06, with rationale

8. **Hot stays out of collection and contest menus.** `collection-sort.ts` builds both by spreading
   the enum, so Hot would arrive in every collection's menu and in contest feeds' random sort
   re-roll with no code change (§8). Nobody asked for that, and a contest re-roll landing on Hot
   changes which entries get seen. **Implementation:** list the model collection options explicitly
   instead of spreading `Object.values(ModelSort)`, so the two menus stop being coupled.
   `ModelSortHidden` is the wrong tool — it would also remove Hot from the feed dropdown.
9. **Signal weights stay equal — but the first divisors were wrong.** Likes + downloads/6.4 +
   generations/4.1, normalized so each contributes equally to a *median* model. The original
   reading here ("the top lists barely differ") was measured over a sample too small to show it and
   is **false**: the divisors move the feed more than any other parameter. §13 has the correction.
10. **Filtering semantics — superseded by §10.** This read "Hot filters on whole-model ratings,
    following Newest/Oldest", on the assumption the score would live only on `ModelMetric`.
    Measurement forced the score onto `ModelBaseModelMetric` as well, so with **one** base model Hot
    drives from `mbm` and filters per base model, like Highest Rated; only the **several base models**
    case filters whole-model. Kept visible because the reasoning was sound and the premise was wrong.
11. **One `T`, not two.** Two aging speeds means two columns and two indexes for a difference nobody
    has seen yet. Start with one; a second is additive later.
12. **Score type: `int`, not `real`.** `round(score * 10000)` — the cursor parser truncates float
    tokens with `parseInt` and silently drops rows (§7).
13. **No feature-flag gating.** Decided 2026-10-06.
14. **Dev artifacts stay on dev for now.** Columns, trigger and indexes are in place so the numbers can be re-checked; §10 has the teardown SQL.

---

## Recommendation and size

Build the stored hot score, make `Hot` + `AllTime` the client default, migrate the saved default
pair, then delete `periodFallback`.

| Step | Size |
| --- | --- |
| Staged migration: columns, trigger update, batched backfill, concurrent index (**applied manually**) | ~0.5–1 day |
| `ModelSort.Hot` across the four `getModelsRaw` paths, keyset cursor, EXPLAIN per path | ~1 day |
| Client default, one-time localStorage migration, dropdown check | ~0.5 day |
| Delete `periodFallback`, `periodFallbackApplied` and the retry block | small |

**About 2–3 days**, with most of the risk in the per-base-model query paths.

### Follow-ups, each with a closing condition

- **Done (this branch): build the hot sort.** `ModelSort.Hot` is the client default on `/models` and
  tag pages; every path measured under 5 ms on dev (§10, §12); ordering approved 2026-10-07 (§9).
  The migration is applied in production and verified on the replica — 0.5–5.6 ms across every path
  (§11). Only the merge and deploy are left.
- **Done (this branch): `T` and the signal weights.** One `T` at 1 month; likes, downloads and
  generations weighted equally.
- **Done (this branch): migrate saved defaults.** The one-time rewrite and the `periodFallback`
  deletion are in the same change.
- **Done (this branch): covering vs bare index.** Covering, on both metric tables — `feed_hot` and
  `mbmm_feed_hot` (§10).
- **Align server and client defaults.** They now differ on `sort`: the server default also answers
  `/api/v1/models`, so it stays `Highest Rated`. Closes when that difference is either removed or
  pinned by a test that states why it exists.
- **Document `Hot` in the public API reference.** `/api/v1/models` and `/api/v1/blocks/models` parse
  `getAllModelsSchema`, so `sort=Hot` becomes a valid documented value. Closes when the
  `civitai-developer-docs` page for those endpoints lists it.
- **Clean up dev.** Closes when the columns, triggers and indexes are dropped from dev (§10 has the
  SQL), or Justin decides to keep them.

---

## 10. Base-model measurements (2026-10-07)

Run on dev with an `int` `hotScore`, a `publishedAt` column, a BEFORE trigger, and three candidate
indexes. **This overturns part of §7: Hot needs the score on *both* metric tables, and then it needs
almost no new query path.**

### The indexes

| Index | Size |
| --- | ---: |
| `ModelMetric_hot_bare` — `(hotScore DESC, modelId)` | 21 MB |
| `ModelMetric_hot_covering` — same + `INCLUDE (status, availability, mode, nsfwLevel, poi, minor, userId)` | **45 MB** |
| `mbmm_feed_hot` — `(baseModel, hotScore DESC, modelId) INCLUDE (…)` on `ModelBaseModelMetric` | **54 MB** |

Shipped names: the covering `ModelMetric` index is **`feed_hot`** in the migration, matching the
existing `feed_*` family. The `ModelMetric_hot_*` names in this section were dev-only.

Both chosen indexes are far smaller than feared — `feed_highest_rated` alone is 296 MB. Each built
concurrently in about a second on dev.

### Covering beats bare everywhere, for 24 MB

| Scenario | bare | covering |
| --- | ---: | ---: |
| default feed | 0.93 ms | **0.68 ms** |
| deep page (row 5,000) | 9.31 ms | **2.44 ms** |
| one base model (Illustrious) | 3.34 ms | **1.77 ms** |
| one base model (Flux.1 D) | 39.96 ms | **23.22 ms** |
| three base models | 2.79 ms | **2.10 ms** |
| one base model + deep page | 10.77 ms | **3.47 ms** |
| flag-off shape (`ModelVersion EXISTS`) | 4.11 ms | **3.09 ms** |

**Decision: covering.** 24 MB for 2–4× on every row, and it makes deep paging a non-issue.

### The `ModelMetric` index alone is not enough

With only `ModelMetric_hot_covering`, a base-model filter makes the planner walk the hot index looking
for matches. For mid-sized base models it walks a long way:

| Base model | models | time |
| --- | ---: | ---: |
| Illustrious | 345,630 | 1.8 ms |
| Anima | 52,208 | 2.3 ms |
| SDXL 1.0 | 59,179 | 15.8 ms |
| Flux.1 D | 51,398 | 26.7 ms |
| Krea 2 | 13,309 | 56.0 ms |
| **NoobAI** | **11,505** | **80.9 ms** |
| Hunyuan 1 / Stable Cascade / PixArt E | 63–70 | 0.7–1.2 ms |

Both ends are fine: a huge base model matches quickly, and a rare one makes the planner drive from
`mbmm_feed_*` and sort a handful of rows. The **middle** is the problem. `ANALYZE` on both tables
changed nothing (80.9 → 81.2 ms), and rewriting the query to drive from `ModelBaseModelMetric` and
sort was worse (115.7 ms).

### The fix: copy the score onto `ModelBaseModelMetric` too

Exactly how the existing sorts work — `feed_highest_rated` on `ModelMetric` *and*
`mbmm_feed_highest_rated` on `ModelBaseModelMetric`. The copied value is the model's score, not a
per-base-model one, so the ordering is identical.

| Base model | before | after |
| --- | ---: | ---: |
| NoobAI | 80.9 ms | **1.1 ms** |
| Krea 2 | 56.0 ms | **1.4 ms** |
| Flux.1 D | 26.7 ms | **1.9 ms** |
| SDXL 1.0 | 15.8 ms | **3.0 ms** |
| Illustrious | 1.8 ms | **4.3 ms** |

Worst case across every base model tested: **4.3 ms**.

### Which means Hot fits the paths that already exist

| Case | Path | Measured |
| --- | --- | ---: |
| no base-model filter | existing path 1, `mm."hotScore"` | 0.68 ms |
| one base model | existing path 2, `mbm."hotScore"` via `mbmm_feed_hot` | 1.1–4.3 ms |
| several base models | **path 3's shape** (`mm`-driven + `EXISTS`), not path 4 | 2.10 ms |
| flag off | existing path 1 + `ModelVersion EXISTS` | 3.09 ms |

Only the third needs a code change: extending path 3's condition to cover Hot. That is far less work
than §7 estimated.

**Why not path 4 for several base models:** the aggregate shape costs **1,453 ms** for Hot — and
**1,459 ms** for Highest Rated, measured side by side. That path is already slow today for every
per-base-model sort; it is not a Hot problem. Routing Hot down path 3 instead makes it ~700× faster
than today's equivalent query and leaves the pre-existing problem alone.

### This revises the filtering-semantics decision

§7 concluded Hot would filter on whole-model ratings, following Newest/Oldest. With the score on both
tables that applies only to the **several base models** case. With **one** base model Hot drives from
`mbm` and filters per base model, exactly like Highest Rated. So Hot matches whichever sort shares its
path — the same split that exists today between Highest Rated and Newest. Worth a sanity check, but
strictly less divergence than §7 described.

### Cost of the second copy

- **Storage:** 45 MB + 54 MB of index, plus an `int` column on each table.
- **Writes:** `ModelBaseModelMetric` holds ~898k rows for ~949k models, so roughly one row per model.
  Keeping the copy current is one extra row update per score change — the same order as the ~17k/hour
  the metrics job already writes.
- **Backfill on dev:** 959,135 `ModelMetric` rows in ~62 s; 885,766 `ModelBaseModelMetric` rows in
  ~35 s.

### The trigger, and why it matters for zero downtime

The score is computed by a BEFORE INSERT/UPDATE trigger on `ModelMetric`, not by the app:

```sql
NEW."hotScore" := round((log(1 + NEW."thumbsUpCount" + NEW."downloadCount" / 6.4
                             + NEW."generationCount" / 4.1)
                         + extract(epoch FROM NEW."publishedAt") / 2592000) * 10000)::int;
```

Verified on dev: adding 1,000 likes moved a model's score by exactly 30,004, which is
`log10(1001) × 10000`.

Because the database owns the computation, **no application version can skip it**. That is what makes
the migration safe to apply before the code ships: during a rolling deploy, old pods updating counts
still produce correct scores. If the app computed the score, rows touched by old pods would hold stale
values until their counts next changed.

### Left on dev

Two columns, one trigger, three indexes and the `ModelBaseModelMetric` column. To remove — the
second half applies only if dev also has `20261012120000`, and `IF EXISTS` makes it harmless if not:

```sql
DROP INDEX CONCURRENTLY "ModelMetric_hot_bare";
DROP INDEX CONCURRENTLY "ModelMetric_hot_covering";
DROP INDEX CONCURRENTLY "mbmm_feed_hot";
DROP TRIGGER trg_model_metric_hot_score ON "ModelMetric";
DROP FUNCTION public.model_metric_hot_score();
ALTER TABLE "ModelMetric" DROP COLUMN "hotScore", DROP COLUMN "publishedAt",
                           DROP COLUMN "uniqueGeneratorCount";
DROP TRIGGER IF EXISTS trg_base_model_metric_hot_score ON "ModelBaseModelMetric";
DROP FUNCTION IF EXISTS public.base_model_metric_hot_score();
ALTER TABLE "ModelBaseModelMetric" DROP COLUMN "hotScore",
    DROP COLUMN IF EXISTS "generationCount",
    DROP COLUMN IF EXISTS "uniqueGeneratorCount",
    DROP COLUMN IF EXISTS "publishedAt";
```

Left in place so the numbers can be re-checked.

---

## 11. Zero-downtime rollout

Justin applies each step by hand, and the migration has to be safe to apply **before** the code ships,
with no window where either half is broken.

The trigger is what makes that work: the database computes and maintains `hotScore` on its own, so the
app needs no write path, and no deploy ordering with respect to it.

### Step 1 — migration, applied alone (safe while current code runs)

1. `ALTER TABLE "ModelMetric" ADD COLUMN "publishedAt" timestamp, ADD COLUMN "hotScore" integer;` and
   `ALTER TABLE "ModelBaseModelMetric" ADD COLUMN "hotScore" integer;` — metadata only, no rewrite,
   ~90 ms each on dev.
2. Add the `hotScore` trigger on `ModelMetric`, and extend `sync_model_to_metric` to copy
   `coalesce(Model."publishedAt", Model."createdAt")` into `ModelMetric."publishedAt"`.
3. Mirror `ModelMetric."hotScore"` into `ModelBaseModelMetric` (its own trigger, or extend the
   existing `trg_sync_model_to_base_model_metric`).
4. Backfill both tables in batches.
5. `CREATE INDEX CONCURRENTLY` for `feed_hot` and `mbmm_feed_hot`.

Nothing reads `hotScore` yet, so this is invisible to users. **Why it is safe with the old code
running:** Prisma selects explicit column lists, so a client that does not know the new columns
ignores them, and `getModelsRaw` is raw SQL that never does `SELECT *`.

### Step 2 — ship the code

`ModelSort.Hot`, the path-3 condition change, the client default, the explicit collection options, and
the one-time localStorage rewrite. By then every row already has a current score, and the trigger
keeps it current regardless of which pods are running. `periodFallback`, `periodFallbackApplied` and
the retry block in `getModelsInfiniteHandler` are deleted in this same change.

### Rollback

Revert the code; the columns, triggers and indexes are inert without it. There is no data migration to
undo, and the localStorage rewrite is bounded to one exact sort/period pair.

### Step 1 verified in production (2026-10-07)

Applied by hand, then checked on the replica.

| Check | Result |
| --- | --- |
| `hotScore` NULL | **0** of 961,119 `ModelMetric`, **0** of 899,716 `ModelBaseModelMetric` |
| `publishedAt` NULL | **6**, all orphan metric rows with no `Model`, none published, top score 3,010 |
| Future-date clamp | 213 future rows, **none** scored above a `now()`-clamped recompute; `max_future` 6,914,848 < `max_published` 6,942,365 |
| Triggers | all 3 attached |
| Indexes | `feed_hot` 45 MB, `mbmm_feed_hot` 55 MB, both `indisvalid` — against 318 MB for `feed_highest_rated` alone |
| Backfill procedure | dropped |

`EXPLAIN ANALYZE` on the replica, green-site filters, first 101 rows, second of two runs:

| Scenario | Index | Dev | **Prod** |
| --- | --- | ---: | ---: |
| default feed (path 1) | `feed_hot` | 0.68 ms | **0.75 ms** |
| deep page (row 5,000) | `feed_hot` | 2.4 ms | **5.6 ms** |
| one base model (6 tested) | `mbmm_feed_hot` | 1.1–4.3 ms | **0.50–0.82 ms** |
| three base models (path 3) | `feed_hot` + pkey | 2.1 ms | **2.2 ms** |
| flag-off shape | `feed_hot` + `ModelVersion` | 3.1 ms | **4.2 ms** |
| control: today's default | `feed_highest_rated` | 15.4 ms | **12.6 ms** |

Every path is an index-only scan on the intended index, no sort node, no seq scan, and every buffer a
cache hit. Mid-sized base models — the 81 ms case that justified the mirror index (§10) — come in
under 1 ms on prod, better than dev.

One difference from dev: `Heap Fetches` is not 0 (325 on the default feed, 3,964 on the deep page).
`ModelMetric` is upserted every minute, so the visibility map goes stale between autovacuums; the
scan stays index-only and the fetches were all cache hits, which is why they cost nothing measurable.
Dev read 0 only because the migration's vacuum had just run.

**Closing condition:** met — step 1 applied to production, both indexes present and valid, and the
replica matches the dev numbers. Step 2 is clear to ship.

---

## 12. Second review (2026-10-07): three traps and the tag-page numbers

A deliberate pass over the design looking for what the measurements didn't cover. Three real traps,
all found and fixed on dev, plus the tag-page numbers that started this whole thing.

### Trap 1 — a NULL score sorts to the TOP of the feed

`ORDER BY "hotScore" DESC` puts NULLs **first** in Postgres. Proven on dev: seven rows had a NULL
score, and they were the first seven rows the query returned.

The NULLs came from rows created *after* the backfill — the prod `sync_model_to_metric` trigger
doesn't set `publishedAt`, so new rows had none, and `extract(epoch FROM NULL)` is NULL. On dev all
seven happened to be `Draft`, so the feed's `status = 'Published'` filter hid them. **That is luck,
not design**: one published model with a NULL `publishedAt` would sit above every other model on the
site.

Ordering with `DESC NULLS LAST` is not the fix — it **can't use the index**. Measured: the planner
abandoned the index ordering and quicksorted ~423k rows (146 ms in the scan alone), because a `DESC`
index is `NULLS FIRST` and the orderings don't match.

**Fix: the score is never NULL.** The trigger coalesces a missing `publishedAt`:
`coalesce(NEW."publishedAt", TIMESTAMP 'epoch')`, so an unknown date sorts **last** — falling back to
`now()` would hand every unpublished or orphaned row the freshest possible time term. Verified on
dev: 0 NULL scores afterwards, and the plain `DESC` index keeps working.

### Trap 2 — a future publish date pins a model to the top forever

The score rises with publish time, so a model dated in the future outranks everything. This is the
same hazard the existing `lastVersionAt` guard was written for — the
`20260501135000_tighten_sync_model_to_metric` migration refuses to propagate a future
`lastVersionAt` precisely because "a future value pins the model to the top until the date arrives."

Current exposure on prod: **237 models have a future `publishedAt`**, the furthest about 3 months
ahead — and **none of them are Published**, so nothing is wrong today. At `T` = 1 month, 3 months
ahead is worth +30,000 score points, which would clear the current maximum. So it is latent, not
live, and worth the same guard the neighbouring column already has.

**Fix:** clamp in the trigger — `least(coalesce(NEW."publishedAt", TIMESTAMP 'epoch'), now())`.
Verified on dev:
the future-dated rows now score 6,914,760 against a normal maximum of 6,941,744, i.e. below the top
instead of above it.

### Trap 3 — the base-model metrics job leaves new rows unscored

`basemodel.metrics.ts` upserts `ModelBaseModelMetric` with an explicit column list that doesn't
include `hotScore`, and its `ON CONFLICT DO UPDATE` sets only the three counts and `updatedAt`.

- **Existing rows:** safe. The upsert preserves a mirrored `hotScore`.
- **New rows:** `hotScore` is NULL — and since this job runs continuously, a model gaining a base
  model would land at the **top** of that base model's Hot feed (trap 1 again, in the path where it
  fires routinely).

**Fix:** the mirroring has to be a trigger on `ModelBaseModelMetric` (BEFORE INSERT OR UPDATE, pulling
the model's current score), not a one-way push from `ModelMetric`. A push-only design would always
lose this race.

### Tag pages, re-measured with the final setup

The reason this proposal exists. Hot vs today's default, on dev:

| Tag | models | today's default | Hot |
| --- | ---: | --- | --- |
| `openpose` | 305 | 1.4 ms, **1 row** | 3.7 ms, **101 rows** |
| `concept` | 70,306 | 50.0 ms, 101 rows | **4.0 ms**, 101 rows |
| `character` | 560,573 | 80.0 ms, 101 rows | **2.7 ms**, 101 rows |

`openpose` is the case in one line: today it returns **one model out of 305**. The `periodFallback`
stop-gap doesn't help, because one row isn't zero rows. Hot returns a full page, and on the big tags
it is also 12–30× faster.

### What this changes in the migration

Two additions to [§11](#11-zero-downtime-rollout) step 1:

1. The `ModelMetric` trigger coalesces and clamps:
   `extract(epoch FROM least(coalesce(NEW."publishedAt", TIMESTAMP 'epoch'), NOW()))`.
2. `ModelBaseModelMetric` gets its own BEFORE INSERT OR UPDATE trigger that reads the model's score,
   rather than `ModelMetric` pushing into it.

Both are verified on dev. The indexes stay plain `DESC` — no `NULLS LAST` anywhere, since the score
can no longer be NULL.

---

## 13. Tester round (2026-10-08): the divisors were the bug

Testers saw the feed on a preview build before PR #5523 merged. Nobody hit a correctness or
performance problem — "seems to play nicely when combined with other filters" — but three people
independently said the *mix* was wrong: too many Qwen and MiniMax H3 models, and you had to scroll a
long way to reach an Illustrious one. They were right, and the cause was not the one that looked
obvious.

### What it was not: the recency weight

The first hypothesis was that `T` = 30 days is too steep. Widening it makes Illustrious **worse**,
because it admits *older* models from the same over-scored ecosystems:

| `T` | Illustrious in top 100 | First Illustrious-only | Qwen/H3/Krea 2 |
| ---: | ---: | ---: | ---: |
| 30 days (shipped) | 14 | rank 11 | 83 |
| 60 days | 8 | rank 33 | 92 |
| 90 days | 3 | rank 69 | 92 |

Measuring this first is what stopped a wrong fix shipping. The damage was in the engagement term.

### What it was: sum ratios are not per-model ratios

The divisors were set from site-wide **sum** ratios — total downloads ÷ total likes, total
generations ÷ total likes. For downloads that is nearly right. For generations it is off by 28x,
because the sums are dominated by a few checkpoints with billions of generations apiece:

| | sum ratio (used at first) | median per-model ratio |
| --- | ---: | ---: |
| downloads per like | 8.5 | **6.4** |
| generations per like | 117 | **4.1** |

On the median published model — 56 likes, 371 downloads, 231 generations — `generations/114`
contributed **2%** of engagement. The signal was effectively switched off, which is exactly what one
tester said: *"Not sure I agree with downloads having so much weight compared to generations."*

### Why it looked like a base-model problem

Dividing every model's downloads by a single constant also converts ecosystem scarcity into apparent
quality. Download-per-like is not uniform — 5.7 for Illustrious, 6.2 Pony, 7.3 Anima, against 17.3
for MiniMax H3, 17.7 Qwen 2.1, 20.7 Wan — and 8.5 sits at the mature end because the corpus is
mostly Illustrious, Pony and SD 1.5. A small ecosystem concentrates demand onto few models:
Illustrious published 12,141 models in 45 days against Qwen 2.1's 160, and the median recent Qwen
2.1 model (28 likes, 518 downloads) out-scored the **95th percentile** Illustrious model.

### The fix and what it moved

**Applying it:** `20261010120000` had already run in production when the constants changed, and it
was edited in place rather than superseded. A trigger redefinition does **not** rescore existing
rows — each row recomputes only when its own counts next move — so the file has to be re-run, which
is why its backfill grew a `force` parameter defaulting to true. Done on production 2026-10-08.

Two constants. Nothing else changed — no schema, no index, no application code, because the score
lives in a trigger.

| | Illustrious /100 | First Illustrious-only | Qwen/H3/Krea 2 | 500+ generations | Oldest in top 100 |
| --- | ---: | ---: | ---: | ---: | --- |
| sum ratios | 15 | rank 11 | 82 | 16 | 47 days |
| **median ratios** | **33** | **rank 4** | **55** | **56** | **100 days** |

All three complaints answered by one change, including the "freshness curve is too steep" one:
correcting the divisors widened the engagement term's range from 5.15 to 6.31 log units, and that
range *is* how far back the feed can reach. Widening `T` was the wrong lever for it.

### Two findings that settled other questions

**Version spam.** A tester expected Hot to reward creators who republish a "new version" every two
weeks. It is the opposite — the *old* default was the vulnerable one. For the 10,107 models with 5+
published versions, `lastVersionAt` (what `period: Month` filtered on) tracks the newest version in
**10,079** cases; `Model.publishedAt` (what Hot uses) in **724**, sitting on average 290 days
earlier. Republishing reset the old window and moves a Hot score by zero. A new version still earns
real downloads and generations, which is uptake, not a free recency reset.

**Perennial winners.** Another tester expected models like WAI-Illustrious to be permanently hot.
They are not, and cannot be: a frozen publish date puts WAI-Simple-Illustrious at rank 973 today,
276 after the fix. That concern becomes real only if the time term is replaced with a windowed
engagement, which is the next piece of work — see
[model-feed-unique-posters.md](model-feed-unique-posters.md) §6.

---

## 14. Capping generations by distinct generators (2026-10-08)

Migration `20261011120000`. A tester found a model near the top of the Hot feed with no likes,
single-digit downloads and several hundred generations, and guessed the generations were the
creator's own. They were: `orchestration.jobs` shows one generating user and it is the model's owner.

This is a consequence of §13. Moving the generation divisor from /114 to /4.1 was right, but it
raised what self-generating is worth by the same factor. A count of events is a count of effort, and
one account can supply all of it.

### How much of the feed it was

| Top 100 | Count |
| --- | ---: |
| models with 100+ generations | 68 |
| models with a single generating user | **7** |
| of those, generated only by the owner | **4** |
| worst case | 25,444 generations, 14 likes, 1 user |

### The data already existed

`daily_resource_generation_user_counts.users_state` holds a `uniq` state per model version, and
`uniqMerge` over it matched `orchestration.jobs` exactly on every version checked. No new
materialized view, no new pipeline.

Only the all-time merge is sound, though: despite the name, the view's current rows carry no usable
date (§17). That costs this signal nothing — it wants the all-time count — but it rules the view out
as the source for anything windowed.

It cannot go through `ModelVersionMetric` the way `generationCount` does, because
`getVersionAggregationTasks` **sums** version rows into `ModelMetric` and summing per-version distinct
counts double-counts anyone who used two versions. The count is merged in ClickHouse instead —
`transform()` maps each version to its model, `uniqMerge` collapses the states — and written straight
to `ModelMetric`.

### Choosing the constant

`generation term = least(generationCount / 4.1, uniqueGeneratorCount * 100)` (floored in §16)

Generations per unique generator, over models with 100+ generations, merged properly: median **44**,
p90 **460**, max **25,444**. Simulated over the 400 strongest candidates:

| Cap (like-equivalents per generator) | Single-generator models left | Zero-like models left | Illustrious /100 | 500+ gens | Legit models clipped |
| ---: | ---: | ---: | ---: | ---: | ---: |
| none (live before) | 7 | 3 | 34 | 57 | 0 |
| **100** | **0** | **0** | **34** | **53** | **1** |
| 50 | 0 | 0 | 36 | 52 | 6 |
| 25 | 0 | 0 | 33 | 47 | 9 |
| 10 | 0 | 0 | 30 | 41 | 14 |

100 is the gentlest cap that fully removes the exploit — the models it targets sit two orders of
magnitude above p90, so nothing is gained by squeezing legitimate generation-heavy models. 50 buys
two extra Illustrious slots for six clipped models; a reasonable alternative, and the constant is one
number in a trigger with no deploy attached.

Verified on dev after populating the top 3,000 candidates: 0 single-generator models in the top 100,
56 of 2,459 populated rows capped, and 74 of the new top 100 holding their exact prior score — the
cap is surgical rather than a reweighting.

### Rollout and what "done" means

Apply `20261011120000` behind `SET lock_timeout = '5s'` **before** the deploy — the opposite of
`20261010120000`, which wanted both timeouts cleared for its concurrent index builds. The order is
not advisory: the deploy adds `uniqueGeneratorCount` to `modelMetricKeys`, and `bulkInsertMetrics`
builds its INSERT column list from every key in that array unconditionally, so the whole model
metrics job throws against a database without the column.

The migration changes no score on its own. Then drive
`/api/admin/temp/backfill-unique-generators` with `maxModels`, feeding `nextStartId` back as
`startId` until `done` comes back true.

**Done when the top-100 single-generator check returns 0** — not when every model has a count. A
published model with generations but no row in the ClickHouse generator view keeps
`uniqueGeneratorCount = 0` for good, so the migration's `not_computed` figure never reaches 0. (As of
§16 that 0 earns no generation credit rather than staying uncapped.) On the 2026-10-08 production run that residue was 1,118 models, none of which rank
anywhere near the feed — the best sat at rank 9,354 and none were in the top 1,000. Their breakdown
(98% absent from the generator view, which the generation-count view does know about) is a
ClickHouse coverage gap, not a backfill failure.

**Done on production 2026-10-08:** 681,862 models scanned, 564,097 counts written, 7,149 capped,
and the top-100 check reading 0 single-generator and 0 zero-like models.

### What it does not fix

A **two-account** pair still works. One zero-like model remained in dev's top 100 with 2 generators
and 727 generations — 364 per account, above the median but under p90, so the cap at 100 lets it
through. The cap raises the cost of the attack (accounts, plus ~410 generations each) without
removing it. The sockpuppet floor in
[model-feed-unique-posters.md](model-feed-unique-posters.md) §5 is the same problem and wants one
answer for both signals.

### A related question the cap does not answer

A moderator pointed out that generation rates differ sharply by ecosystem — MiniMax H3 models earn
far fewer generations per download than Illustrious ones — so weighting generations more heavily
penalises ecosystems that are not generated on-site. The mechanism is real. The magnitude is small:
median score change from the §13 divisor fix, for models published in the last 120 days with 10+
likes, expressed as days of recency gained.

| Base model | Models | Days of recency gained |
| --- | ---: | ---: |
| SDXL 1.0 | 383 | +4.2 |
| Pony | 749 | +4.1 |
| Illustrious | 24,448 | +3.8 |
| NoobAI | 393 | +3.0 |
| MiniMax H3 | 843 | +2.8 |
| Krea 2 | 7,901 | +2.8 |
| Qwen 2.1 | 147 | +2.7 |
| Anima | 25,464 | +2.4 |

Every ecosystem **gained**, because the download divisor also moved. The relative disadvantage for
MiniMax H3 against Illustrious is about **one day** of recency, against a feed that reaches back 69
days.

What actually changed the mix is population, not penalty: Illustrious has 24,448 recent models to
H3's 843, so lifting a huge population slightly displaces a small one from a fixed 100 slots. Fixing
this properly means per-ecosystem divisors — the same machinery §13 rejected — and it should be
weighed against the fact that the per-model effect is a single day.

## 15. Per-base-model scoring (2026-10-12)

Migration `20261012120000`. A moderator reported that a model's position in a *filtered* feed did not
match its presence in that ecosystem: filter to Anima and models whose Anima slice was small
outranked models whose every download was Anima. One of them led the feed.

`ModelBaseModelMetric."hotScore"` was a **copy** of the whole-model score, added as a deliberate
simplification in `20261010120000`. So every filtered feed credited a model for engagement it earned
somewhere else, and the more ecosystems a model spanned the more it borrowed.

### What the slice score needed

`thumbsUpCount` and `downloadCount` were already per base model on that table. Three columns were
not, and all three are needed before a row can leave the mirror:

| Column | Source | Why it could not already be there |
| --- | --- | --- |
| `generationCount` | `SUM(ModelVersionMetric)` | plain SQL aggregate, just never selected per slice |
| `publishedAt` | `MIN(ModelVersion."publishedAt")` for the slice | the model's own date is the wrong date (below) |
| `uniqueGeneratorCount` | ClickHouse `uniqMerge`, grouped by (model, base model) | Postgres cannot read the view |

**The time term is the earliest published version FOR THAT BASE MODEL.** The model's first publish
date would make a brand-new Anima version on a two-year-old model read as two years old in the Anima
feed — the complaint inverted. The newest version's date would re-open the version-spam incentive
§13 closes, inside every filtered feed. The earliest version for that base model gets both right: a
model's first Anima version is new in the Anima feed and still old in the Illustrious feed, and a
second Anima version later refreshes nothing.

`uniqueGeneratorCount` arrives last, so it is what gates the switch. NULL means "not measured" and
the trigger keeps mirroring; a row flips to its own score only with all three in hand, never on a
partial formula. The three are therefore written in **one** UPDATE.

### The fan-out trigger had never fired

`20261010120000` added `trg_model_metric_hot_score_fanout` as `AFTER UPDATE OF "hotScore"` to push the
whole-model score down to the base-model rows. `UPDATE OF` fires on the columns in the statement's
SET list, **not** on columns a BEFORE trigger subsequently changed — and nothing ever SETs
`hotScore`, because a BEFORE trigger computes it. It never ran.

It did not matter, because the pull side reads `ModelMetric."hotScore"` whenever a base-model row is
written and the metrics job writes those rows continuously. Dropped rather than repaired: once rows
compute their own score, a push from the whole-model score is exactly what must not happen.

### NULL is not zero

The first backfill pass left `uniqueGeneratorCount` NULL wherever ClickHouse returned no row — which
is what it does for a slice **nobody has generated with**. That is a known zero, not an unknown, and
NULL pinned those slices on the mirror for good.

It concentrated the bug exactly where it was visible. Measured slices get corrected *downward* to
their own engagement, so unmeasured ones float up:

| | Measured |
| --- | ---: |
| whole table | 79% |
| rows at the top of a filtered feed | **28%** |

Both writers now default to 0 for every slice their ClickHouse lookup covered, before the real counts
overwrite it. NULL survives only where the lookup never ran. 165,328 slices changed meaning.

### Backfill and verification (production, 2026-10-12)

`/api/admin/temp/backfill-base-model-hot-score`, 804,955 models in 27 resumable pages, 844,282 slices
seen, 244,583 rows written, no failed page. Throughput ~830 models/sec, so a 30,000-model page is a
~36s request — the endpoint is paged because the ingress cuts long ones, not because the work is slow.

| Check | Result |
| --- | ---: |
| slice rows measured | 815,818 of 820,075 (**99.5%**) |
| rows now diverging from the whole-model score | **211,708** |
| measured at the top of a filtered feed | 28% → **93.8%** |

The 4,279 still unmeasured are unmeasur*able* by this path and stay mirrored, correctly: 3,597 have
no published version for that slice at all, 681 have one with no `ModelVersionMetric` row to
aggregate, and 1 was published while the backfill was already past its id.

The moderator's four models, before → after: the two borrowing most of their engagement fell out of
the top 20 (to #54 and #374); the two whose every download was Anima held or rose (#11 → #19,
#8 → **#5**). Top-100 retention across nine feeds ran 51%–87%, so the lists still move.

One prediction here was wrong and worth recording. The expected new leader was the pure-Anima model
at #3; the actual leader was a model absent from the before-table entirely — published 2025, first
Anima version 2026-09-08, and the largest Anima slice in the feed by a factor of four. Under the
mirror its whole-model publish date buried it. That is the case the migration header argues for, and
predicting from the before-table alone missed it.

---

## 16. The generator floor (2026-10-12)

Migration `20261013120000`. §14's cap bounds one person at 100 like-equivalents, which was calibrated
against the whole-model feed. §15 then gave every filtered feed its own score, and a filtered feed is
a much smaller field. The cap was now being compared against the wrong bar.

### The bar, per feed

Engagement (`thumbsUp + downloads/6.4 + capped generation term`) actually needed to reach the top of
each filtered feed:

| Feed | top-10 median | to reach #10 |
| --- | ---: | ---: |
| Illustrious | 212 | 584 |
| Krea 2 | 298 | 450 |
| Qwen 2.1 | 223 | 249 |
| Anima | 174 | 248 |
| MiniMax H3 | 203 | 199 |
| SDXL 1.0 | 18 | **47** |
| Pony | 21 | **39** |
| NoobAI | 14 | **22** |
| Flux.1 D | 9 | **9** |

In the quiet ecosystems one generator's allowance is 2–11× the entire bar. The §14 check
(`uniqueGeneratorCount <= 1` with 500+ generations in a top 100) read **0** on the whole-model feed —
after the tail re-run described below — and **5** across the filtered ones — all in SDXL 1.0 and NoobAI, the thinnest feeds, every one of
them a single generator with 800–2,100 generations and 0–7 likes.

### Discount, not a gate

`generation term = least(generationCount / 4.1, greatest(uniqueGeneratorCount - 1, 0) * 100)`

The `greatest` is load-bearing, not defensive: without it a count of 0 gives -100 and the generation
term would *subtract* from engagement.

A gate ("ignore generations until N people have generated") has a cliff at N where one extra
generator is a step change. Discounting the first is monotonic and continuous, identical to a gate at
the `uniqueGeneratorCount = 1` case that matters, and re-tunes nothing — the constant is unchanged, so
a model whose generations are spread across real users is nowhere near its cap and does not move.

The cost is nearly zero because single-generator models are almost all tiny. Models with generations,
by distinct generators:

| `uniqueGeneratorCount` | Models | Median generations |
| --- | ---: | ---: |
| 0 | 1,461 | 4 |
| 1 | 58,803 | 6 |
| 2 | 45,929 | 16 |
| 3–4 | 67,761 | 34 |
| 5–9 | 99,868 | 89 |
| 10–49 | 187,649 | 422 |
| 50+ | 114,113 | 4,345 |

The 58,803 single-generator models lose a term worth ~1.5 like-equivalents at the median. What the
floor actually removes is the 1,614 of them running 410+ generations on one account.

### Simulated before applying

Whole-model top 100: **97 of 100 unchanged**. The three that leave have two generators each running
~400 generations with 7–11 likes, and fall to #180/#223/#267. The three that replace them have
85–122 likes and 1,174–2,837 downloads, and move up by 1–3 places.

The filtered feeds show the effect landing exactly where the problem was:

| Feed | top 100 kept | top 10 changed |
| --- | ---: | ---: |
| Anima | 100 | 0 |
| Qwen 2.1 | 100 | 0 |
| MiniMax H3 | 100 | 2 |
| Krea 2 | 99 | 0 |
| Illustrious | 95 | 0 |
| NoobAI | 94 | 8 |
| Flux.1 D | 93 | 4 |
| Pony | 83 | 6 |
| SDXL 1.0 | **80** | **10** |

The busy feeds barely move; the thin ones turn over. The new SDXL 1.0 top 10 is led by models with 9,
13, 23 and 29 distinct generators, and no single-generator model survives in it — so the slots were
refilled, not emptied.

### `uniqueGeneratorCount = 0` changes meaning

§14 made 0 deliberately inert, because 0 meant "not computed yet" while its backfill ran. That left
the signal uncapped for every model the backfill had not reached — including every model published
*after* it, since nothing maintained the column until the deploy. That is why the whole-model check
read 5 again before this work: all five were published after the 8 October backfill. A re-run of
`/api/admin/temp/backfill-unique-generators` over the recent tail (21,509 models, 1s) returned it
to 0.

The floor makes 0 earn 0, which closes that hole permanently — and makes the migration order
load-bearing in the other direction: **it must not be applied before both generator backfills have
run**, or it strips the generation term from every model whose count is not yet computed.

### Rollout

The migration itself needs no deploy: the formula exists only as two trigger functions, and the
constants appear nowhere in TypeScript. The code half is §15's writer change — covered slices default
to 0 rather than NULL — and that ships with the branch. Apply without `--single-transaction`: the file
CALLs a procedure that COMMITs per batch.

Replacing a function does not touch a stored score, so the file rescores. The predicate is exact
rather than conservative: only rows where the *new* cap binds can change, because where it does not
bind the term is `generationCount / 4.1` under both formulas. That is **103,882** of 960,714
`ModelMetric` rows and **81,219** of 904,604 `ModelBaseModelMetric` rows — a tenth of each table, not
a rewrite. A third pass refreshes the unmeasured slices still mirroring a score the first pass
superseded.

### Applied and verified (production, 2026-10-12)

Both trigger functions carry the floor, the rescore procedure dropped itself, and **0** rows in
either table still hold a score the old formula would have produced. The SDXL 1.0 top 10 came out
identical to the simulation above, model for model and in the same order; the single-generator model
that held rank 2 is now rank 30, and the slots it vacated went to models with 4–29 distinct
generators.

Two things the checks turned up that the plan did not predict:

**The verification query cannot read 0, and that is the query's fault.** One `ModelMetric` row came
back one unit off. Its `publishedAt` is in the future and its status is `Scheduled` — the formula
clamps a future date to `NOW()`, so the score moves with the clock, and a verification query that
recomputes the formula will always disagree with a score the trigger wrote minutes earlier. One
`hotScore` unit is ~259 seconds. Scheduled rows are also filtered out of the feed. Compare against a
tolerance, or exclude non-`Published` rows.

**The top-100 check flags legitimate rows now, as designed.** It reads 9 across all base models
rather than 0, and 8 of the 9 have `uniqueGeneratorCount = 0` with 163–1,228 likes and up to 20,867
downloads. They match the predicate because it tests `<= 1`, but their generation term is now zero, so
they are ranked purely on likes and downloads and there is nothing to fix. The ninth is the SDXL 1.0
sockpuppet at its new rank 30. This is why the migration footer says "0 or near it" rather than 0.

### What the 0-earns-nothing change costs

The ClickHouse coverage gap — models with a generation count but no row in the generator view — now
earns no generation credit at all, where before it was uncapped. Re-measured after the 2026-10-13
release and its backfills:

| | 2026-10-12 | 2026-10-13 | With 500+ generations |
| --- | ---: | ---: | ---: |
| `ModelMetric` rows, `uniqueGeneratorCount = 0` with generations | 1,472 | 1,768 | 77 → **141** |
| `ModelBaseModelMetric` slices, same | 1,275 | 1,352 | 85 → **95** |

The error runs toward under-crediting, which is the safe direction for a ranking signal, and the
affected rows keep their likes and downloads — one of them still leads its filtered feed on those
alone.

**It is not new models, and not the metrics job.** 1,761 of the 1,768 are models published more than
30 days ago, so it is not ingestion lag. Nor is the live job zeroing a count it cannot find:
`bulkInsertMetrics` writes `COALESCE(d."<key>", im."<key>", 0)`, so a model ClickHouse returns nothing
for keeps its stored value rather than falling to 0 (`src/server/metrics/model.metrics.ts:253`).

**What it actually is.** Checked against ClickHouse on 2026-10-13 for the five largest affected
models. They have exactly **one** row each in `orchestration.daily_resource_generation_counts`, and its
count matches Postgres exactly — 173,658, 129,848, 117,578, 33,528. But that row is dated **2120-07-26**
or **2079-06-07**: a legacy bulk import with a corrupt date, not daily telemetry. In
`daily_resource_generation_user_counts` they have **no rows at all**.

So the gap is exactly what it looked like: a real all-time generation total with no generator data
behind it. The models did earn those generations; nothing records how many different people produced
them, so the floor declines to credit them. The error still runs toward under-crediting.

🔴 **Query the database-qualified name.** `daily_resource_generation_counts` exists in both `default`
and `orchestration` with **different contents** — the `default` copy holds nothing before 2025-11-15,
so these models look absent from it. Fourteen of the sixteen readers in this repo use the
`orchestration.`-qualified name; the unqualified ones resolve to `default`. An unqualified check is how
an earlier draft of this section concluded the rows did not exist.

The count grows as each metrics run reaches more old models of that kind, not because coverage is
degrading: for models published in 2026, 143,112 have a generation count and 143,131 have a generator
count. §17 records what the two views do and do not contain.

## 17. Trending is a different signal (2026-10-13)

Not built. This section exists so the next person who asks "can Hot surface an old model that's
popping off?" finds the measurement and the shape of the answer instead of re-deriving both.

### What prompted it

A tester looking at the SDXL 1.0 feed couldn't find the LoRAs behind the current or past daily
challenges, and proposed that the age penalty should have a limit, since those models were published
in 2024.

They are not absent: the best World Morph SDXL slice sits at **rank 541** of that feed, about page 11.
All of them published July–September 2024.

### Capping the age term fails in both directions

| Clamp the age term at | Best World Morph | Of the old top 100, displaced | New top 100 older than the clamp |
| --- | ---: | ---: | ---: |
| 12 months | 541 → 533 | 0 | 0 |
| 6 months | 541 → **572** | 3 | 3 |
| 3 months | 541 → 424 | **100** | **100** |

A loose clamp does nothing, because it lifts *every* old model by the same amount: their order among
themselves is unchanged and they are all still behind the recent cohort. Six months makes this one
**worse**, because other old models gain more than it does. Three months replaces the entire top 100
with pre-clamp models and the challenge LoRA still only reaches 424.

The reason is engagement, not age. These are mid-tier for SDXL 1.0 — 163–442 likes, 801–2,445
downloads — against an ecosystem whose all-time winners hold tens of thousands. Weakening the age term
hands the feed to those winners, and the challenge LoRAs lose that comparison too. For the stated need
(finding the models behind a challenge) the fix is a curated surface — the challenge's own collection,
or a link from the challenge page — which works for every challenge including the 2023 ones.

### The real limitation underneath

Hot ranks a **stock**: lifetime engagement against a publish date that never moves. That is exactly
what makes the score time-invariant and lets it live in a trigger with no scheduled job (§8). It also
means no amount of present-day activity can lift a 2024 model, which is the gap §5 names.

A resurgence signal ranks a **flow** — what happened this week. That is a different formula, not a
constant to re-tune.

### What windowed data exists

Checked, because it bounds every design:

- `ModelMetric` and `ModelVersionMetric` are keyed by id alone — **all-time counts, no timeframe
  dimension**, unlike `UserMetric`, `PostMetric`, `TagMetric` and `CollectionMetric`. `ModelRank` has
  no period columns either.
- The nearest thing to a time series is ClickHouse `daily_resource_generation_counts` and
  `daily_resource_generation_user_counts` — generations only, and neither is reliably dated.

**Measured 2026-10-13, and it is worse than "generations only".** There are three copies of the
generation counts across two databases, and the generator view has lost its dates entirely:

| Table | Rows | Date range | Future-dated rows | Readers in this repo |
| --- | ---: | --- | ---: | ---: |
| `orchestration.daily_resource_generation_counts` | 36,368,452 | 1970-01-01 → **2120-07-26** | 24,968 | **14** |
| `default.daily_resource_generation_counts` | 12,249,501 | 2025-11-15 → 2036-02-07 | 86,897 | 2, unqualified |
| `default.daily_resource_generation_counts_all` | 41,055,168 | 1970-01-01 → 2036-02-07 | 86,897 | **0** |
| `default.daily_resource_generation_user_counts` | 4,992,125 | 1970-01-01, and 2023–2024-05-08 | — | 4 (hot score) |

Three copies of the generation counts, with different contents, and none of them safely dated: the
orchestration copy reaches to 2120, the `default` copy starts at 2025-11-15, and `_all` has no reader
in this repo at all. The generator view is worse — 989,051 of its versions carry `createdDate`
`1970-01-01` and its last real date is 2024-05-08. It is still being written: five versions from models published in the last five days all have rows,
each a single row stamped `1970-01-01`. It is an all-time count per version wearing a daily view's
name, and its 2023–2024 dated rows are legacy from when the date worked.

The cause is one line of DDL. `daily_resource_generation_counts_mv` selects `date AS createdDate`;
`daily_resource_generation_user_counts_mv` selects `date` and declares its own column as `date`, while
the target table's column is `createdDate`. Nothing fills it, so it takes the `Date` default. Same
source, same target shape — the alias is the only difference. A corrected MV belongs in
`src/server/clickhouse/migrations/` with the rest of the manually-applied ClickHouse DDL.

That kills the cheap version of this feature. Generation **counts** can be windowed, provided the
query picks a database deliberately and bounds the upper end (`createdDate <= today()`, as
`backfill-generation-counts.ts` already does) so a row dated 2120 cannot land in "the last 7 days".
Distinct **generators** cannot be windowed at all, at any granularity — and the section below argues the distinct-actor denominator
is a day-one requirement, not a follow-up. So a trending signal needs new pipeline work whichever
metric it ranks: either fix the generator view's date, or snapshot the all-time counters daily and diff
them (one row per model per day, ~8 days retention, plus a job). That is the bulk of the work, not the
formula.

### The formula shape, and its two traps

Raw velocity is not enough — the largest models have the most downloads every week, which rebuilds the
"the same few models are always at the top" complaint the whole proposal started from. What surfaces a
resurgence is **lift**: this week against the model's own baseline.

```
lift = recent_7d / (prior_28d / 4 + k)
```

A pure ratio is noise at the bottom: 3 downloads to 30 is 10× lift and means nothing. It needs an
absolute floor on the recent window or a smoothed prior, and choosing that constant is most of the
tuning.

It is also **easier to game than Hot**. A burst is cheaper to manufacture than a lifetime total, and
lift actively rewards small absolute numbers. The distinct-actor denominators are therefore day-one
requirements rather than follow-ups: the generator floor (§16) and the unique-posters floor in
[model-feed-unique-posters.md](model-feed-unique-posters.md) §5.

And it costs the property Hot was designed around. The window moves, so every score changes daily even
with no new engagement — that needs a cron. The recompute set is at least small: only models with
activity in the window, a few thousand a day rather than all 960k.

### A home block, not a sort

The recommendation, if this gets built: a bounded section on a page — a `HomeBlockType`, the same shape
as `FeaturedModelVersion` or `FeaturedCollections` — showing ~20 models, not a new entry in the
`ModelSort` dropdown.

- **No naming collision.** Every other sort option is a plain stock measure (`Highest Rated`,
  `Most Downloaded`, `Newest`, …). "Hot" and "Trending" would be the only near-synonyms in the list,
  and no label tells a user which one shows what is blowing up today. If it must be a sort, call it
  **Rising** — "hot" is a state, "rising" is a direction, and that is the actual difference.
- **No public-API surface.** `ModelSort` values are API contract and have to be documented and
  supported indefinitely; a section adds none.
- **No default-feed risk.** Hot is now the default. A flow signal needs a daily recompute, so a failed
  job should degrade a section on a page rather than the feed everyone lands on.
- **It matches the signal's own shape.** Lift is sharp at the top and meaningless at the bottom, so
  "the 20 models picking up right now" is what it is good for; ordering 425,979 rows by it is not.

Keep "Hot" named Hot either way: it is the Reddit meaning, it is accurate, and the testers have just
learned it.
