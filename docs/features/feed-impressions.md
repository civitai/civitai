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
