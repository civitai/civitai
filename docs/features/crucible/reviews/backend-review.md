# Crucible Backend Fixes Review

**Reviewed:** 2025-01-17
**Reviewer:** Gemini 3 Pro (via agent-review)
**Scope:** Commits 43394e972..599d8010c (Backend fixes from Gemini code review)

## Summary

| Severity | Count |
|----------|-------|
| Critical | 2 |
| Major | 2 |
| Minor | 2 |

---

## Critical Issues

### 1. Inconsistent ELO Calculation Logic (Zero-Sum vs. Inflationary)

**Location:** `src/server/services/crucible-elo.service.ts` vs `src/server/redis/crucible-elo.redis.ts`

**Analysis:**
- In `crucible-elo.service.ts`, the helper `calculateEloChange` was updated to enforce a zero-sum game (`loserChange = -winnerChange`).
- However, the actual voting logic was moved to a Lua script in `crucible-elo.redis.ts`.
- The Lua script calculates `winnerChange` and `loserChange` independently using their respective K-factors.
- **Result:** If a new user (High K) beats a veteran (Low K), the winner gains more points than the loser loses. This causes ELO inflation in the system. The JS helper update is effectively dead code or misleading documentation.

**Recommendation:**
Decide on the business rule. If zero-sum is required, update the Lua script to use a single K-factor (average) or force the loser change to match the winner.

**Fix (Lua Script):**
```lua
-- Calculate average K or pick one
local kFactor = (winnerK + loserK) / 2
local winnerChange = math.floor(kFactor * (1 - expectedWinner) + 0.5)
local loserChange = -winnerChange -- Enforce zero-sum
```

**Actionable:** YES

---

### 2. Sync Job Database Locking & Scalability

**Location:** `src/server/jobs/sync-crucible-scores.ts`

**Analysis:**
1. **Transaction Lock:** The job wraps the update of *every single entry* for a crucible in a single `dbWrite.$transaction`. If a crucible has 10,000 entries, this transaction will hold a lock on the `CrucibleEntry` table for a significant time while it processes 10,000 individual update queries. This will likely cause timeouts or deadlocks for users trying to submit entries or vote.
2. **N+1 Updates:** It iterates through `entryIds` and executes `tx.crucibleEntry.updateMany` for each one. This is extremely slow.
3. **Redis Blocking:** `crucibleEloRedis.getAllElos` likely uses `HGETALL`. For very large crucibles, this can block the Redis thread.

**Recommendation:**
1. **Remove the Transaction:** There is no need for atomicity here. This is a background sync job. If one row fails, it shouldn't roll back the others.
2. **Batch Updates:** Do not update one by one. Since Prisma doesn't support "UPDATE ... CASE ...", consider using raw SQL for bulk updates or at least batch the promises.
3. **Only Update Changed:** Fetch current scores from DB and only update if Redis differs, OR rely on an "updated" set in Redis.

**Fix (Simplified - Remove Transaction):**
```typescript
// Remove dbWrite.$transaction wrapper
// Process in chunks to avoid overwhelming the DB connection pool
const chunks = chunk(entryIds, 50); // Utility to chunk array
for (const batch of chunks) {
  await Promise.all(batch.map(entryId =>
    dbWrite.crucibleEntry.update({
       where: { id: entryId, crucibleId: crucible.id },
       data: { score: eloScores[entryId], voteCount: voteCounts[entryId] || 0 }
    })
  ));
}
```

**Actionable:** YES

---

## Major Issues

### 3. Redis `sAdd` Argument Type

**Location:** `src/server/services/crucible.service.ts` (Line ~1091)

**Analysis:**
The code uses `await sysRedis.sAdd(key, [pairKey]);`. Standard `ioredis` (and most Redis wrappers) expects `sadd(key, ...members)` or `sadd(key, member)`. Passing an array `[pairKey]` as the second argument often results in the library trying to stringify the array (resulting in adding a member literally named `"['entry1-entry2']"`) or failing, rather than adding the string inside the array.

**Recommendation:**
Verify the `sysRedis` wrapper implementation. If it wraps `ioredis` directly, change to spread syntax or direct argument.

**Fix:**
```typescript
// If sysRedis supports varargs
const addResult = await sysRedis.sAdd(key, pairKey);
```

**Actionable:** YES (need to verify sysRedis implementation first)

---

### 4. `finalizeCrucible` Batch Update Performance

**Location:** `src/server/services/crucible.service.ts`

**Analysis:**
While the code correctly batches updates into groups of 50, it still executes 50 separate `UPDATE` statements sequentially (or in parallel promises) inside a transaction for every batch. For a 10k entry competition, that is 10,000 DB round trips.

**Recommendation:**
Use `dbWrite.$executeRaw` to perform a bulk update using a `VALUES` list and a `FROM` clause (Postgres specific). This reduces 10,000 queries to ~20 queries (assuming batch size of 500).

**Actionable:** YES

---

## Minor Issues

### 5. Duplicated ELO Logic

**Location:** `src/server/services/crucible-elo.service.ts`

**Analysis:**
The `calculateEloChange` function in TypeScript duplicates the logic found in the Lua script. As noted in the Bug section, they have already drifted apart (Zero-sum vs Individual K).

**Recommendation:**
- If the JS function is only used for UI estimation, rename it to `estimateEloChange`.
- Add a comment linking the two files so developers know that changing one requires changing the other.

**Actionable:** YES (documentation/naming improvement)

---

### 6. Magic Numbers

**Location:** `src/server/schema/crucible.schema.ts`

**Analysis:**
Limits like `1_000_000` (Max Fee) and `10_000` (Entry Limit) are hardcoded.

**Recommendation:**
Move these to a constants file (e.g., `src/server/common/constants.ts`) so they can be reused in error messages or frontend validation.

**Actionable:** YES (code organization improvement)

---

## Summary of Actionable Fixes

| # | Issue | Severity | Fix Required |
|---|-------|----------|--------------|
| 1 | ELO Zero-Sum Logic Mismatch | Critical | Update Lua script to enforce zero-sum with averaged K-factor |
| 2 | Sync Job Transaction Lock | Critical | Remove transaction wrapper, use batched updates |
| 3 | Redis sAdd Argument | Major | Verify wrapper, fix argument passing |
| 4 | Finalization Batch Performance | Major | Use raw SQL bulk update |
| 5 | Duplicated ELO Logic | Minor | Rename function, add linking comments |
| 6 | Magic Numbers | Minor | Extract to constants file |
