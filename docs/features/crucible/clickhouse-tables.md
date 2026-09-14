# Crucible ClickHouse Tables

ClickHouse schemas for Crucible vote tracking and analytics.

## 🔴 Column names must equal the payload keys

`Tracker.send()` POSTs the tracked object **verbatim** to `<CLICKHOUSE_TRACKER_URL>/track/<table>`.
Nothing in this repo maps JavaScript keys to column names. So a column whose name differs from its
payload key does not land — and ClickHouse drops unknown JSON keys rather than rejecting the row, so
the failure is a row of zeros with no error anywhere.

Table names are free (`views`, `modelEvents`, `knights_new_order_image_rating` all coexist). **Column
names are not**: they have to match the object `tracker.ts` sends, which is camelCase throughout.
`knights_new_order_image_rating` is the worked example — a snake_case table with camelCase columns
(`imageId`, `createdAt`, `userAgent`).

## Vote Tracking Table

### crucible_votes

Individual votes, for analytics, auditing, and potential replay.

```sql
CREATE TABLE crucible_votes
(
    `userId` UInt32,
    `crucibleId` UInt32,
    `winnerEntryId` UInt32,
    `loserEntryId` UInt32,
    `createdAt` DateTime DEFAULT now()
)
ENGINE = SharedMergeTree
PARTITION BY toYYYYMM(createdAt)
ORDER BY (crucibleId, createdAt)
TTL createdAt + toIntervalDay(90);
```

`SharedMergeTree` is what ClickHouse Cloud substitutes for `MergeTree` on this cluster; write either.

`ORDER BY (crucibleId, createdAt)` is the primary index, and covers the queries this table exists for:
filter by crucible, time-range within a crucible, aggregate per crucible.

### Buffer table

```sql
CREATE TABLE crucible_votes_buffer AS crucible_votes
ENGINE = Buffer('default', 'crucible_votes', 16, 10, 100, 10000, 1000000, 10000000, 100000000);
```

Nothing in this repo writes to the buffer by name — the tracker posts `crucible_votes` and the tracker
service decides. It exists for high-volume write smoothing; its columns must stay identical to the
destination's.

## Usage

### Tracking votes

`Tracker.crucibleVote()` in `src/server/clickhouse/tracker.ts`, called from `submitVote()`:

```typescript
tracker.crucibleVote({ crucibleId, winnerEntryId, loserEntryId });
```

It passes `skipActorMeta: true`, which stamps `userId` and drops `ip`/`userAgent`. A vote is a
gameplay event, not an attribution surface, so the narrower actor meta is the intent — the table has
no `ip` or `userAgent` column to receive them.

`src/server/clickhouse/__tests__/tracker.crucibleVote.test.ts` pins the wire payload against the column
list above, written there as literals. ⚠️ It asserts what the **app sends**; it cannot reach ClickHouse,
so it catches a drifting payload but not a drifting DDL. The DDL side is this document.

### Querying vote data

```typescript
import { clickhouse } from '~/server/clickhouse/client';

const result = await clickhouse.$query`
  SELECT crucibleId, count() as totalVotes, uniq(userId) as uniqueVoters
  FROM crucible_votes
  WHERE crucibleId = ${crucibleId}
  GROUP BY crucibleId
`;

const userVotes = await clickhouse.$query`
  SELECT winnerEntryId, loserEntryId, createdAt
  FROM crucible_votes
  WHERE crucibleId = ${crucibleId} AND userId = ${userId}
  ORDER BY createdAt DESC
  LIMIT 100
`;
```

### Analytics queries

```typescript
const dailyStats = await clickhouse.$query`
  SELECT toDate(createdAt) as date, count() as votes, uniq(userId) as voters
  FROM crucible_votes
  WHERE crucibleId = ${crucibleId}
  GROUP BY date
  ORDER BY date
`;

const topEntries = await clickhouse.$query`
  SELECT entryId, count() as appearances
  FROM (
    SELECT winnerEntryId as entryId FROM crucible_votes WHERE crucibleId = ${crucibleId}
    UNION ALL
    SELECT loserEntryId as entryId FROM crucible_votes WHERE crucibleId = ${crucibleId}
  )
  GROUP BY entryId
  ORDER BY appearances DESC
  LIMIT 10
`;
```

## Data retention

- Votes are retained 90 days (the TTL above)
- Final results live in PostgreSQL: `CrucibleEntry.score` and `CrucibleEntry.position`
- The Redis ELO cache is cleared when a crucible ends

## Related files

| File | Purpose |
|------|---------|
| `src/server/clickhouse/tracker.ts` | `Tracker.crucibleVote()` |
| `src/server/clickhouse/__tests__/tracker.crucibleVote.test.ts` | Pins the wire payload to the columns |
| `src/server/services/crucible.service.ts` | `submitVote()` calls the tracker |
| `src/server/redis/crucible-elo.redis.ts` | Real-time ELO cache |
