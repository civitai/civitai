# Crucible Implementation Review

**Date:** 2026-01-16
**Reviewers:** Gemini 3 Pro, GPT-5.1 Codex (via agent-review skill)
**Status:** All 46 PRD user stories passing; issues identified below need addressing

---

## Critical Issues

### 1. Financial Atomicity - "Ghost Charge" Risk

**Severity:** Critical
**Files:** `src/server/services/crucible.service.ts:78-114` (createCrucible), `src/server/services/crucible.service.ts:435-470` (submitEntry)

**Problem:** Buzz transactions execute *before* database writes. If the DB transaction fails (constraint violation, temporary outage, image creation failure), the user is charged but no Crucible/Entry record is created.

**Impact:** Users lose Buzz with no corresponding record or service.

**Fix:**
```typescript
// Wrap the entire operation in try/catch
try {
  // 1. Create Buzz transaction
  const transaction = await createMultiAccountBuzzTransaction(...);

  // 2. Create DB record
  await dbWrite.crucible.create(...);
} catch (error) {
  // 3. On DB failure, immediately refund using transactionPrefix
  await refundMultiAccountTransaction(transactionPrefix);
  throw error;
}
```

---

## High Priority Issues

### 2. Redis Data Loss Risk

**Severity:** High
**Files:** General architecture (submitVote, finalizeCrucible)

**Problem:** All ELO scores and vote counts live only in Redis until finalization. If Redis restarts/flushes (and AOF/RDB persistence fails), **all competition progress is lost**.

**Impact:** Total loss of voting data for active crucibles.

**Fix:** Implement a periodic background sync job (every 5-10 minutes) that writes Redis state to PostgreSQL as a recovery checkpoint:
```typescript
// New background job: syncCrucibleScoresToDb
async function syncCrucibleScoresToDb(crucibleId: number) {
  const redisElos = await crucibleEloRedis.getAllElos(crucibleId);
  const redisVotes = await crucibleEloRedis.getAllVoteCounts(crucibleId);

  // Batch update entries with current Redis state
  await dbWrite.$transaction(
    Object.entries(redisElos).map(([entryId, score]) =>
      dbWrite.crucibleEntry.update({
        where: { id: parseInt(entryId) },
        data: { score, voteCount: redisVotes[entryId] ?? 0 }
      })
    )
  );
}
```

---

### 3. Finalization Transaction Timeout

**Severity:** High
**Files:** `src/server/services/crucible.service.ts:1370-1389`

**Problem:** Individual `UPDATE` for every entry inside a single `$transaction`. A crucible with thousands of entries will exceed the database transaction timeout.

**Impact:** Finalization fails for large crucibles; prizes not distributed.

**Fix:** Batch updates (50-100 items per transaction) or use raw SQL:
```typescript
// Option 1: Batch in chunks
const BATCH_SIZE = 50;
for (let i = 0; i < finalizedEntries.length; i += BATCH_SIZE) {
  const batch = finalizedEntries.slice(i, i + BATCH_SIZE);
  await dbWrite.$transaction(
    batch.map(entry => dbWrite.crucibleEntry.update({...}))
  );
}

// Option 2: Raw SQL with VALUES
await dbWrite.$executeRaw`
  UPDATE "CrucibleEntry" AS ce
  SET "score" = v.score, "position" = v.position, "prizeAmount" = v.prize
  FROM (VALUES ${Prisma.join(valuesTuples)}) AS v(id, score, position, prize)
  WHERE ce.id = v.id
`;
```

---

### 4. ELO Zero-Sum Violation

**Severity:** High
**Files:** `src/server/services/crucible-elo.service.ts:41-42`

**Problem:** Independent `Math.round()` on winner and loser changes breaks zero-sum property. Example: +7/-8 creates rating drift over time.

**Impact:** Total ELO in the system inflates or deflates over time.

