# Knights of New Order (KoNo)

A gamified content-moderation system where players rate image NSFW levels to earn EXP/Buzz. Correct ratings level players up through ranks; wrong ratings accumulate smites. The system uses player-weighted consensus voting backed by Redis counters and ClickHouse for analytics.

## Key Files

| File | Purpose |
|------|---------|
| `src/server/services/games/new-order.service.ts` | Core game logic: voting, consensus, smites, resets |
| `src/server/games/new-order/utils.ts` | Redis counter factory + rate limiter |
| `src/server/jobs/new-order-jobs.ts` | Daily cron jobs: buzz grant, fervor reset, abuse detection, slot rotation |
| `src/server/schema/games/new-order.schema.ts` | Zod input schemas |
| `src/server/routers/games.router.ts` | tRPC procedures (`newOrder.*`) |
| `src/server/notifications/new-order.notifications.ts` | Notification processors |
| `src/pages/games/knights-of-new-order.tsx` | Player game page |
| `src/components/Games/NewOrder/` | UI components (sidebar, rater, history, etc.) |
| `src/components/Games/KnightsNewOrder.utils.ts` | tRPC hooks, signal listeners, optimistic updates |
| `src/pages/api/mod/new-order/manage-queue.ts` | Mod queue management (webhook-token guarded) |
| `src/pages/api/mod/new-order/rate-limit-config.ts` | Rate-limit config (mod-only) |
| `src/pages/api/admin/manage-sanity-checks.ts` | Sanity-check pool management |
| `src/pages/api/testing/new-order.ts` | Debug endpoint (`?token=$WEBHOOK_TOKEN`) |

## Ranks

Players progress through ranks based on EXP and fervor:

| Rank | Source | Notes |
|------|--------|-------|
| `Acolyte` | Default on join | Training rank; rates against known answers, no buzz earned |
| `Knight` | EXP threshold (`NewOrderRank.minExp`) | Earns buzz from correct votes, contributes to consensus |
| `Templar` | (Deprecated) Promoted from Knight by fervor | Selection job removed; rank type still in DB |
| `Inquisitor` | Moderator role | Reviews escalated images; not stored in `NewOrderPlayer` |

Acolytes are trained against pre-rated "sanity check" images. Sustained correct ratings level them up to Knight (with a cosmetic badge grant).

## Database Schema

### Core Tables
- `NewOrderPlayer` — `userId`, `rankType`, `exp`, `fervor`, `startAt`
- `NewOrderRank` — rank definitions, `minExp` thresholds, cosmetic badges
- `NewOrderSmite` — `targetPlayerId`, `moderatorId`, `reason`, `size`, `cleansedAt`, `cleansedReason`

### ClickHouse
- `knights_new_order_image_rating` — append-only log of all votes (`userId`, `imageId`, `rating`, `status`, `rank`, `grantedExp`, `multiplier`, `createdAt`)
- `knights_rating_updates_buffer` — write-through buffer for Pending → Correct/Failed/Inconclusive transitions
- `buzzTransactions` — used by `recentlyGrantedBuzzCounter` to read recent KoNo buzz grants

## Vote Flow

```
addRating (tRPC)
  → addImageRating (service:354)
  → withDistributedLock("image-rating:{imageId}", ttl=30s, retries=5)
    → processImageRating
      → getPlayerById + dbRead.image.findUnique
      → if (!isModerator) checkVotingRateLimit
          → dayLimitExceeded + autoSmiteEnabled → autoSmitePlayer('rate-limit')
      → if (sanity-check image) → addSanityCheckRating + return
      → isImageInQueue → which pool/slot/rank
      → if (isModerator) → updateImageNsfwLevel + updatePendingImageRatings + return
      → pool.increment(imageId)                          // bump vote count
      → getImageRatingsCounter(imageId).increment({      // weighted rating zset
            id: `{rank}-{nsfwLevel}`,
            value: voteWeight * 100
        })
      → if (Knight && reachedKnightVoteLimit):
          → checkWeightedConsensus
          → if (consensus && distance > 1) → escalate to Inquisitor queue
          → else if (consensus) → updateImageNsfwLevel + updatePendingImageRatings
      → chTracker.newOrderImageRating(...)               // log to ClickHouse
      → if (isAcolyte && AcolyteFailed) → acolyteFailedJudgments++
            → if > ACOLYTE_WRONG_ANSWER_LIMIT → smitePlayer (system)
      → if (Acolyte levelUp) → cleanseAllSmites + reset wrong-answer counter
      → if (Blocked && weightedScore >= 200) → createReport (AdminAttention)
      → addRatedImage(playerId, imageId)                 // cache for filterUnratedImages
      → updatePlayerStats (exp/fervor/blessedBuzz)
      → if (Acolyte → Knight threshold) → rank promotion + cosmetic + signal
```

