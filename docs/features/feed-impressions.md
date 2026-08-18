# Feed impressions

Views only count entities that were **opened**. Most people never open anything —
they scroll. So every view number on the site measures clicks, not reach, and
undercounts by an unknown multiple. Feed impressions measure the other half.

## What counts as an impression

> A card was **at least 50% visible** in the viewport for a **continuous 1
> second**, counted **at most once per entity per browsing session**.

All three clauses are load-bearing, and the number is meaningless without them:

- **50% visible** — a sliver clipped at the edge of the viewport is not an
  impression.
- **continuous 1 second** — a flick scroll past a card is not an impression. Time
  spent in a hidden tab does not count either: the dwell timer is dropped when the
  tab is backgrounded and re-armed on return, so a second of dwell is a second of
  visible time rather than a second of elapsed time.
- **once per entity per session** — scrolling back up over a feed adds nothing. A
  session is a browser tab, identified by a random token minted per tab that is
  never persisted and is not tied to a user.

Label it **"impressions"**, never "views", and never add the two together. They
measure different things by different methods, and summed they explain neither.

## What gets recorded

Impressions are entity-generic, not image-specific. Every feed card funnels
through one of two shells — `AspectRatioImageCard` and `FeedCard` — and the
observer lives there, so images, models, posts, articles, collections, bounties
and bounty entries are all covered by the same code path on every surface that
renders a card (including the homepage).

**A card can present more than one entity.** A model card shows a model *and*
whichever cover image the viewer's browsing level selected — two different
viewers can see two different images on the same card. Both are recorded, because
the image's creator earned that impression even though the card is about the
model.

## Pipeline

```
card 50% visible for 1s
  -> impressionBuffer   (client: session dedupe + array batching, 90s flush)
  -> /api/track/batch   (existing beacon, new `impression` arm)
  -> Tracker.impressions -> ONE batched insert
  -> default.impressions            (raw, 30-day TTL)
     -> daily_impressions           (incremental MV, per entity per day)
     -> impressions_daily_by_owner  (daily refreshable MV, per creator per type)
```

Nothing here touches `views`, `daily_views`, `uniqueViewsDaily` or
`image_views_daily_by_owner`. Impressions outnumber views by roughly an order of
magnitude, so writing them into `views` would silently redefine every existing
view number on the platform overnight, with no migration and nothing to compare
against.

### Why the batching shape is what it is

Two reductions are stacked, and the feature is not viable without both:

1. **Set semantics on the client.** An entity seen twice in a session is recorded
   once.
2. **One event carrying many entities.** A flush of 250 entities is one
   `/api/track/batch` event, not 250. Request rate is therefore *independent of
   scroll speed* — a flush describes a set, not a stream.

`Tracker.impressions` uses `trackMany`, not `track`. `track` posts one HTTP
request per row to the tracker service — correct for a view, ruinous here, since
a 250-entity flush would become 250 outbound requests and the client-side
batching would buy nothing.

Part count rather than row volume is the binding constraint for a table many pods
insert into on a short interval, and it is already handled: the shared client sets
`async_insert` on **every** insert it makes
(`packages/civitai-clickhouse/src/client.ts`). Nothing here needs to opt in, and an
earlier version of this change that plumbed per-insert settings through
`sendMany`/`trackMany` to set it was removed — it was a no-op dressed as a
safeguard.

### One flush is not always one insert

The claim above is the common case, not an invariant. It is one insert per
**surface** per flush, because an event carries a single surface and a tab can move
between feeds within an interval; a surface holding more than 250 entities splits
further. The early-flush size cap counts entities across *all* surfaces while
chunking is per-surface, so a flush spread thinly over several surfaces produces
several small inserts. All of these are bounded and none change the row count, but
"one flush, one insert" should not be read as a guarantee when reasoning about part
counts.

## Sizing

⚠️ **An earlier version of this section was wrong by roughly 5x, and the way it was
wrong is worth keeping.** It sized the feature on *index feeds* — `/images`,
`/videos`, `/`, `/search` — at 1.48M page-views/day. But `getImpressionSurface`
maps on the **first path segment**, so `/models/123` is the `models` surface, and a
model detail page renders a gallery and a related-models row: cards, through the
same shells, emitting impressions. The instrumented set is every page that renders
a card, which is 5.6x larger than the set that was measured. Sizing a feature by
the pages you were *thinking about* rather than the pages the code *touches* is the
mistake to avoid repeating.

