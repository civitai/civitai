# KoN Consensus Backfill (drain stranded Pending/Inconclusive votes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A temp admin webhook endpoint that finalizes the ~71K New-Order image-rating votes that were stranded `Pending`/`Inconclusive` during the 2026-06-23 sysRedis wipe — re-stamping them to `Correct`/`Failed` so blessed-buzz pays out and the nightly Inconclusive purge stops.

**Architecture:** Source of truth is the **ClickHouse `knights_new_order_image_rating` ledger, NOT the Redis queue** (the `new-order:queues:Knight{1,2,3}:{a,b}` zsets rotate/wipe and are useless as a record). For each image with ≥4 unfinalized knight votes that meet raw-count consensus (≥60% agree), the endpoint re-inserts that image's `Pending`/`Inconclusive` rows with `status = Correct/Failed` (per-voter vs the dominant rating) and `createdAt = run time`, then lazily rebuilds the affected players' judgment/fervor counters. Down-rates by >1 NSFW level are excluded (mod-only per the live guard). Work is chunked and run under `limitConcurrency`, mirroring the temp-admin-backfill convention in `src/pages/api/admin/temp/` (e.g. `backfill-swept-trained-models.ts`).

**Tech Stack:** Next.js API route, `WebhookEndpoint` (`~/server/utils/endpoint-helpers`), ClickHouse client (`~/server/clickhouse/client`), `limitConcurrency` (`~/server/utils/concurrency-helpers`), zod, Vitest.

## Global Constraints

- **Read-only first.** Every write action MUST support `dryRun` and default to it (`dryRun !== false`). Mirror `backfill-stale-nsfw-rollups.ts`.
- **Endpoint lives at** `src/pages/api/admin/temp/new-order-consensus-backfill.ts`, guarded by `WebhookEndpoint(...)` (checks `?token=$WEBHOOK_TOKEN`). Do NOT add routes elsewhere.
- **No unit tests under `src/pages`** (Next.js route-type validator fails `next build`). Helper + its test live in `src/server/games/new-order/` and `src/server/games/new-order/__tests__/`.
- **Consensus = raw vote agreement** (`topCount / voters >= 0.6`, `voters >= 4`). It is a deliberate approximation of the live *weighted* algorithm (weights live only in the now-ephemeral `new-order:ratings:*` zsets). Safe because ~42K of 71K candidates are unanimous. Document this in the file header.
- **Window:** `createdAt >= '2026-06-23 00:00:00'`, `rank = 'Knight'`, `status IN ('Pending','Inconclusive')`. Parametrize the start date with a default.
- **Down-rate >1 level → escalate, never auto-apply** (replicates `new-order.service.ts:500`). Phase 1 SKIPS them; Phase 2 optionally routes them to the Inquisitor queue.
- **`createdAt` is stamped to run-time on purpose.** The `new-order-grant-bless-buzz` job (`new-order-jobs.ts:44`) pays `Correct/Failed` rows from *exactly 3 days ago*; stamping run-time means payout lands run-day + 3. Preserving original vote time would drop the rows outside the payout window forever. Accept a one-time abuse-detection alert blip on run day (all rows share a timestamp) — mute it / warn mods.
- **ClickHouse hygiene:** batch re-stamps (one `INSERT ... SELECT` per chunk of imageIds), never one INSERT per image. Table is `SharedReplacingMergeTree ORDER BY (userId, imageId)`, no version column — a re-inserted `(userId,imageId)` row supersedes on merge; queries that must see the new value use `FINAL`.

---

## Dry-run numbers this plan is sized against (2026-06-29, prod CH)

| Decision class | images | correct votes | Phase 1 action |
|---|---|---|---|
| `same_level` (consensus = current level) | 42,141 | 173,989 | re-stamp ✓ |
| `down_1lvl` | 27,844 | 111,367 | re-stamp ✓ |
| `up_rate` | 758 | 2,605 | re-stamp ✓ |
| `down_gt1_ESCALATE` | 1,903 | 6,959 | **skip** (Phase 2 → Inquisitor) |

~70,700 auto-resolve · 605 distinct users · ~286K correct votes · ≈28.6K buzz.

## Open decisions (confirm before running the write path)