### Vote Weight

```
weight = 1 + (level - 20) / 60 - smites / 6
```

Range: **0** (level 20, 6 smites) → **2.0** (level 80, no smites). Stored as `Math.round(weight * 100)` in the per-image rating zset for floating-point safety.

### Consensus

`checkWeightedConsensus` (service:1336) returns the first rating whose weighted score crosses the threshold:

```
minForConsensus = voteCount * 0.6 * 100
```

The denominator is voter count × 100 (assuming each voter contributes 100 = weight 1.0). Higher-weight voters can swing consensus disproportionately — this is intentional to give high-level Knights more influence.

### Vote Limits

| Constant | Value | Meaning |
|----------|-------|---------|
| `limits.minKnightVotes` | 4 | Below this, no consensus check |
| `limits.knightVotes` | 5 | First consensus check triggered |
| `limits.maxKnightVotes` | 10 | Hard cap — forces consensus or marks Inconclusive |
| `limits.templarVotes` | 2 | (Deprecated) |
| `limits.templarPicks` | 24 | (Deprecated) |

### Escalation

When Knight consensus down-rates by more than 1 NSFW level (`Flags.distance > 1`), the image is removed from the Knight queue and added to the Inquisitor queue at priority 1. Mods rate it directly via `updateImageNsfwLevel` with `status: 'Actioned'`.

When 2+ Knights vote `Blocked` (weighted score ≥ 200), an `AdminAttention` report is created and the image is removed from the queue.

## Queues (Pool Counters)

Each rank has 3 priority pools per slot (`a` / `b`); Inquisitor has 1 pool per slot. Pools are Redis sorted sets keyed `NEW_ORDER:QUEUES:{rank}{1|2|3}:{slot}`.

```
poolCounters = {
  Acolyte:    { a: [1, 2, 3], b: [1, 2, 3] },
  Knight:     { a: [1, 2, 3], b: [1, 2, 3] },
  Templar:    { a: [1, 2, 3], b: [1, 2, 3] },
  Inquisitor: { a: [1],       b: [1]       },
}
```

### Image Population

`addImageToQueue` is called from:
- `image-scan-result.service.ts` — newly scanned images
- `image.service.ts` — image lifecycle hooks
- `webhooks/image-scan-result.ts` — scan webhook
- `mod/new-order/manage-queue.ts` — mod manual insert
- `new-order.service.ts:574` — escalation to Inquisitor

Implementation note: `addImageToQueue` uses `pool.getCount(imageId)` which writes via the cache-miss path — `setCacheValue(id, 0)` does a `zAdd(score: 0, value: imageId)`. New images enter the queue at score 0; voting bumps the score via `pool.increment`.

### Slot Rotation (Knight only)

To support purging stale images without blocking active voting, Knight queues use a/b slot rotation:

- `new-order-change-fill-target` (22:00 UTC) — flips the `filling` slot. New images go to the new slot.
- `new-order-change-rate-target` (00:00 UTC) — flips the `rating` slot, then purges the old slot:
  1. Reads remaining image IDs from old slot
  2. Inserts NULL ratings into `knights_rating_updates_buffer` (marks as Inconclusive)
  3. Calls `processFinalRatings` to flush the buffer
  4. `pool.reset({ all: true })` clears the old slot

Acolyte / Templar / Inquisitor remain on slot `a` permanently.

### Queue Display

`getImagesQueue` (service:1586) reads pools in priority order, descending score. For Knights it filters `score < knightVotes` to skip already-saturated images. Already-rated images are filtered via `filterUnratedImages` using Redis SMISMEMBER on a per-user rated cache.

## Redis Counters (`createCounter`)