Measured against production, 2026-08-17, by first path segment:

| Surface | page-views/day | mean dwell (capped 30m) |
| --- | --- | --- |
| `models` | 3,203,666 | 203.6s |
| `images` | 2,772,763 | 117.9s |
| `user` | 987,828 | 61.8s |
| `search` | 488,452 | 88.4s |
| `home` (`/`) | 305,995 | 52.1s |
| `posts` | 219,838 | 117.3s |
| `videos` | 173,922 | 72.1s |
| `collections` | 78,827 | 56.5s |
| `articles` | 32,043 | 166.7s |
| `bounties` | 10,101 | 68.6s |
| **tracked total** | **~8.27M/day** | |

Supporting constants, both measured rather than assumed:

| Quantity | Value | Source |
| --- | --- | --- |
| Image detail views (for scale) | 2.7–2.9M/day (~31/s) | `views`, 7-day window |
| Raw bytes/row, `views` shape | 15.99 B | `views`: 226.81 GiB / 15.23B rows, identical sorting key |
| — of which `ip` | 4.74 B | per-column measurement on `views` |
| — of which `userAgent` | 3.92 B | per-column measurement on `views` |
| **Raw bytes/row, this table** | **~7.3 B** | the above minus the two columns it does not store |
| Rollup bytes/row | **2.29 B** | `daily_views`: 7.19 GiB / 3.37B rows |

**This table stores no `ip` and no `userAgent`**, via `skipActorMeta`. Those two
columns are **54% of the stored bytes** on `views`, and an impression has no use
for either — so the row is roughly half the size it would otherwise be, which
matters more here than anywhere else on the platform precisely because this table
takes ~10x the `views` insert rate. It also means impressions carry no IP at all:
per-viewer forensics on this data would need a deliberate decision to start
collecting it, not a discovery that it was already there.

### The numbers

**Requests: ~148/s added**, from concurrency ÷ the 90s interval. Concurrency is
Σ(page-views × dwell) / 86,400 ≈ **13,290** simultaneous sessions.

Two things make that an over-estimate rather than an under-estimate, and they are
why the capped means above are the right input:

- **An idle tab costs nothing.** The flush timer is armed only by *recording* an
  impression, and `flushImpressions` returns early with no request when nothing is
  pending. A session parked on a page with no scrolling emits no requests at all,
  so the long tail of `duration` — abandoned tabs — contributes concurrency but
  not traffic.
- Impressions ride along with any flush a search or click already triggered.

Using **uncapped** dwell means instead gives ~970/s. That figure is the honest
pessimistic bound and is what the same arithmetic produces without the 30-minute
cap; it treats abandoned tabs as if they scrolled, which the point above says they
do not. Real load should land nearer 148 than 970, and the first week's measurement
settles it.

**Rows: ~320M/day.** Index feeds are the 50–150 distinct entities per session
assumed before (~1.48M sessions); detail pages show far fewer cards, ~20–30
(~6.8M sessions). That is **~10x the `views` insert rate**, not 5x.

**Storage: ~2.3 GiB/day raw**, so the 30-day TTL settles at **~70 GiB**. (It would
be ~5.1 GiB/day and ~154 GiB if the table stored `ip` and `userAgent` like `views`
does.) `ttl_only_drop_parts = 1` makes expiry a metadata drop of whole parts rather
than a continuous rewrite of surviving rows.

### Is 320M rows/day a problem for ClickHouse?

No — and it is worth being explicit, because the number looks alarming next to the
row counts elsewhere in this repo. It is ~3,700 rows/s sustained, which is an
ordinary ingest rate for ClickHouse rather than a demanding one; the engine is
built for exactly this shape (append-only, immutable, aggregated by MV). The
constraints that actually bite are part count and storage growth, and both are
addressed: `async_insert` at the client for the first, TTLs on both tables for the
second.