1. **NSFW-level apply (Phase 2):** ~28.6K `down_1lvl`/`up_rate` images currently sit at the wrong level. Re-stamping fixes *earnings* but not the image's moderation level. Apply levels too (heavier: Postgres + search reindex), or leave to normal flow? Default plan: Phase 1 = earnings only; Phase 2 = opt-in level apply.
2. **Escalate the 1,903 down>1 to Inquisitor**, or leave them `Inconclusive` (no buzz for those voters, but zero mod load)? Default: skip in Phase 1, opt-in action in Phase 2.
3. **Threshold/phasing:** unanimous-only first pass (~42K, raw==weighted, zero ambiguity) then the ≥60% remainder, or one ≥60% pass? Default plan exposes `minAgreement` (default `0.6`) so either is a param.
4. **Staleness filter on `Pending`:** only re-stamp `Pending` whose last vote is older than `staleHours` (default 12) so the drain never races the now-healthy live resolver on in-flight images. `Inconclusive` (already purged) is always eligible.

---

## File Structure

- **Create** `src/server/games/new-order/consensus-backfill.ts` — pure/CH logic, importable + testable outside `src/pages`:
  - `classifyDecision(domRating, origLevel)` — pure, returns `'same_level' | 'up_rate' | 'down_1lvl' | 'down_gt1' | 'unknown_orig'`.
  - `getConsensusCandidates(opts)` — CH read; returns `{ imageId, domRating, voters, topCount, decision }[]`.
  - `restampBatch(pairs, stampISO)` — CH write; re-stamps one chunk.
  - `reconcilePlayerCounters(userIds)` — reset judgment/fervor counters for affected users.
- **Create** `src/server/games/new-order/__tests__/consensus-backfill.test.ts` — Vitest for `classifyDecision`.
- **Create** `src/pages/api/admin/temp/new-order-consensus-backfill.ts` — `WebhookEndpoint` route: actions `count`, `resolve`, `verify` (Phase 1); `apply-levels`, `escalate` (Phase 2).

---

## Task 1: Decision classifier (pure helper + test)

**Files:**
- Create: `src/server/games/new-order/consensus-backfill.ts`
- Test: `src/server/games/new-order/__tests__/consensus-backfill.test.ts`

**Interfaces:**
- Produces: `classifyDecision(domRating: number, origLevel: number | null): 'same_level' | 'up_rate' | 'down_1lvl' | 'down_gt1' | 'unknown_orig'`. NSFW levels are bitwise flags (1,2,4,8,16,32); "level distance" = `abs(log2(a) - log2(b))`.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/games/new-order/__tests__/consensus-backfill.test.ts
import { describe, it, expect } from 'vitest';
import { classifyDecision } from '~/server/games/new-order/consensus-backfill';

