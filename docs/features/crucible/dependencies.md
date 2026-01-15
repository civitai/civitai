# Crucible Feature Dependencies

This document describes the existing systems that Crucible will integrate with, discovered during planning.

---

## 1. Image Resource Tracking

**Purpose:** Verify which models/LoRAs were used to create submitted images.

### Key Files
- `prisma/schema.full.prisma` - `ImageResourceNew` model (lines 1565-1575)
- `src/server/services/image.service.ts` - `getImageResources()`, `getImageResourcesFromImageId()`
- `src/server/redis/caches.ts` - `imageResourcesCache` (lines 976-1018)
- `prisma/programmability/get_image_resources.sql` - Detection function

### Schema
```prisma
model ImageResourceNew {
  imageId        Int
  modelVersionId Int
  strength       Int?
  detected       Boolean @default(false)
  @@id([imageId, modelVersionId])
}
```

### Usage for Crucible
When validating crucible entries, query `ImageResourceNew` to verify the image used allowed resources:
```typescript
const resources = await imageResourcesCache.fetch(imageId);
const usedModelVersionIds = resources.map(r => r.modelVersionId);
const allowed = crucible.configuration.allowedResources;
const isValid = usedModelVersionIds.every(id => allowed.includes(id));
```

---

## 2. NSFW Level Filtering

**Purpose:** Filter crucible entries and judging content based on user browsing preferences.

### Key Files
- `src/server/common/enums.ts` - `NsfwLevel` enum (lines 277+)
- `src/shared/constants/browsingLevel.constants.ts` - Level constants and utilities
- `event-engine-common/utils/nsfw-utils.ts` - `Flags` utility class

### NsfwLevel Enum (Bitwise)
```typescript
enum NsfwLevel {
  PG = 1,      // 0b00001
  PG13 = 2,    // 0b00010
  R = 4,       // 0b00100
  X = 8,       // 0b01000
  XXX = 16,    // 0b10000
  Blocked = 32 // 0b100000
}
```

### Key Utilities
```typescript
import { Flags } from '~/event-engine-common/utils/nsfw-utils';

// Check if content is visible to user
Flags.intersects(contentNsfwLevel, userBrowsingLevel); // true = visible

// Check if content is safe
Flags.intersects(level, nsfwBrowsingLevelsFlag); // true = NSFW content
```

### Usage for Crucible
1. **Crucible Creation:** Set `nsfwLevel` bitwise flag for allowed content levels
2. **Entry Submission:** Validate `entry.nsfwLevel & crucible.nsfwLevel !== 0`
3. **Judging Display:** Filter pairs by `Flags.intersects(entry.nsfwLevel, user.browsingLevel)`

---

## 3. Buzz Account System

**Purpose:** Handle entry fees and prize pool distribution.

### Key Files
- `src/shared/constants/buzz.constants.ts` - Account types and transaction types
- `src/server/services/buzz.service.ts` - Transaction handling
- `src/server/services/bounty.service.ts` - Prize pool pattern (reference)

### Buzz Types
```typescript
// Spend types (user-facing)
yellow: 'User'           // NSFW-enabled, bankable, purchasable
green: 'Green'           // Bankable, purchasable
blue: 'Generation'       // Non-bankable

// Transaction types relevant to Crucible
TransactionType.Bounty = 8      // Entry fee collection
TransactionType.BountyEntry = 9 // Could reuse for crucible entry
TransactionType.Reward = 5      // Prize distribution
```

### Prize Pool Pattern (from Bounties)
```typescript
// Collect entry fee into central bank (account 0)
await createMultiAccountBuzzTransaction({
  fromAccountId: userId,
  fromAccountTypes: ['yellow'],
  toAccountId: 0, // Central bank holds prize pool
  amount: entryFee,
  type: TransactionType.Fee, // @dev: Changed to Fee per your request
  details: { entityId: crucibleId, entityType: 'Crucible' },
});

// Distribute prize from central bank
await createMultiAccountBuzzTransaction({
  fromAccountId: 0,
  fromAccountTypes: ['yellow'],
  toAccountId: winnerId,
  amount: prizeAmount,
  type: TransactionType.Reward,
  details: { entityId: crucibleId, entityType: 'Crucible' },
});
```