Generic factory in `utils.ts:27`. Each counter has:
- `key` — under `REDIS_SYS_KEYS.NEW_ORDER.*`
- `fetchCount(ids)` — DB/ClickHouse source-of-truth fallback on cache miss
- `ttl` — `0` = never expire (granting job handles cleanup)
- `ordered` — `true` for zsets (leaderboards, queues), `false` for hashes

API: `increment`, `decrement`, `reset`, `getCount`, `getCountBatch`, `getAll`, `exists`.

Notable counters:

| Counter | TTL | Source | Purpose |
|---------|-----|--------|---------|
| `correctJudgmentsCounter` | day | ClickHouse | Per-user correct votes (7-day window) |
| `allJudgmentsCounter` | day | ClickHouse | Per-user total votes (7-day window) |
| `acolyteFailedJudgments` | week | zero | Acolyte wrong-answer count |
| `sanityCheckFailuresCounter` | day | zero | Sanity-check failures (24h window) |
| `fervorCounter` | 0 | `dbRead.newOrderPlayer.fervor` | Leaderboard, recalculated by daily reset job |
| `smitesCounter` | week | `dbRead.newOrderSmite` (active) | Per-user active smite count |
| `blessedBuzzCounter` | 0 | ClickHouse (2 days ago → today) | Earned EXP awaiting buzz grant |
| `pendingBuzzCounter` | day | ClickHouse (next grant cycle) | What will be granted at next 00:00 UTC |
| `recentlyGrantedBuzzCounter` | day | ClickHouse (`buzzTransactions`) | Last 7 days of KoNo buzz grants |
| `expCounter` | week | `dbRead.newOrderPlayer.exp` | Per-user EXP |

`getImageRatingsCounter(imageId)` (utils.ts:696) — ordered zset keyed `RATINGS:{imageId}`, members `{rank}-{nsfwLevel}`, scores = weighted vote totals.

## Rate Limiting

`checkVotingRateLimit(userId)` (utils.ts:780) — sliding-window per-user limiter using three Redis sorted sets:

```
NEW_ORDER:RATE_LIMIT:MINUTE:{userId}
NEW_ORDER:RATE_LIMIT:HOUR:{userId}
NEW_ORDER:RATE_LIMIT:DAY:{userId}
```

Config (Redis key `REDIS_SYS_KEYS.NEW_ORDER.CONFIG`):

```typescript
{
  perMinute: number;
  perHour: number;
  perDay: number;
  autoSmiteEnabled?: boolean;             // smite on day-limit breach
  autoSmiteFromDetectionJob?: boolean;    // smite on abuse-detection strict signals
}
```

Behavior:
- Fail-closed: missing/partial config → `DENIED_RESPONSE` (allowed=false, no auto-smite)
- Mods bypass (`isModerator` skips the entire rate-limit block)
- Day-cap breach + `autoSmiteEnabled` → `autoSmitePlayer({ source: 'rate-limit' })`
- Standard limit breach → `throwBadRequestError` with wait time

Set via `pages/api/mod/new-order/rate-limit-config.ts`.

## Smites & Auto-Smite

### Manual smite (`smitePlayer`)
- Issued by moderators or system (`modId = constants.system.user.id`)
- Writes `NewOrderSmite` row + increments `smitesCounter`
- Sends notification + signal to player
- **3 active smites triggers career reset** (`resetPlayer`)

### Cleanse (`cleanseSmite`)
- Mod-issued: per-smite, decrements `smitesCounter`
- `cleanseAllSmites` — used internally on Acolyte level-up

### Auto-smite (`autoSmitePlayer`)
Two sources, each deduped per-day per-source (24h TTL via `SET NX EX`):

| Source | Trigger | Reason |
|--------|---------|--------|
| `rate-limit` | Daily vote cap exceeded + `autoSmiteEnabled` | Sustained spam |
| `detection-job` | Abuse-detection cron strict signals + `autoSmiteFromDetectionJob` | Bot-pattern voting |

Both sources can fire in the same day. Combined ≥ 3 active smites → career reset.

Strict signals (auto-smite eligible):
- `uniqueRatings === 1` (only ever voted one NSFW level)
- `dominantPct >= 90` (90%+ same value)
- `maxPerMinute >= 50` (50 votes in one minute)

Soft signal (logged but no auto-smite): `avgPerMinute > 15`.

## Sanity Checks