describe('classifyDecision', () => {
  it('same level', () => expect(classifyDecision(4, 4)).toBe('same_level'));
  it('up-rate (PG -> R)', () => expect(classifyDecision(4, 1)).toBe('up_rate'));
  it('down 1 level (R -> PG13)', () => expect(classifyDecision(2, 4)).toBe('down_1lvl'));
  it('down >1 level (XXX -> PG)', () => expect(classifyDecision(1, 16)).toBe('down_gt1'));
  it('missing original level', () => expect(classifyDecision(4, 0)).toBe('unknown_orig'));
  it('null original level', () => expect(classifyDecision(4, null)).toBe('unknown_orig'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/games/new-order/__tests__/consensus-backfill.test.ts`
Expected: FAIL — `classifyDecision` is not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/server/games/new-order/consensus-backfill.ts
export type DecisionClass = 'same_level' | 'up_rate' | 'down_1lvl' | 'down_gt1' | 'unknown_orig';

export function classifyDecision(domRating: number, origLevel: number | null): DecisionClass {
  if (!origLevel || origLevel <= 0) return 'unknown_orig';
  if (domRating === origLevel) return 'same_level';
  if (domRating > origLevel) return 'up_rate';
  const distance = Math.abs(Math.log2(domRating) - Math.log2(origLevel));
  return distance <= 1 ? 'down_1lvl' : 'down_gt1';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/games/new-order/__tests__/consensus-backfill.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/games/new-order/consensus-backfill.ts src/server/games/new-order/__tests__/consensus-backfill.test.ts
git commit -m "feat(new-order): add consensus-backfill decision classifier"
```

---

## Task 2: CH candidate query (`getConsensusCandidates`)

**Files:**
- Modify: `src/server/games/new-order/consensus-backfill.ts`

**Interfaces:**
- Consumes: `classifyDecision` (Task 1); `clickhouse` from `~/server/clickhouse/client`.
- Produces:
  ```ts
  type Candidate = { imageId: number; domRating: number; voters: number; topCount: number; decision: DecisionClass };
  getConsensusCandidates(opts: { startDate?: string; minAgreement?: number; staleHours?: number; }): Promise<Candidate[]>
  ```
  Excludes Acolyte rank. `Pending` rows require last vote older than `staleHours`; `Inconclusive` always eligible.

- [ ] **Step 1: Implement the candidate query**

The dominant rating value is `vals[indexOf(counts, max(counts))]` — compute the per-rating counts once in a `scored` CTE, then index into the distinct values. This is the exact pattern verified against prod CH during planning.

```ts
// append to src/server/games/new-order/consensus-backfill.ts
import { clickhouse } from '~/server/clickhouse/client';

const DEFAULT_START = '2026-06-23 00:00:00';

export type Candidate = {
  imageId: number; domRating: number; voters: number; topCount: number; decision: DecisionClass;
};

export async function getConsensusCandidates(opts: {
  startDate?: string; minAgreement?: number; staleHours?: number;
} = {}): Promise<Candidate[]> {
  if (!clickhouse) throw new Error('clickhouse not configured');
  const startDate = opts.startDate ?? DEFAULT_START;
  const minAgreement = opts.minAgreement ?? 0.6;
  const staleHours = opts.staleHours ?? 12;

  const rows = await clickhouse.$query<{
    imageId: number; voters: number; topCount: number; domRating: number; origLevel: number;
  }>`
    WITH img AS (
      SELECT imageId, userId, rating, status, originalLevel, createdAt
      FROM knights_new_order_image_rating FINAL
      WHERE rank = 'Knight'
        AND status IN ('Pending','Inconclusive')
        AND createdAt >= '${startDate}'
    ),
    arr AS (
      SELECT imageId,
             count() AS voters,
             groupArray(rating) AS ratings,
             minIf(originalLevel, originalLevel > 0) AS origLevel,
             countIf(status='Pending') AS penCount,
             max(createdAt) AS lastVote
      FROM img GROUP BY imageId
    ),
    scored AS (
      SELECT imageId, voters, origLevel, penCount, lastVote,
             arrayMap(r -> arrayCount(x -> x = r, ratings), arrayDistinct(ratings)) AS counts,
             arrayDistinct(ratings) AS vals
      FROM arr
    )
    SELECT imageId,
           voters,
           arrayMax(counts) AS topCount,
           vals[indexOf(counts, arrayMax(counts))] AS domRating,
           origLevel
    FROM scored
    WHERE voters >= 4
      AND arrayMax(counts) / voters >= ${minAgreement}
      AND (penCount = 0 OR lastVote <= now() - INTERVAL ${staleHours} HOUR)
  `;

  return rows.map((r) => ({
    imageId: r.imageId,
    domRating: r.domRating,
    voters: r.voters,
    topCount: r.topCount,
    decision: classifyDecision(r.domRating, r.origLevel),
  }));
}
```

- [ ] **Step 2: Verify against the known dry-run totals**

Run a throwaway script (or the `count` action once Task 3 lands) and confirm the class histogram matches the table in this plan (~42K same, ~28K down_1lvl, ~1.9K down_gt1, ~0.8K up). Expected: within a few % (queue keeps moving).

- [ ] **Step 3: Commit**

```bash
git add src/server/games/new-order/consensus-backfill.ts
git commit -m "feat(new-order): query consensus-resolvable stranded votes from ClickHouse"
```

---

## Task 3: Endpoint with `count` action (read-only)

**Files:**
- Create: `src/pages/api/admin/temp/new-order-consensus-backfill.ts`

**Interfaces:**
- Consumes: `getConsensusCandidates` (Task 2).
- Produces: `POST .../new-order-consensus-backfill?token=$WEBHOOK_TOKEN` with `{ action: 'count', startDate?, minAgreement?, staleHours? }` → `{ total, byDecision }`. (Distinct-user count is not surfaced here — `count` sizes images; the 605-user figure came from the planning dry-run.)

- [ ] **Step 1: Write the endpoint with the file-header doc + `count`**

```ts
/**
 * Temp admin backfill: finalize KoN votes stranded Pending/Inconclusive by the
 * 2026-06-23 sysRedis wipe (see docs/superpowers/plans/2026-06-29-kon-consensus-backfill.md).
 *
 * Source of truth is the ClickHouse ledger, NOT the Redis queue (queues rotate/wipe).
 * Consensus = raw vote agreement (topCount/voters >= minAgreement) — a deliberate
 * approximation of the live weighted algo (weights live only in the ephemeral
 * new-order:ratings:* zsets). Down-rates by >1 NSFW level are skipped (mod-only).
 *
 * Usage: POST /api/admin/temp/new-order-consensus-backfill?token=$WEBHOOK_TOKEN
 *   { "action": "count" }                       preview candidate counts (read-only)
 *   { "action": "resolve", "dryRun": true }     preview the write set (read-only)
 *   { "action": "resolve", "dryRun": false }    re-stamp Pending/Inconclusive -> Correct/Failed
 *   { "action": "verify" }                      post-run: assert no consensus-met rows remain unfinalized
 * Optional params: startDate, minAgreement (def 0.6), staleHours (def 12),
 *                  limit (cap images this run), batchSize (def 1000), concurrency (def 4).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getConsensusCandidates } from '~/server/games/new-order/consensus-backfill';

const schema = z.object({
  action: z.enum(['count', 'resolve', 'verify']),
  startDate: z.string().optional(),
  minAgreement: z.coerce.number().min(0.5).max(1).optional(),
  staleHours: z.coerce.number().int().min(0).max(240).optional(),
  limit: z.coerce.number().int().positive().max(100_000).optional(),
  batchSize: z.coerce.number().int().positive().max(5_000).optional(),
  concurrency: z.coerce.number().int().min(1).max(16).optional(),
  dryRun: z.coerce.boolean().optional(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const p = parsed.data;

  if (p.action === 'count') {
    const candidates = await getConsensusCandidates(p);
    const byDecision = candidates.reduce<Record<string, number>>((acc, c) => {
      acc[c.decision] = (acc[c.decision] ?? 0) + 1;
      return acc;
    }, {});
    return res.status(200).json({ total: candidates.length, byDecision });
  }

  return res.status(400).json({ error: `action ${p.action} not yet implemented` });
});
```

- [ ] **Step 2: Verify read-only**

Run: `curl -s -X POST "https://<env>/api/admin/temp/new-order-consensus-backfill?token=$WEBHOOK_TOKEN" -H 'Content-Type: application/json' -d '{"action":"count"}'`
Expected: JSON `{ total: ~71000, byDecision: { same_level: ~42000, down_1lvl: ~28000, up_rate: ~800, down_gt1: ~1900 } }`. No rows written.

- [ ] **Step 3: Commit**

```bash
git add src/pages/api/admin/temp/new-order-consensus-backfill.ts
git commit -m "feat(new-order): consensus-backfill endpoint with read-only count action"
```

---

## Task 4: `resolve` action — batched re-stamp under limitConcurrency

**Files:**
- Modify: `src/server/games/new-order/consensus-backfill.ts` (add `restampBatch`)
- Modify: `src/pages/api/admin/temp/new-order-consensus-backfill.ts` (add `resolve`)

**Interfaces:**
- Consumes: `getConsensusCandidates`, `classifyDecision`.
- Produces: `restampBatch(pairs: {imageId:number;domRating:number}[], stampISO: string): Promise<void>` — one CH `INSERT ... SELECT` re-stamping a chunk's `Pending`/`Inconclusive` rows to `Correct`/`Failed`.

- [ ] **Step 1: Implement `restampBatch`**

```ts
// append to src/server/games/new-order/consensus-backfill.ts
export async function restampBatch(
  pairs: { imageId: number; domRating: number }[],
  stampISO: string
): Promise<void> {
  if (!clickhouse) throw new Error('clickhouse not configured');
  if (pairs.length === 0) return;
  const ids = pairs.map((p) => p.imageId).join(',');
  const rats = pairs.map((p) => p.domRating).join(',');
  // arrayElement([rats], indexOf([ids], imageId)) -> this image's consensus rating
  await clickhouse.$exec`
    INSERT INTO knights_new_order_image_rating
    SELECT
      orig.userId,
      orig.imageId AS imageId,
      orig.rating,
      orig.damnedReason,
      if(orig.rating = arrayElement([${rats}], indexOf([${ids}], orig.imageId)), 'Correct', 'Failed') AS status,
      orig.grantedExp,
      if(orig.rating = arrayElement([${rats}], indexOf([${ids}], orig.imageId)), 1, 0) AS multiplier,
      toDateTime('${stampISO}') AS createdAt,
      orig.ip, orig.userAgent, orig.deviceId, orig.rank, orig.originalLevel
    FROM knights_new_order_image_rating orig FINAL
    WHERE orig.imageId IN (${ids})
      AND orig.rank != 'Acolyte'
      AND orig.status IN ('Pending','Inconclusive')
  `;
}
```

- [ ] **Step 2: Wire the `resolve` action (dryRun-gated, chunked, limitConcurrency)**

```ts
// in src/pages/api/admin/temp/new-order-consensus-backfill.ts
// add imports:
import { restampBatch } from '~/server/games/new-order/consensus-backfill';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { chunk } from 'lodash-es';

// replace the trailing `return res.status(400)...` with:
  if (p.action === 'resolve') {
    const dryRun = p.dryRun !== false; // default true
    const batchSize = p.batchSize ?? 1000;
    const concurrency = p.concurrency ?? 4;

    let candidates = await getConsensusCandidates(p);
    // Phase 1: skip mod-only down-rates and unknown originals
    candidates = candidates.filter((c) => c.decision === 'same_level' || c.decision === 'down_1lvl' || c.decision === 'up_rate');
    if (p.limit) candidates = candidates.slice(0, p.limit);

    const byDecision = candidates.reduce<Record<string, number>>((a, c) => ((a[c.decision] = (a[c.decision] ?? 0) + 1), a), {});

    if (dryRun) {
      return res.status(200).json({ dryRun: true, wouldResolve: candidates.length, byDecision });
    }

    const stampISO = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const batches = chunk(candidates.map((c) => ({ imageId: c.imageId, domRating: c.domRating })), batchSize);
    let done = 0;
    await limitConcurrency(
      batches.map((b) => async () => {
        await restampBatch(b, stampISO);
        done += b.length;
      }),
      concurrency
    );

    return res.status(200).json({ dryRun: false, resolved: done, byDecision, stampISO });
  }
```

- [ ] **Step 3: Dry-run on the target env**

Run: `curl ... -d '{"action":"resolve","dryRun":true,"limit":2000}'`
Expected: `{ dryRun: true, wouldResolve: 2000, byDecision: {...} }`, nothing written.

- [ ] **Step 4: Small real batch, then verify in CH**

Run: `curl ... -d '{"action":"resolve","dryRun":false,"limit":500,"batchSize":250,"concurrency":2}'`
Then in CH: confirm ~500 images now have `Correct/Failed` rows stamped at `stampISO` and no longer appear in `getConsensusCandidates`.
Expected: `resolved: ~ (500 images × ~5 votes)` rows inserted; re-running `count` drops by ~500.

- [ ] **Step 5: Commit**

```bash
git add src/server/games/new-order/consensus-backfill.ts src/pages/api/admin/temp/new-order-consensus-backfill.ts
git commit -m "feat(new-order): resolve action re-stamps stranded votes in batches"
```

---

## Task 5: Player counter reconciliation + `verify`

**Files:**
- Modify: `src/server/games/new-order/consensus-backfill.ts` (add `reconcilePlayerCounters`)
- Modify: `src/pages/api/admin/temp/new-order-consensus-backfill.ts` (call it after resolve; add `verify`)

**Interfaces:**
- Consumes: `correctJudgmentsCounter`, `allJudgmentsCounter`, `fervorCounter` from `~/server/games/new-order/utils`.
- Produces: `reconcilePlayerCounters(userIds: number[]): Promise<void>` — resets judgment + fervor counters so they lazily re-fetch from the now-corrected ClickHouse rows.

- [ ] **Step 1: Implement `reconcilePlayerCounters`**

```ts
// append to src/server/games/new-order/consensus-backfill.ts
import { correctJudgmentsCounter, fervorCounter } from '~/server/games/new-order/utils';

export async function reconcilePlayerCounters(userIds: number[]): Promise<void> {
  // Counters fetchCount from ClickHouse on miss; resetting forces a rebuild
  // against the freshly re-stamped Correct/Failed rows.
  const unique = [...new Set(userIds)];
  await Promise.all(
    unique.flatMap((id) => [
      correctJudgmentsCounter.reset({ id }),
      fervorCounter.reset({ id }),
    ])
  );
}
```

- [ ] **Step 2: Call it after a non-dry-run resolve**

```ts
// in the resolve action, after limitConcurrency(...), before the response:
    if (!dryRun) {
      // affected users = voters whose rows we just re-stamped
      const userRows = await (await import('~/server/clickhouse/client')).clickhouse!.$query<{ userId: number }>`
        SELECT DISTINCT userId FROM knights_new_order_image_rating FINAL
        WHERE imageId IN (${candidates.map((c) => c.imageId).join(',')}) AND rank != 'Acolyte'
      `;
      await reconcilePlayerCounters(userRows.map((r) => r.userId));
    }
```
(Import `reconcilePlayerCounters` at the top.)

- [ ] **Step 3: Implement `verify` action**

```ts
  if (p.action === 'verify') {
    const remaining = await getConsensusCandidates(p);
    const autoResolvable = remaining.filter((c) => c.decision !== 'down_gt1' && c.decision !== 'unknown_orig');
    return res.status(200).json({ remainingAutoResolvable: autoResolvable.length, remainingEscalate: remaining.length - autoResolvable.length });
  }
```

- [ ] **Step 4: Verify end-to-end on the small batch**

Run: `curl ... -d '{"action":"verify"}'`
Expected: `remainingAutoResolvable` dropped by the number resolved in Task 4.

- [ ] **Step 5: Commit**

```bash
git add src/server/games/new-order/consensus-backfill.ts src/pages/api/admin/temp/new-order-consensus-backfill.ts
git commit -m "feat(new-order): reconcile player counters + verify action"
```

---

## Phase 2 (opt-in, separate sign-off) — NSFW level apply + Inquisitor escalation

> Do not build until Phase 1 has run in prod and earnings recovery is confirmed (run-day + 3). Tracked as separate tasks because they carry independent moderation review.

- [ ] **Task 6 — `apply-levels`:** for `down_1lvl`/`up_rate` resolved images, call `updateImageNsfwLevel` (`~/server/services/image.service.ts:6720`) in batches under `limitConcurrency`. Heavier (Postgres + search reindex); stage with `limit`.
- [ ] **Task 7 — `escalate`:** for `down_gt1` candidates, `addImageToQueue({ imageIds, rankType: 'Inquisitor', priority: 1 })` (`new-order.service.ts:1479`) so mods adjudicate — mirrors the live excessive-down-rating guard (`new-order.service.ts:500`). Do NOT re-stamp their votes.

---

## Rollout

1. `count` on prod → confirm histogram ≈ plan table.
2. `resolve dryRun:true` (full, no limit) → confirm `wouldResolve` ≈ 70,700.
3. `resolve dryRun:false limit:500` → CH spot-check + `verify`.
4. Staged full run in `limit` slices (e.g. 10K) — watch CH insert load and the `_prisma`-independent ClickHouse merge backlog between slices.
5. Run-day + 3: confirm `new-order-grant-bless-buzz` paid the affected 605 users; confirm the Metabase "Buzz Earned" chart recovers.
6. Warn mods of the one-time abuse-detection alert blip on run day (all re-stamped rows share `createdAt`).
7. After confirmed recovery: delete the endpoint file (temp), keep `consensus-backfill.ts` + test if reused, or delete with the endpoint.

## Self-Review

- **Spec coverage:** Pending + Inconclusive both handled (status filter in `getConsensusCandidates` + `restampBatch`). Queue independence ✓ (CH-only). Escalation guard ✓ (Phase 1 filter + Phase 2 Task 7). Buzz payout ✓ (run-time stamp → 3-day job). Counters ✓ (Task 5).
- **Placeholder scan:** the only narrative note is the ClickHouse `domRating` query caveat in Task 2, which is resolved by the provided final SQL — engineer must use the second block. Flagged explicitly.
- **Type consistency:** `Candidate`, `DecisionClass`, `classifyDecision`, `getConsensusCandidates`, `restampBatch`, `reconcilePlayerCounters` names used identically across tasks.