---

## 4. Notification System

**Purpose:** Notify users of crucible events (results, rewards, etc.).

### Key Files
- `src/server/notifications/` - Notification processors
- `src/server/services/notification.service.ts` - `createNotification()`
- `src/server/jobs/send-notifications.ts` - Processing job

### Adding Crucible Notifications

**Step 1:** Create `src/server/notifications/crucible.notifications.ts`
```typescript
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const crucibleNotifications = createNotificationProcessor({
  'crucible-ended': {
    displayName: 'Crucible Results',
    category: NotificationCategory.Other, // Or add new category
    prepareMessage: ({ details }) => ({
      message: `You placed #${details.position} in "${details.crucibleName}"`,
      url: `/factions/${details.factionId}/crucibles/${details.crucibleId}`,
    }),
  },
  'crucible-reward-earned': {
    displayName: 'Crucible Rewards',
    category: NotificationCategory.Buzz,
    prepareMessage: ({ details }) => ({
      message: `You earned ${details.rewardName} from crucible "${details.crucibleName}"`,
      url: `/factions/${details.factionId}/crucibles/${details.crucibleId}`,
    }),
  },
});
```

**Step 2:** Register in `src/server/notifications/utils.notifications.ts`
```typescript
import { crucibleNotifications } from './crucible.notifications';
export const notificationProcessors = {
  ...crucibleNotifications,
  // ... other processors
};
```

**Step 3:** Send notifications
```typescript
await createNotification({
  key: `crucible-ended:${crucibleId}:${userId}`,
  type: 'crucible-ended',
  category: NotificationCategory.Other,
  userId: winnerId,
  details: { crucibleId, crucibleName, position, factionId },
});
```

---

## 5. ELO Rating System

**Purpose:** Fair ranking for head-to-head competitions where entry order matters.

@dev: Let's use ELO instead...
@ai: Agreed. ELO is better because later entries don't get disadvantaged by having fewer votes.

### ELO Implementation

```typescript
// ELO calculation for Crucible
const K = 32; // Sensitivity factor (higher = more volatile rankings)
const BASE_RATING = 1500; // Starting ELO for new entries

function calculateEloChange(winnerRating: number, loserRating: number): { winnerDelta: number; loserDelta: number } {
  const expectedWinner = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
  const expectedLoser = 1 - expectedWinner;

  return {
    winnerDelta: Math.round(K * (1 - expectedWinner)),
    loserDelta: Math.round(K * (0 - expectedLoser)),
  };
}