Mod-curated set in Redis (`NEW_ORDER:SANITY_CHECKS:POOL`), members format `{imageId}:{nsfwLevel}`. Managed via `/api/admin/manage-sanity-checks` (mod-only).

When an Acolyte rates an image in the sanity pool:
- Correct → normal flow
- Wrong → `sanityCheckFailuresCounter++` (24h window)
  - First failure (non-severe) → warning notification
  - Subsequent failures or severe under-rating (≥2 levels) → system smite with `size = newOrderConfig.smiteSize * 10` (100)

Severe under-rating: `submittedRating < correctNsfwLevel && Flags.distance >= 2` (e.g., XXX → PG).

## Buzz Grants

EXP accumulates per-vote in `blessedBuzzCounter`. The nightly `new-order-grant-bless-buzz` job (00:00 UTC):

1. Queries ClickHouse for judgments from **3 days ago** (`createdAt` between `subtract(3, 'day').startOf` and `endOf`)
2. Computes `balance = floor(SUM(grantedExp * multiplier) * blessedBuzzConversionRatio)` (current ratio: `1/1000`)
3. Filters to Knights/Templars only (Acolytes excluded)
4. Batches transactions (100 per batch) via `createBuzzTransactionMany`
   - `externalTransactionId = new-order-{userId}-{startDate.toISOString()}` — stable per cycle, idempotent across retries
5. For granted players: decrements `blessedBuzzCounter` by `totalExp`, resets `pendingBuzzCounter` + `recentlyGrantedBuzzCounter`
6. For sub-threshold players (`balance <= 0`): preserves EXP, only resets `pendingBuzzCounter` (rolls over)
7. Reconciliation step: zeros counters for users with no ClickHouse activity in 3 days (drift cleanup)

The 3-day window exists to give the rating finalization pipeline time to flip Pending → Correct/Failed/Inconclusive before payout.

## Daily Reset Job (`new-order-daily-reset`, 00:00 UTC)

Syncs PostgreSQL from Redis counters in batches of 200:

1. Batch-fetch `correctJudgmentsCounter`, `allJudgmentsCounter`, `expCounter`, `fervorCounter` for all players
2. Recalculate fervor: `floor(correctJudgments * 100 * max(0.1, accuracyRatio))`
3. Update Redis fervor counter (reset + increment, or reset if 0)
4. Bulk `UPDATE NewOrderPlayer SET exp, fervor` via raw query with JSON payload
5. Clear `rated-images:{userId}` cache for each player

## Other Jobs

| Job | Schedule | Purpose |
|-----|----------|---------|
| `new-order-grant-bless-buzz` | `0 0 * * *` | Buzz grants from 3-days-ago votes |
| `new-order-daily-reset` | `0 0 * * *` | Recalc fervor + PG sync + rated-cache clear |
| `new-order-cleanse-smites` | `0 0 * * *` | Cleanse smites older than 7 days |
| `new-order-change-fill-target` | `0 22 * * *` | Rotate Knight filling slot |
| `new-order-change-rate-target` | `0 0 * * *` | Rotate Knight rating slot + purge old slot |
| `new-order-abuse-detection` | `0 23 * * *` | Scan ClickHouse for bot patterns, log to Axiom + Discord, optionally auto-smite |
| `new-order-cleanup-queues` | (disabled) | Replaced by slot-rotation purge |

## Signals (Realtime)

Server pushes via `signalClient.send({ userId, target, data })`. Client listens in `KnightsNewOrder.utils.ts`.

| Signal | Action | Payload |
|--------|--------|---------|
| `NewOrderPlayerUpdate` | `UpdateStats` | exp, fervor, blessedBuzz, smites, notification |
| `NewOrderPlayerUpdate` | `RankUp` | rankType, rank |
| `NewOrderPlayerUpdate` | `Reset` | stats reset + modal |
| `NewOrderQueueUpdate` | `AddImage` | new image batch |
| `NewOrderQueueUpdate` | `RemoveImage` | imageId removed |

Topic: `NewOrderQueue:{rankType}` per-rank subscription.

## tRPC API (`gamesRouter.newOrder.*`)