What made the original number worth challenging was not that ClickHouse would
struggle, but that **~154 GiB was being spent on two columns nobody was going to
query**. That is the general lesson for a table at this rate: the row *count* is
cheap, the row *width* is what costs, and the review that matters is which columns
earn their place.

**The rollup is not negligible, and it is the only permanent storage.**
`daily_impressions` is one row per (entity, type, day) — on the order of 30–80M
rows/day at 2.29 B/row, so ~0.07–0.18 GiB/day, **kept forever**. For comparison
`daily_views` has accumulated 3.37B rows / 7.19 GiB across the site's entire
history; this passes that within months.

That retention is a deliberate decision (Justin, 2026-08-17), not an oversight. A
bounded TTL here was drafted and rejected: this table is what an "all-time
impressions" figure reads, so any horizon means a creator's lifetime count starts
silently truncating on a date nobody remembers setting. ~0.1 GiB/day buys the
absence of that failure, and it matches how `daily_views` already behaves.

The raw table is the one with a horizon, and only because it is a means to the
rollups rather than a record in its own right.

### The dial, and when to reach for it

The 90s flush interval sets the steady-state rate and nothing else does — but see
the tab-switch caveat in `impressionBuffer.ts`: a tab switch flushes too, so the
interval does not bound requests for a user who alt-tabs repeatedly. That path is
bounded instead by the empty-buffer early return.

If measured insert rate or part count runs well above the estimate: lengthen the
interval, or drop the Flipt cohort. **Do not reach for sampling first** — it
degrades exactly the creators with the smallest numbers, who are the ones Creator
Studio exists to serve.

## Rollout

Ships dark behind the `feedImpressions` feature flag (Flipt key
`feed-impressions`, created at 0%). Off means the browser never observes at all,
rather than dropping rows server-side, so the kill switch removes the client cost
too. Ramp by raising the threshold percentage; roll back by setting it to 0.

🔴 **Do not verify a write by reading it back.** The shared ClickHouse client runs
`async_insert: 1, wait_for_async_insert: 0`, so `insert()` resolves once the row is
**buffered**, not once it is queryable — and server-side insert errors never reach
the caller, they go to Axiom. Two consequences that bite exactly during a rollout:

- A `SELECT count()` shortly after enabling the flag can legitimately return **0**
  for traffic that wrote successfully. Give it time, or set
  `wait_for_async_insert` on that specific call.
- **"No errors" is not evidence that writes are arriving.** If impressions stop,
  the absence of exceptions says nothing. That is the strongest argument for
  alerting on the rollup refresh rather than trusting silence.

(Found by @scarlet on a backfill whose post-write check would have reported zero
for a run that had written everything; relayed by @fredrick.)

### Pre-ramp check that is NOT done

Virtualised feed rows set `content-visibility: auto`, and the impression observer
targets a card *inside* that subtree. Reasoning says this is fine — by the time a
row is in the viewport the browser has already rendered it — but "skipped content
reports a zero-size intersection rect" is real browser behaviour, and the failure
mode here is **silent zero impressions on the main image feed**, not an error.
Nothing in the test suite covers it: the suites are node-env with a hand-rolled
fake DOM. Verify in a real browser at a small percentage before ramping wide.

## Reading the number

The transport is **at-least-once**: a flush that fails ambiguously is re-queued,
so the raw table can contain a redelivered batch. `sessionKey` is on every row
specifically so this is measurable rather than assumed:

```sql
-- Exact, dedupe-safe: what the fast rollup would say if nothing was redelivered.
-- 🔴 This is a FULL PARTITION SCAN. The raw table is ordered (time, entityType,
-- entityId, userId), so none of these predicates prune — at ~320M rows/day a
-- month's partition is ~10B rows. Always add a tight `time` range, which is the
-- only predicate that touches the primary key, and run it over a SAMPLE of ids
-- rather than per-image on demand.
SELECT uniqExact(sessionKey)
FROM default.impressions
WHERE time >= ? AND time < ?           -- the pruning predicate; do not omit
  AND entityType = 'Image' AND entityId = ? AND createdDate = ?;

-- Fast (6ms class, primary-key pruned): what Creator Studio reads.
SELECT sum(impressions)
FROM default.daily_impressions
WHERE entityType = 'Image' AND entityId = ? AND createdDate = ?;
```