**Fix:**
```typescript
// Current (broken):
const winnerChange = Math.round(kFactor * (actualWinner - expectedWinner));
const loserChange = Math.round(kFactor * (actualLoser - expectedLoser));

// Fixed:
const winnerChange = Math.round(kFactor * (actualWinner - expectedWinner));
const loserChange = -winnerChange; // Ensure zero-sum
```

---

### 5. Redis Race Condition in ELO Updates

**Severity:** High
**Files:** `src/server/services/crucible-elo.service.ts:82-113`

**Problem:** Two Redis commands (read ELO, then increment) without transaction. Concurrent votes can read the same stale ratings, compute deltas based on outdated expectations.

**Impact:** ELO calculations become non-deterministic under load.

**Fix:** Use Lua script for atomic read-compute-update:
```lua
-- crucible-elo.lua
local winnerKey = KEYS[1]
local loserKey = KEYS[2]
local winnerField = ARGV[1]
local loserField = ARGV[2]
local kFactor = tonumber(ARGV[3])

local winnerElo = tonumber(redis.call('HGET', winnerKey, winnerField)) or 1500
local loserElo = tonumber(redis.call('HGET', loserKey, loserField)) or 1500

-- Calculate expected scores
local expectedWinner = 1 / (1 + math.pow(10, (loserElo - winnerElo) / 400))
local winnerChange = math.floor(kFactor * (1 - expectedWinner) + 0.5)

-- Update atomically
redis.call('HINCRBY', winnerKey, winnerField, winnerChange)
redis.call('HINCRBY', loserKey, loserField, -winnerChange)

return {winnerChange, -winnerChange, winnerElo + winnerChange, loserElo - winnerChange}
```

---

## Medium Priority Issues

### 6. K-Factor Averaging (Non-Standard ELO)

**Severity:** Medium
**Files:** `src/server/services/crucible-elo.service.ts:93-95`

**Problem:** Uses average of both players' K-factors instead of individual K per player (standard ELO). This biases results - provisionals "hide" behind low K, established players get extra volatility.

**Fix:** Apply each player's K-factor to their own rating change:
```typescript
const winnerK = getKFactor(winnerVoteCount);
const loserK = getKFactor(loserVoteCount);

const winnerChange = Math.round(winnerK * (1 - expectedWinner));
const loserChange = Math.round(loserK * (0 - expectedLoser));
```

---

### 7. Serial Cancellation Refunds

**Severity:** Medium
**Files:** `src/server/services/crucible.service.ts:1594-1626`

**Problem:** Sequential `await` in refund loop. Many entries = long request duration, potential HTTP timeout.

**Impact:** Partial refunds if server times out; poor UX.

**Fix:** Use `Promise.all` with concurrency limit:
```typescript
import pLimit from 'p-limit';

const limit = pLimit(10); // 10 concurrent refunds
await Promise.all(
  entries.map(entry =>
    limit(() => refundMultiAccountTransaction(entry.transactionPrefix))
  )
);
```

---

### 8. Memory Usage in Finalization

**Severity:** Medium
**Files:** `src/server/services/crucible.service.ts:1216-1226`

**Problem:** Loads ALL entries into memory via Prisma include. 10k+ entries = significant heap usage.

**Fix:** Use cursor-based pagination:
```typescript
let cursor: number | undefined;
const BATCH_SIZE = 500;

while (true) {
  const entries = await dbRead.crucibleEntry.findMany({
    where: { crucibleId },
    take: BATCH_SIZE,
    cursor: cursor ? { id: cursor } : undefined,
    skip: cursor ? 1 : 0,
    orderBy: { id: 'asc' }
  });

  if (entries.length === 0) break;

  // Process batch...
  cursor = entries[entries.length - 1].id;
}
```

---

### 9. ORDER BY RANDOM() Performance

**Severity:** Medium
**Files:** `src/server/services/crucible.service.ts:715-716`

**Problem:** `ORDER BY RANDOM()` causes full table scan for random sampling on large crucibles.

**Impact:** High DB CPU load when repeatedly called on large crucibles.