| Procedure | Auth | Purpose |
|-----------|------|---------|
| `join` | guarded | Create `NewOrderPlayer` row |
| `getPlayer` | guarded | Current player stats |
| `getImagesQueue` | guarded | Fetch next batch of images |
| `getHistory` | guarded | Paginated rating history |
| `addRating` | guarded | Submit a vote |
| `resetCareer` | guarded | Self-initiated reset |
| `getPlayers` | mod | Infinite players list (search) |
| `smitePlayer` | mod | Manual smite |
| `cleanseSmite` | mod | Cleanse one smite |
| `resetPlayerById` | mod + `newOrderReset` flag | Mod-initiated reset |
| `getImageRaters` | mod | Who voted what on an image |
| `manageSanityChecks` | mod | Add/remove sanity-check images |

All procedures gated by feature flag `newOrderGame`.

## Feature Flags

- `newOrderGame` — master flag; without it, the `/games/knights-of-new-order` page redirects and all tRPC procedures throw
- `newOrderReset` — required for mod-initiated career resets

## Notifications

`src/server/notifications/new-order.notifications.ts`:

| Type | When | Category |
|------|------|----------|
| `new-order-sanity-warning` | Wrong sanity-check rating (first/non-severe) | Other |
| `new-order-smite-received` | Smite issued | Other |
| `new-order-smite-cleansed` | Smite removed | Other |
| `new-order-game-over` | Career reset | Other |
| `new-order-templar-promotion` | (Deprecated) | Other |
| `new-order-knight-demoted` | (Deprecated) | Other |
| `new-order-blessed-buzz-granted` | Banked buzz payout | Other |

## Configuration

`src/server/common/constants.ts:1565` — `newOrderConfig`:

```typescript
{
  baseExp: 100,
  blessedBuzzConversionRatio: 1 / 1000,  // 1000 EXP → 1 Buzz
  smiteSize: 10,
  welcomeImageUrl: '...',
  cosmetics: { badgeIds: { acolyte: 858, knight: 859, templar: 860 } },
  limits: {
    knightVotes: 5,
    templarVotes: 2,
    templarPicks: 24,
    minKnightVotes: 4,
    maxKnightVotes: 10,
  },
}
```

Per-instance constants in `new-order.service.ts`:
- `ACOLYTE_WRONG_ANSWER_LIMIT` — wrong-answer cap before system smite
- `AUTO_SMITE_DEDUPE_TTL` — 24h window for auto-smite dedupe
- `processFinalRatings` lock TTL — 10s (separate from per-image rating lock at 30s)

## Debugging

### Common Issues

- **Player not seeing new images**: Check `getImagesQueue` filter — Knight pool filters `score < knightVotes`. Verify pool population via `redis-inspect` on `NEW_ORDER:QUEUES:*` keys.
- **Stale counters**: Redis counters can drift from ClickHouse/PG. `new-order-grant-bless-buzz` runs a reconciliation step for `blessedBuzzCounter`. For others, manual `reset` via the testing endpoint.
- **Wrong fervor**: Recalculated nightly. To force: trigger `new-order-daily-reset` via `/api/webhooks/run-jobs/new-order-daily-reset?token=$WEBHOOK_TOKEN`.
- **Auto-smite not firing**: Check Redis config has `autoSmiteEnabled: true` (rate-limit) or `autoSmiteFromDetectionJob: true` (detection). Check Axiom for `new-order-auto-smite` events.
- **Sanity-check loop**: `acolyteFailedJudgments` has a 1-week TTL. `resetPlayer` clears it explicitly, so a career reset wipes the wrong-answer count.

### Useful Skills / Tools

- `redis-inspect` — view counters / queues / sanity-check pool / rate-limit windows
- `clickhouse-query` — query `knights_new_order_image_rating` for player history
- `axiom` — search `name = 'new-order-*'` for production telemetry
- `/api/testing/new-order.ts?token=$WEBHOOK_TOKEN` — debug actions (see top-of-file comment)

### Telemetry

Axiom events:
- `new-order-image-rating` — vote write to ClickHouse
- `new-order-rate-limit` — sampled at 10% on rate-limit hits
- `new-order-rate-limit-unavailable` — Redis or config failures
- `new-order-auto-smite` — auto-smite issuance
- `new-order-abuse-detection-scan` — daily detection job summary
- `new-order-down-rating-escalated` — Inquisitor escalation
- `new-order-knights-report-error` — report-creation failures

Discord webhook (`DISCORD_WEBHOOK_MOD_ALERTS`) — daily abuse-detection summary.