The gap between the two IS the duplicate rate. Run it after the first week and
state the error bar rather than presenting the rollup as exact — as a scheduled
job over a fixed sample, not as an on-demand query, for the scan reason above.

### The number is not adversary-resistant

`/api/track/batch` authenticates nothing. Its guard is `Origin`/`Referer` matching
`Host`, which is a same-origin check for browsers and trivially forged by anything
that is not one. That was proportionate when the route carried searches and clicks;
impressions are a **per-creator metric**, so the calculus changes: a script can post
250 fabricated entity ids per request against any creator's content, and
`sessionKey` is client-chosen, so the `uniqExact` audit above is spoofable in the
same breath.

This is acceptable for a reach statistic shown to its own creator. It is **not**
acceptable as an input to payouts, ranking, or anything competitive, and it should
not become one without rate limiting and an authenticated path first. Written down
here because the gap is invisible at the call site.

Per-creator totals must use `impressions_daily_by_owner`, never a
`entityId IN (...)` over the per-entity rollup: a creator's ids are scattered
across the whole id space, so the primary key prunes nothing and the query reads
the table.

## The repair window is 30 days, and that is not true of the views pipeline

`image_views_daily_by_owner` can be rebuilt from `daily_views` at any point back
to 2023, because nothing upstream of it expires. **This pipeline cannot.** The raw
table's 30-day TTL is what makes 150M rows/day affordable, and it is also a
deadline: a nightly refresh that fails and is not noticed within 30 days leaves a
permanent hole in `impressions_daily_by_owner`, with nothing left to rebuild it
from.

So two things that would be merely tidy on the views pipeline are load-bearing
here:

- **Alert on the refresh, don't rely on someone noticing.** `system.view_refreshes`
  carries `last_refresh_result` and `exception` per view. A failed or missed
  refresh needs to page inside the window, not be discovered after it. The alert
  is @fredrick's, written once over every row of that table rather than per view —
  there are seven refreshable MVs in prod and none are currently alerted on, and
  seven per-table alerts is how six get written and one does not. On the others a
  failed refresh is a gap that re-derives; here it is a countdown.
- **Re-run the duplicate audit on a schedule, not once.** It is only answerable
  inside the TTL, so a week-one measurement stops being evidence the moment the
  client's flush or dedupe behaviour changes.

(Raised by @fredrick, who owns the equivalent on the views side and had the
comparison to hand.)

## ClickHouse DDL

**Not applied automatically.** As with Postgres migrations in this repo, someone
applies this by hand, per environment. `containers/clickhouse/docker-init/init.sh`
carries the same DDL for local dev.