**Fix:** Consider `TABLESAMPLE` or application-level random ID selection:
```sql
-- Option 1: TABLESAMPLE (approximate but fast)
SELECT * FROM "CrucibleEntry" TABLESAMPLE BERNOULLI(10)
WHERE "crucibleId" = $1 LIMIT 100;

-- Option 2: Random ID range
SELECT * FROM "CrucibleEntry"
WHERE "crucibleId" = $1 AND id >= (
  SELECT floor(random() * (max(id) - min(id)) + min(id))
  FROM "CrucibleEntry" WHERE "crucibleId" = $1
)
LIMIT 100;
```

---

## Low Priority Issues

### 10. Redundant Vote Check

**Severity:** Low
**Files:** `src/server/services/crucible.service.ts:1055-1057`

**Problem:** `isPairVoted` check before atomic `sAdd` is redundant. The `sAdd` return value at line 1068 handles this atomically.

**Fix:** Remove the initial check, rely solely on `sAdd`:
```typescript
// Remove this:
// const isPairVoted = await sysRedis.sIsMember(votedPairsKey, pairKey);
// if (isPairVoted) throw new TRPCError(...);

// Keep only the atomic check:
const added = await sysRedis.sAdd(votedPairsKey, pairKey);
if (added === 0) {
  throw new TRPCError({ code: 'CONFLICT', message: 'This pair is already being processed' });
}
```

---

### 11. Prize Pool Cap Missing

**Severity:** Low
**Files:** `src/server/schema/crucible.schema.ts`

**Problem:** No max validation on `entryFee`. Extreme values could cause integer overflow in pool calculations.

**Fix:** Add max constraint to schema:
```typescript
entryFee: z.number().int().min(0).max(1_000_000), // Cap at 1M Buzz
entryLimit: z.number().int().min(1).max(10_000),
```

---

### 12. Tie-Breaking Hidden Mechanic

**Severity:** Low
**Files:** `src/server/services/crucible.service.ts:1315-1321`

**Problem:** Entry time tiebreaker is not documented for users. Earlier submitters have an advantage they don't know about.

**Fix:** Document in UI/rules that "In case of tied scores, earlier entries rank higher."

---

## Pattern Compliance Summary

| Area | Status | Notes |
|------|--------|-------|
| tRPC patterns | ✅ | Correct use of `guardedProcedure`, `isFlagProtected`, middleware |
| Prisma patterns | ✅ | Proper use of `$transaction`, selects, includes |
| Redis patterns | ⚠️ | Missing atomic operations for multi-step updates |
| Error handling | ⚠️ | Financial operations need rollback on failure |
| Mantine v7 | N/A | Backend service, no UI components |

---

## Implementation Priority

| # | Issue | Severity | Effort | Priority |
|---|-------|----------|--------|----------|
| 1 | Ghost charge risk | Critical | Medium | P0 |
| 2 | Redis data loss | High | Medium | P1 |
| 3 | Finalization timeout | High | Low | P1 |
| 4 | ELO zero-sum | High | Low | P1 |
| 5 | ELO race condition | High | Medium | P1 |
| 6 | K-factor averaging | Medium | Low | P2 |
| 7 | Serial refunds | Medium | Low | P2 |
| 8 | Memory in finalization | Medium | Medium | P2 |
| 9 | RANDOM() performance | Medium | Medium | P2 |
| 10 | Redundant vote check | Low | Trivial | P3 |
| 11 | Prize pool cap | Low | Trivial | P3 |
| 12 | Tie-breaking docs | Low | Trivial | P3 |

---

## Test Coverage Notes

Existing tests cover:
- ELO calculations (crucible-elo.service.test.ts)
- Entry validation (crucible-validation.test.ts)
- Finalization edge cases (crucible-finalization.test.ts)
- Matchmaking phases (crucible-matchmaking.test.ts)

Tests needed for fixes:
- Ghost charge rollback scenarios
- Concurrent vote race conditions
- Large crucible finalization (1000+ entries)
- Redis failure recovery
