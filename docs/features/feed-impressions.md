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
   `/api/track/batch` event, not 250. Request rate is therefore set by the flush
   interval and the number of open feed tabs, and is *independent of scroll
   speed*.

`Tracker.impressions` uses `trackMany`, not `track`. `track` posts one HTTP
request per row to the tracker service — correct for a view, ruinous here, since
a 250-entity flush would become 250 outbound requests and the client-side
batching would buy nothing.

The insert is issued with `async_insert`. Every web pod flushes independently, so
the binding constraint is part count, not row count: without server-side
buffering the table hits the too-many-parts ceiling long before it hits a volume
problem.

## Sizing

Measured against production, 2026-08-16:

| Quantity | Value | Source |
| --- | --- | --- |
| Image detail views | 2.7–2.9M/day (~31/s) | `views`, 7-day window |
| Feed page-views | ~1.48M/day (~17/s) | `pageViews`, feed-rendering paths, 2-day window |
| Mean dwell on a feed page | ~400s | `pageViews.duration` |
| Compressed bytes/row | ~15 B | `views`: 113 GiB / 7.6B rows |

Assumption, and the number to check first if the estimate is wrong: **50–150
distinct entities per session** (model cards contribute two). That gives:

- **74M–220M rows/day**, central estimate ~150M/day.
- **~1.1–3.3 GiB/day** in the raw table; the 30-day TTL bounds it at roughly
  33–100 GiB total. The daily rollups are one row per entity per day and are
  negligible by comparison.
- **~76 added requests/s** to `/api/track/batch`: concurrent feed sessions
  (~17/s x 400s ≈ 6,800) divided by the 90s flush interval. This is the same order
  as `addView` before it moved off tRPC, but it lands on the beacon route, which
  pays none of the middleware cost that made `addView` expensive.

The flush interval is the dial. If the measured insert rate or part count runs
well above this estimate, lengthen it or drop the Flipt cohort — do not reach for
sampling first, because sampling degrades exactly the creators with the smallest
numbers, who are the ones the Creator Studio surface is for.

## Rollout

Ships dark behind the `feedImpressions` feature flag (Flipt key
`feed-impressions`). Off means the browser never observes at all, rather than
dropping rows server-side, so the kill switch removes the client cost too.

## Reading the number

The transport is **at-least-once**: a flush that fails ambiguously is re-queued,
so the raw table can contain a redelivered batch. `sessionKey` is on every row
specifically so this is measurable rather than assumed:

```sql
-- Exact, dedupe-safe: what the fast rollup would say if nothing was redelivered.
SELECT uniqExact(sessionKey)
FROM default.impressions
WHERE entityType = 'Image' AND entityId = ? AND createdDate = ?;

-- Fast (6ms class, primary-key pruned): what Creator Studio reads.
SELECT sum(impressions)
FROM default.daily_impressions
WHERE entityType = 'Image' AND entityId = ? AND createdDate = ?;
```

The gap between the two IS the duplicate rate. Run it after the first week and
state the error bar rather than presenting the rollup as exact.

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
    `entityType`  Enum8('User' = 1, 'Image' = 2, 'Post' = 3, 'Model' = 4, 'ModelVersion' = 5, 'Article' = 6, 'Collection' = 7, 'Bounty' = 8, 'BountyEntry' = 9),
    `entityId`    Int32,
    `sessionKey`  String DEFAULT '',
    `surface`     LowCardinality(String) DEFAULT 'other',
    `ip`          String DEFAULT '',
    `userAgent`   String DEFAULT '',
    `createdDate` Date MATERIALIZED toDate(time)
)
ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(createdDate)
ORDER BY (time, entityType, entityId, userId)
TTL createdDate + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;

CREATE TABLE default.daily_impressions
(
    `entityType`  Enum8('User' = 1, 'Image' = 2, 'Post' = 3, 'Model' = 4, 'ModelVersion' = 5, 'Article' = 6, 'Collection' = 7, 'Bounty' = 8, 'BountyEntry' = 9),
    `entityId`    UInt32,
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
    `entityType`  Enum8('User' = 1, 'Image' = 2, 'Post' = 3, 'Model' = 4, 'ModelVersion' = 5, 'Article' = 6, 'Collection' = 7, 'Bounty' = 8, 'BountyEntry' = 9),
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
    `entityType`  Enum8('User' = 1, 'Image' = 2, 'Post' = 3, 'Model' = 4, 'ModelVersion' = 5, 'Article' = 6, 'Collection' = 7, 'Bounty' = 8, 'BountyEntry' = 9),
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
    `entityType`  Enum8('User' = 1, 'Image' = 2, 'Post' = 3, 'Model' = 4, 'ModelVersion' = 5, 'Article' = 6, 'Collection' = 7, 'Bounty' = 8, 'BountyEntry' = 9),
    `createdDate` Date,
    `impressions` UInt64
)
AS WITH di AS (
    SELECT entityId, createdDate, sum(impressions) AS impressions
    FROM default.daily_impressions
    WHERE entityType = 'Image'
      AND createdDate >= today() - 1
      AND createdDate < today()
    GROUP BY entityId, createdDate
)
SELECT ic.userId AS ownerId, 'Image' AS entityType, di.createdDate AS createdDate, sum(di.impressions) AS impressions
FROM di
INNER JOIN (
    SELECT id, any(userId) AS userId
    FROM default.images_created
    WHERE id IN (SELECT entityId FROM di)
    GROUP BY id
) AS ic ON di.entityId = ic.id
GROUP BY ownerId, createdDate;
```

### Why the owner rollup is keyed by entity type but only populated for images

`entityType` is in the key from the start because a creator's images, videos,
models and articles are different numbers that will be read as separate lines —
merging them produces a figure nobody can act on, and splitting it later means a
second migration once the table has data. `ownerId` alone remains a valid key
prefix if a merged total is ever wanted.

Only the `Image` arm is populated today, because **`images_created` is the only
per-entity ownership table in ClickHouse**. There is no `models_created`,
`articles_created` or equivalent.

This is a platform-wide gap rather than something local to impressions — three
separate pieces of work hit it the same night from different directions
(@fredrick's owner-keyed view counts, comic view tracking, and this). The
conclusion, so the next person finds it instead of re-deriving it:

- **Small id sets don't need a ClickHouse table.** Ownership resolves fine from
  Postgres — `Article.userId`, `ComicProject.userId` — in ~70ms, and a literal
  `IN` keeps the primary key usable (articles measured 35ms at the platform's
  worst case). Prefer that at read time.
- **The real gap is models specifically**, where the id set is large enough that
  read-time resolution stops working. 2.13B model views are unsurfaced in Creator
  Studio for exactly this reason.
- **Neither helps a nightly rollup.** This MV needs an owner for *every* entity
  seen that day, not for one creator's ids, so a Postgres round trip is not an
  option inside the refresh whatever the entity type. A rollup arm for models
  needs a ClickHouse-side ownership source; that is the piece nobody has built.

Adding an arm later is a `UNION ALL` in this MV plus whatever source resolves
that type's owner; nothing about the table shape has to change.

Until then, a non-Image number here is **absent, not zero**. Consumers must
render it as unknown rather than as `0` — the Studio already carries a live
example of what the other choice looks like a year later (`getAllTimeTotals`
reads a dead backfill whose max userId is 9.66M against current ids past 12.5M,
and has been silently returning 0 comments for every newer creator).