```sql
CREATE TABLE default.impressions
(
    `time`        DateTime DEFAULT now(),
    `userId`      Int32 DEFAULT 0,
    `entityType`  LowCardinality(String),
    `entityId`    Int32,
    `sessionKey`  String DEFAULT '',
    `surface`     LowCardinality(String) DEFAULT 'other',
    `createdDate` Date MATERIALIZED toDate(time)
)
ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(createdDate)
ORDER BY (time, entityType, entityId, userId)
TTL createdDate + INTERVAL 30 DAY
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1;

CREATE TABLE default.daily_impressions
(
    `entityType`  LowCardinality(String),
    `entityId`    Int32,
    `createdDate` Date,
    `impressions` UInt64
)
ENGINE = SharedSummingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(createdDate)
ORDER BY (entityType, entityId, createdDate)
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW default.daily_impressions_mv
TO default.daily_impressions
(
    `entityType`  LowCardinality(String),
    `entityId`    Int32,
    `createdDate` Date,
    `impressions` UInt64
)
AS SELECT entityType, entityId, createdDate, count(*) AS impressions
FROM default.impressions
GROUP BY 1, 2, 3;

CREATE TABLE default.impressions_daily_by_owner
(
    `ownerId`     Int32,
    `entityType`  LowCardinality(String),
    `createdDate` Date,
    `impressions` UInt64
)
ENGINE = SharedSummingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(createdDate)
ORDER BY (ownerId, entityType, createdDate)
SETTINGS index_granularity = 8192;

-- Refresh offset is 04:00, deliberately not the 02:00 used by
-- image_views_daily_by_owner_mv, so the two do not scan images_created at once.
-- The join is restricted to the ids present in the window and dedupes
-- images_created (a ReplacingMergeTree with unmerged duplicate ids): the
-- unrestricted form builds a 130M-row hash table for identical output.
CREATE MATERIALIZED VIEW default.impressions_daily_by_owner_mv
REFRESH EVERY 1 DAY OFFSET 4 HOUR APPEND
TO default.impressions_daily_by_owner
(
    `ownerId`     Int32,
    `entityType`  LowCardinality(String),
    `createdDate` Date,
    `impressions` UInt64
)
AS WITH dimg AS (
    SELECT entityId, createdDate, sum(impressions) AS impressions
    FROM default.daily_impressions
    WHERE entityType = 'Image' AND createdDate >= today() - 1 AND createdDate < today()
    GROUP BY entityId, createdDate
), dmodel AS (
    SELECT entityId, createdDate, sum(impressions) AS impressions
    FROM default.daily_impressions
    WHERE entityType = 'Model' AND createdDate >= today() - 1 AND createdDate < today()
    GROUP BY entityId, createdDate
)
SELECT ownerId, entityType, createdDate, sum(impressions) AS impressions
FROM (
    SELECT ic.userId AS ownerId, 'Image' AS entityType, dimg.createdDate AS createdDate, dimg.impressions AS impressions
    FROM dimg
    INNER JOIN (
        SELECT id, any(userId) AS userId
        FROM default.images_created
        WHERE id IN (SELECT entityId FROM dimg)
        GROUP BY id
    ) AS ic ON dimg.entityId = ic.id

    UNION ALL

    -- Creator-first, NOT argMax: a Transfer row carries userId = 0, and 1.7% of
    -- models have a later non-zero actor who is a moderator rather than the owner.
    -- See "Model ownership: how to aggregate" above for the measurements.
    SELECT mc.ownerId AS ownerId, 'Model' AS entityType, dmodel.createdDate AS createdDate, dmodel.impressions AS impressions
    FROM dmodel
    INNER JOIN (
        SELECT modelId,
               argMinIf(userId, time, type = 'Create' AND userId != 0) AS createUser,
               argMaxIf(userId, time, userId != 0)                     AS fallbackUser,
               if(createUser != 0, createUser, fallbackUser)           AS ownerId
        FROM default.modelEvents
        WHERE modelId IN (SELECT entityId FROM dmodel)
        GROUP BY modelId
        HAVING ownerId != 0
    ) AS mc ON dmodel.entityId = mc.modelId
)
GROUP BY ownerId, entityType, createdDate;
```

### Why the owner rollup is keyed by entity type but only populated for images

`entityType` is in the key from the start because a creator's images, videos,
models and articles are different numbers that will be read as separate lines —
merging them produces a figure nobody can act on, and splitting it later means a
second migration once the table has data. `ownerId` alone remains a valid key
prefix if a merged total is ever wanted.

`Image` and `Model` are populated. The other entity types are not, and the
distinction is about ownership sources, not about tracking: **every** type in
`IMPRESSION_ENTITY_TYPES` gets rows in `impressions` and `daily_impressions`. Only
attribution to a creator is limited.

Two ClickHouse-side ownership sources exist:

- **Images** — `images_created`. A `ReplacingMergeTree` with unmerged duplicate
  ids, so `GROUP BY id` first; no id has conflicting owners, so `any(userId)` is
  safe there.
- **Models** — `default.modelEvents`. It is the `models_created` equivalent, it
  just isn't named like one: 6.4M rows, **2,761,871 distinct models / 420,576
  owners, back to 2023-04-27**. (@fredrick found this; `user_model_posts` is
  existing precedent for treating the sibling `modelVersionEvents` as ownership.)

