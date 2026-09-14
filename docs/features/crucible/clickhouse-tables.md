# Crucible ClickHouse Tables

This document defines the ClickHouse table schemas for Crucible vote tracking and analytics.

## Vote Tracking Table

### crucible_votes

Stores individual votes for analytics, auditing, and potential replay.

```sql
CREATE TABLE crucible_votes (
  crucible_id UInt32,
  winner_entry_id UInt32,
  loser_entry_id UInt32,
  user_id UInt32,
  created_at DateTime DEFAULT now()
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (crucible_id, created_at)
TTL created_at + INTERVAL 90 DAY;
```

### Indexes

The `ORDER BY (crucible_id, created_at)` clause creates a primary index that efficiently supports:
- Queries filtering by `crucible_id`
- Time-range queries within a crucible
- Aggregate queries per crucible

### Buffer Table (Optional)

For high-volume write scenarios, use a buffer table:

```sql
CREATE TABLE crucible_votes_buffer AS crucible_votes
ENGINE = Buffer(
  default,           -- database
  crucible_votes,    -- destination table
  16,                -- num_layers
  10, 100,           -- min/max seconds
  10000, 1000000,    -- min/max rows
  10000000, 100000000 -- min/max bytes
);
```

## Usage

### Tracking Votes

Votes are tracked via the `Tracker.crucibleVote()` method in `src/server/clickhouse/client.ts`:

```typescript
// In submitVote service function
await tracker.crucibleVote({
  crucibleId,
  winnerEntryId,
  loserEntryId,
});
```

### Querying Vote Data

```typescript
import { clickhouse } from '~/server/clickhouse/client';

// Get vote count per crucible
const result = await clickhouse.$query`
  SELECT
    crucible_id,
    count() as total_votes,
    uniq(user_id) as unique_voters
  FROM crucible_votes
  WHERE crucible_id = ${crucibleId}
  GROUP BY crucible_id
`;

// Get user's voting history for a crucible
const userVotes = await clickhouse.$query`
  SELECT winner_entry_id, loser_entry_id, created_at
  FROM crucible_votes
  WHERE crucible_id = ${crucibleId}
    AND user_id = ${userId}
  ORDER BY created_at DESC
  LIMIT 100
`;
```

### Analytics Queries

```typescript
// Daily vote volume
const dailyStats = await clickhouse.$query`
  SELECT
    toDate(created_at) as date,
    count() as votes,
    uniq(user_id) as voters
  FROM crucible_votes
  WHERE crucible_id = ${crucibleId}
  GROUP BY date
  ORDER BY date
`;

// Most voted-on entries
const topEntries = await clickhouse.$query`
  SELECT
    entry_id,
    count() as appearances
  FROM (
    SELECT winner_entry_id as entry_id FROM crucible_votes WHERE crucible_id = ${crucibleId}
    UNION ALL
    SELECT loser_entry_id as entry_id FROM crucible_votes WHERE crucible_id = ${crucibleId}
  )
  GROUP BY entry_id
  ORDER BY appearances DESC
  LIMIT 10
`;
```

## Data Retention

- Votes are retained for 90 days (configurable via TTL)
- Final results are persisted in PostgreSQL `CrucibleEntry.score` and `position` fields
- Redis ELO cache is cleared when crucible ends

## Related Files

| File | Purpose |
|------|---------|
| `src/server/clickhouse/client.ts` | `Tracker.crucibleVote()` method |
| `src/server/services/crucible.service.ts` | `submitVote()` calls tracker |
| `src/server/redis/crucible-elo.redis.ts` | Real-time ELO cache |