// Example:
// Entry A (1500) beats Entry B (1500) → A gets +16, B gets -16
// Entry A (1600) beats Entry B (1400) → A gets +5, B gets -5 (expected win)
// Entry A (1400) beats Entry B (1600) → A gets +27, B gets -27 (upset)
```

### Rating Storage Strategy
- **ClickHouse:** Store all vote events for analytics/auditing
- **Redis:** Cache current ELO ratings for fast reads during matchmaking
- **PostgreSQL:** Store final ratings on `CrucibleEntry.score` when crucible ends

---

## 6. Metric Event Tracking

**Purpose:** Track crucible activity for analytics and leaderboards.

@dev: We can do this with our [event watcher system](C:\Dev\Repos\work\civitai\metric-event-watcher\src\handlers\bounty-entries.ts) instead. Have a subagent explore and implement this. It requires setting up a debezium subscription or whatever for that (which they'll see in the config for that project).

@ai: Understood. Will use the metric-event-watcher codebase (`C:\Dev\Repos\work\civitai\metric-event-watcher`) for Crucible metrics. This requires:
1. Debezium subscription for `Crucible` and `CrucibleEntry` tables
2. Handler similar to `bounty-entries.ts` for processing events
3. ClickHouse materialized views for aggregations

### Key Files
- `src/server/clickhouse/client.ts` - `Tracker.entityMetric()` (lines 598-609)
- `src/server/utils/metric-helpers.ts` - Helper functions
- `src/server/metrics/base.metrics.ts` - Metric processor factory

### ClickHouse Table
```sql
CREATE TABLE entityMetricEvents (
  entityType LowCardinality(String),
  entityId   Int32,
  userId     Int32,
  metricType LowCardinality(String),
  metricValue Int32,
  createdAt  DateTime64(3)
) ENGINE = MergeTree() ORDER BY (entityType, entityId, createdAt);
```

### Tracking Crucible Metrics
```typescript
// Track crucible entry
await ctx.track.entityMetric({
  entityType: 'Crucible',
  entityId: crucibleId,
  metricType: 'Entry',
  metricValue: 1,
});

// Track crucible vote
await ctx.track.entityMetric({
  entityType: 'Crucible',
  entityId: crucibleId,
  metricType: 'Vote',
  metricValue: 1,
});
```

### Vote Tracking in ClickHouse
For crucible voting, create dedicated table:
```sql
CREATE TABLE crucible_entry_rating (
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

@dev: So do the entries only live in Clickhouse? I think thats fine. Would we track the current ELO in redis? Also, We'll probably want to batch the entry ratings since Clickhouse doesn't like single inserts, unless we add a buffer table.

@ai: Good questions. Here's the proposed approach:

**Vote Storage:**
- Individual votes → ClickHouse `crucible_entry_rating` (via buffer table for batching)
- We'll use a Buffer table that flushes every few seconds or when threshold reached

**ELO Tracking:**
- Current ELO → Redis hash `crucible:{crucibleId}:elo` with entry IDs as keys
- Updated in real-time on each vote
- Final ELO copied to PostgreSQL `CrucibleEntry.score` when crucible ends

**Buffer Table Pattern:**
```sql
CREATE TABLE crucible_entry_rating_buffer AS crucible_entry_rating
ENGINE = Buffer(default, crucible_entry_rating, 16, 10, 100, 10000, 1000000, 10000000, 100000000);
-- Flushes: 16 partitions, 10-100 seconds, 10k-1M rows, 10MB-100MB
```

---

## 7. Thread/Comment System

**Purpose:** Allow discussion on crucibles.

### Key Files
- `prisma/schema.full.prisma` - `Thread` model
- `src/server/services/commentsv2.service.ts` - Comment handling

### Integration
Add `crucibleId` to Thread model:
```prisma
model Thread {
  // existing fields...
  crucibleId Int? @unique
  crucible   Crucible? @relation(fields: [crucibleId], references: [id])
}
```

@dev: Let's have comments for the images submitted under each image when displaying them side by side for voting (probably just the top most reacted comment and the count of comments and the ability to open the comments in a modal)

@ai: Great idea. For the rating UI ([mockup](../plans/../working/mockups/crucible-rating/v1e-adjusted.html)), we'll show:
- Top comment (most reacted) under each entry during voting
- Comment count badge
- Click to open full comments modal
- This uses existing image comment system - no new tables needed, just query by `imageId`

---

## Summary: Crucible Integration Points

| System | Integration | Complexity |
|--------|-------------|------------|
| Image Resources | Validate allowed models | Low |
| NSFW Filtering | Filter entries + judging | Low |
| Buzz Accounts | Entry fees + prizes | Medium |
| Notifications | Results + rewards | Low |
| Metrics | Activity tracking | Low |
| Threads | Discussion | Low |
| Vote Tracking | ClickHouse table | Medium |

All systems have established patterns that can be followed for Crucible implementation.