For everything else, resolve ownership from Postgres at read time —
`Article.userId`, `ComicProject.userId` — which is not a workaround but the better
option for small id sets: ~70ms, and a literal `IN` keeps the primary key usable
(articles measured 35ms at the platform's worst case). What Postgres cannot do is
serve *this* MV, which needs an owner for every entity seen that day rather than
for one creator's ids.

**`Post` is the exception, and is the next arm someone will want.** Read-time id
resolution works because creators hold few entities; posts are median 2 but **p99
868, max 256,608** (@fredrick's measurement), so that tail behaves like images, not
like articles. `default.posts` already carries `userId` and is shaped like
`modelEvents` — 29.5M distinct posts, 135,498 with no `Create` row carrying a
userId, and 10,537 (0.04%) where the latest non-zero actor disagrees with the
creator. So the same **creator-first, latest-non-zero fallback** aggregate applies;
do not reach for `any()` or a bare `argMax` there either.

### Model ownership: how to aggregate, and why not the obvious way

🔴 **`any(userId)` is wrong for models, and so is a plain `argMax(userId, time)`.**
Both look right. Measured against production:

| | |
| --- | --- |
| `Transfer` events, all time | **42** — and **all 42 carry `userId = 0`** |
| Models sent to owner `0` by plain `argMax(userId, time)` | 8 |
| Models where latest-non-zero disagrees with the creator | **47,089 (1.7%)** |
| Models with no `Create` event carrying a userId | 33,514 |
| Models with no non-zero userId anywhere | 6 |

Read those together. A `Transfer` row records that a transfer happened and
**not who it went to** — the column is zero — so a latest-event aggregate does not
follow ownership across a transfer, it loses the owner entirely. And the 1.7%
disagreement is over a thousand times larger than the 42 transfers, so it is
overwhelmingly moderators and other actors appearing on `Update` / `Archive` /
`Takedown` rows, not owners changing. Taking the latest actor would silently
attribute 47,089 models to whoever last touched them.

So the aggregate is **creator-first, latest-non-zero as fallback**:

```sql
argMinIf(userId, time, type = 'Create' AND userId != 0) AS createUser,
argMaxIf(userId, time, userId != 0)                     AS fallbackUser,
if(createUser != 0, createUser, fallbackUser)           AS ownerId
-- HAVING ownerId != 0
```

The fallback covers the 33,514 models with no usable `Create` row; 6 models remain
unattributable and are dropped.

**Consequence to state plainly: a transferred model's impressions stay with the
original creator**, because ClickHouse holds no record of who received it. That is
a product decision made by the data, not by preference — if transferred models
should re-attribute, it needs `Transfer` to start recording the recipient, which is
a change in the writer, not here.

### What actually emits an impression

`IMPRESSION_ENTITY_TYPES` is the set the schema *accepts*; it is not the set that
occurs. On day one the emitters are:

| Entity type | Emitted by |
| --- | --- |
| `Image` | every `AspectRatioImageCard` (automatic — it is the image the card renders), plus `GenericImageCard` |
| `Model` | `ModelCard`, `Model3DCard` |
| `Post` | `PostCard` |
| `Article` | `ArticleCard` |
| `Collection` | `CollectionCard` |
| `Bounty` | `BountyCard` |
| `BountyEntry` | `BountyEntryCard` |

`User` and `ModelVersion` are in the enum but **nothing emits them** — there is no
profile card in the feed shells today. Expect zero rows, not sparse rows. They stay
in the enum because adding a value to a ClickHouse `Enum8` later is a metadata
change to a 30-day table plus two rollups, and leaving room costs nothing.

(If a profile card is ever added, `User` is the one entity where owner and entity
are the same id, so it is attributable for free — no join, no ownership source.)

### Types tracked but not attributable

For `Post`, `Article`, `Collection`, `Bounty` and `BountyEntry`, per-entity
impressions exist in `daily_impressions` and can be read directly; only the owner
rollup has no arm. A creator-level number for those is **absent, not zero**, and
consumers must render it as unknown — the Studio already carries a live example of
what the other choice looks like a year later (`getAllTimeTotals` reads a dead
backfill whose max userId is 9.66M against current ids past 12.5M, and has been
silently returning 0 comments for every newer creator).
