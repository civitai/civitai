# Incremental Image Score Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `update-user-score` cron's `images` category compute incrementally (sum engagement *deltas* since the last run) instead of recomputing every affected owner's entire all-time catalog, so the job finishes in minutes instead of >1h.

**Architecture:** The `images` fetcher stops calling `computeImageScores` (which re-reads each owner's full catalog from the 118M-row `Image` table). Instead it reads the signed per-event delta (`entityMetricEvents_month.metricValue`) for images that changed since the checkpoint, maps those images to owners via Postgres, folds the delta onto each owner's *stored* `images` score, and hands the new absolute value to the existing persist path. A new `force` param on the `backfill-image-scores` endpoint provides an on-demand full recompute (ignores the `imageScoreRecomputedAt` skip-marker) to establish a fresh baseline and reconcile any drift.

**Tech Stack:** TypeScript, Next.js API routes, Postgres (`pgDb` cancellable queries), ClickHouse (`ch.$query`), Vitest.

## Global Constraints

- **Work must scale with changed images (~271K/day), not owner catalog size (tens of millions).** No query in the `images` path may read an owner's full catalog.
- **Correctness model (READ CAREFULLY):** incremental scoring is **not idempotent**. `new = stored + Σ(deltas since checkpoint)`. Re-processing the *same* delta window double-counts. The job stays correct only because (a) the images checkpoint advances after each successful run and (b) the now-fast runtime avoids the connection-timeout cancellation that previously froze the checkpoint. The `force` backfill is the manual reconciler for residual drift (hard-deleted images whose historical engagement stays baked into the owner's stored score). **Do not schedule the backfill** — it is a one-off/manual tool.
- **Baseline invariant:** an owner's stored `images` score must be correct as of the images checkpoint before the incremental job runs. At cutover this is established by a `force` full sweep that also writes the images checkpoint (Task 4). Skipping the cutover sweep leaves scores stale by the 2026-06-23→checkpoint gap forever.
- **`metricValue` is signed** — un-likes / removed comments emit negative events, so summing deltas is arithmetically exact for engagement changes (verified in prod: negatives present for every reaction type + `commentCount`).
- **Multipliers come from `getScoreMultipliers()`** (sysRedis → KeyValue → hardcoded default `{ images: { comments: 20, reactions: 10 } }`). Never hardcode multiplier values in the fetcher.
- Server job tests live in `src/server/__tests__/` (Vitest, `vi.mock`). **Never** put test files under `src/pages`.
- Reaction metric types are exactly `'Like','Heart','Laugh','Cry'`; comment metric type is `'commentCount'`.

## File Structure

- `src/server/jobs/update-user-score.ts` (modify): replace `getImageScore` body with the incremental implementation; add two exported pure helpers (`rollupImageScoreDeltas`, `foldImageDeltasOntoStored`) that hold all the math and carry the unit tests. `computeImageScores` stays exported (still used by the backfill) but is **no longer called by the cron**.
- `src/server/__tests__/update-user-score-image-score.test.ts` (create): unit tests for the two pure helpers + a mocked-`ctx` test of `getImageScore` wiring.
- `src/pages/api/admin/temp/backfill-image-scores.ts` (modify): add `force` param (bypass the `imageScoreRecomputedAt` skip-check, always recompute+stamp); on a full `force` sweep, write the `update-user-score:images` checkpoint for clean handoff to the cron.

---

### Task 1: Pure delta-rollup helpers (math, fully unit-tested)

**Files:**
- Modify: `src/server/jobs/update-user-score.ts` (add two exported functions near `computeImageScores`, ~line 273)
- Test: `src/server/__tests__/update-user-score-image-score.test.ts` (create)

**Interfaces:**
- Produces:
  - `rollupImageScoreDeltas(deltas: ImageEngagementDelta[], ownerByImage: Map<number, number>, multipliers: { reactions: number; comments: number }): Map<number, number>` — per-owner *score delta*. Images absent from `ownerByImage` (deleted / null owner) are skipped.
  - `foldImageDeltasOntoStored(scoreDeltaByUser: Map<number, number>, storedByUser: Map<number, number>): Map<number, number>` — per-owner *new absolute* images score (`stored ?? 0` + `delta ?? 0`).
  - `type ImageEngagementDelta = { imageId: number; dReactions: number; dComments: number }`

- [ ] **Step 1: Write the failing tests**

Create `src/server/__tests__/update-user-score-image-score.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  rollupImageScoreDeltas,
  foldImageDeltasOntoStored,
} from '~/server/jobs/update-user-score';

const mult = { reactions: 10, comments: 20 };

describe('rollupImageScoreDeltas', () => {
  it('rolls per-image deltas up per owner with multipliers', () => {
    const deltas = [
      { imageId: 1, dReactions: 3, dComments: 1 }, // 3*10 + 1*20 = 50
      { imageId: 2, dReactions: 1, dComments: 0 }, // 1*10        = 10
    ];
    const owners = new Map([
      [1, 100],
      [2, 100],
    ]);
    expect(rollupImageScoreDeltas(deltas, owners, mult)).toEqual(new Map([[100, 60]]));
  });

  it('handles negative deltas (un-like / removed comment)', () => {
    const deltas = [{ imageId: 1, dReactions: -2, dComments: -1 }]; // -2*10 + -1*20 = -40
    const owners = new Map([[1, 7]]);
    expect(rollupImageScoreDeltas(deltas, owners, mult)).toEqual(new Map([[7, -40]]));
  });

  it('skips images with no owner (deleted / null userId)', () => {
    const deltas = [
      { imageId: 1, dReactions: 5, dComments: 0 },
      { imageId: 2, dReactions: 9, dComments: 9 }, // no owner entry -> skipped
    ];
    const owners = new Map([[1, 100]]);
    expect(rollupImageScoreDeltas(deltas, owners, mult)).toEqual(new Map([[100, 50]]));
  });

  it('coerces string-typed clickhouse numbers', () => {
    const deltas = [
      { imageId: 1, dReactions: '2' as unknown as number, dComments: '3' as unknown as number },
    ];
    const owners = new Map([[1, 1]]);
    expect(rollupImageScoreDeltas(deltas, owners, mult)).toEqual(new Map([[1, 2 * 10 + 3 * 20]]));
  });
});

describe('foldImageDeltasOntoStored', () => {
  it('adds delta to stored score', () => {
    const delta = new Map([[1, 50], [2, -10]]);
    const stored = new Map([[1, 1000], [2, 30]]);
    expect(foldImageDeltasOntoStored(delta, stored)).toEqual(new Map([[1, 1050], [2, 20]]));
  });

  it('treats a missing stored score as 0 (new owner)', () => {
    const delta = new Map([[5, 40]]);
    const stored = new Map<number, number>();
    expect(foldImageDeltasOntoStored(delta, stored)).toEqual(new Map([[5, 40]]));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/server/__tests__/update-user-score-image-score.test.ts`
Expected: FAIL — `rollupImageScoreDeltas`/`foldImageDeltasOntoStored` are not exported.

- [ ] **Step 3: Implement the helpers**

In `src/server/jobs/update-user-score.ts`, add after `computeImageScores` (after line ~273):

```ts
export type ImageEngagementDelta = { imageId: number; dReactions: number; dComments: number };

// Roll per-image engagement deltas up per owner. Images missing from
// `ownerByImage` (deleted, or null userId) are dropped — their owner can't be
// credited, which also keeps deleted-image engagement out of the delta window.
export function rollupImageScoreDeltas(
  deltas: ImageEngagementDelta[],
  ownerByImage: Map<number, number>,
  multipliers: { reactions: number; comments: number }
): Map<number, number> {
  const byUser = new Map<number, number>();
  for (const { imageId, dReactions, dComments } of deltas) {
    const userId = ownerByImage.get(imageId);
    if (!userId) continue;
    const delta = Number(dReactions) * multipliers.reactions + Number(dComments) * multipliers.comments;
    byUser.set(userId, (byUser.get(userId) ?? 0) + delta);
  }
  return byUser;
}

// New absolute images score = stored (or 0) + this run's delta. Keeps `images`
// in the shared absolute-score persist path so `total` is recomputed there.
export function foldImageDeltasOntoStored(
  scoreDeltaByUser: Map<number, number>,
  storedByUser: Map<number, number>
): Map<number, number> {
  const result = new Map<number, number>();
  for (const [userId, delta] of scoreDeltaByUser) {
    result.set(userId, (storedByUser.get(userId) ?? 0) + delta);
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/server/__tests__/update-user-score-image-score.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/jobs/update-user-score.ts src/server/__tests__/update-user-score-image-score.test.ts
git commit -m "feat(update-user-score): add pure image-score delta-rollup helpers"
```

---

### Task 2: Rewrite `getImageScore` to be incremental

**Files:**
- Modify: `src/server/jobs/update-user-score.ts:161-208` (replace `getImageScore` body)
- Test: `src/server/__tests__/update-user-score-image-score.test.ts` (append a mocked-`ctx` wiring test)

**Interfaces:**
- Consumes: `rollupImageScoreDeltas`, `foldImageDeltasOntoStored`, `ImageEngagementDelta` (Task 1); `ctx.ch.$query`, `ctx.pg.cancellableQuery`, `ctx.setScore`, `ctx.scoreMultipliers.images`, `ctx.lastUpdate`, `ctx.jobContext.on`.
- Produces: `export async function getImageScore(ctx: Context): Promise<void>` (exported for the wiring test).

- [ ] **Step 1: Write the failing wiring test**

Append to `src/server/__tests__/update-user-score-image-score.test.ts`:

```ts
import { getImageScore } from '~/server/jobs/update-user-score';

function fakeQuery<T>(rows: T[]) {
  return { result: async () => rows, cancel: async () => undefined };
}

describe('getImageScore (incremental wiring)', () => {
  it('folds CH deltas onto stored scores and calls setScore with absolute values', async () => {
    const setCalls: Array<[number, string, number]> = [];
    // pg is called twice: (1) image->owner map, (2) stored image scores.
    let pgCall = 0;
    const ctx = {
      ch: {
        $query: async () => [
          { imageId: 10, dReactions: 3, dComments: 0 }, // owner 100
          { imageId: 11, dReactions: 0, dComments: 1 }, // owner 100
          { imageId: 12, dReactions: 5, dComments: 0 }, // owner 200
        ],
      },
      pg: {
        cancellableQuery: async () => {
          pgCall += 1;
          if (pgCall === 1)
            return fakeQuery([
              { id: 10, userId: 100 },
              { id: 11, userId: 100 },
              { id: 12, userId: 200 },
            ]);
          return fakeQuery([
            { id: 100, images: '1000' },
            { id: 200, images: null },
          ]);
        },
      },
      jobContext: { on: () => undefined },
      scoreMultipliers: { images: { reactions: 10, comments: 20 } },
      lastUpdate: new Date(0),
      setScore: (id: number, category: string, score: number) =>
        setCalls.push([id, category, score]),
    } as unknown as Parameters<typeof getImageScore>[0];

    await getImageScore(ctx);

    // owner 100: (3*10 + 1*20) = 50 onto stored 1000 -> 1050
    // owner 200: (5*10)        = 50 onto stored 0    -> 50
    const map = new Map(setCalls.map(([id, , score]) => [id, score]));
    expect(setCalls.every(([, cat]) => cat === 'images')).toBe(true);
    expect(map.get(100)).toBe(1050);
    expect(map.get(200)).toBe(50);
  });

  it('no-ops when there are no engagement deltas', async () => {
    const setCalls: unknown[] = [];
    const ctx = {
      ch: { $query: async () => [] },
      pg: { cancellableQuery: async () => fakeQuery([]) },
      jobContext: { on: () => undefined },
      scoreMultipliers: { images: { reactions: 10, comments: 20 } },
      lastUpdate: new Date(0),
      setScore: () => setCalls.push(1),
    } as unknown as Parameters<typeof getImageScore>[0];

    await getImageScore(ctx);
    expect(setCalls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/__tests__/update-user-score-image-score.test.ts`
Expected: FAIL — `getImageScore` not exported / still runs the old catalog path (would call `ch.$query` with the wrong shape and never fold onto stored scores).

- [ ] **Step 3: Replace `getImageScore`**

Replace the whole `getImageScore` function (`src/server/jobs/update-user-score.ts:161-208`) with:

```ts
// Incremental image score: fold each affected owner's engagement DELTA since the
// last run onto their stored `images` score. Work scales with the images that
// changed (~hundreds of thousands/day), NOT with each owner's full catalog (the
// old full-recompute read tens of millions of `Image` rows nightly and timed the
// job out). NOT idempotent — see the plan's correctness model; the images
// checkpoint must advance each run, and `backfill-image-scores?force=true`
// reconciles drift. `computeImageScores` (below) is kept for that backfill.
export async function getImageScore(ctx: Context) {
  // 1. Net engagement delta per image since the checkpoint. `metricValue` is
  // signed (un-likes/removed comments are negative), so this is the exact change
  // in each image's reaction/comment totals — no catalog read needed.
  const deltas = await ctx.ch.$query<ImageEngagementDelta>`
    SELECT entityId AS imageId,
      sumIf(metricValue, metricType IN ('Like', 'Heart', 'Laugh', 'Cry')) AS dReactions,
      sumIf(metricValue, metricType = 'commentCount') AS dComments
    FROM entityMetricEvents_month
    WHERE entityType = 'Image'
    AND metricType IN ('Like', 'Heart', 'Laugh', 'Cry', 'commentCount')
    AND createdAt > ${ctx.lastUpdate}
    GROUP BY entityId
    HAVING dReactions != 0 OR dComments != 0
  `;
  if (!deltas.length) return;

  // 2. Changed image -> owner (Postgres is authoritative; deleted images and null
  // owners drop out here and are skipped by the rollup).
  const ownerByImage = new Map<number, number>();
  for (const batch of chunk(deltas, 10000)) {
    const ids = batch.map((d) => d.imageId);
    const query = await ctx.pg.cancellableQuery<{ id: number; userId: number }>(
      `SELECT id, "userId" FROM "Image" WHERE id = ANY($1::int[]) AND "userId" IS NOT NULL`,
      [ids]
    );
    ctx.jobContext.on('cancel', query.cancel);
    for (const { id, userId } of await query.result()) ownerByImage.set(id, userId);
  }

  // 3. Roll deltas up per owner.
  const scoreDeltaByUser = rollupImageScoreDeltas(deltas, ownerByImage, ctx.scoreMultipliers.images);
  if (!scoreDeltaByUser.size) return;

  // 4. Fold each delta onto the owner's stored images score -> new absolute value,
  // handed to the shared persist path (which recomputes `total`).
  const userIds = [...scoreDeltaByUser.keys()];
  for (const ids of chunk(userIds, 5000)) {
    const query = await ctx.pg.cancellableQuery<{ id: number; images: string | null }>(
      `SELECT id, (meta->'scores'->>'images') AS images FROM "User" WHERE id = ANY($1::int[])`,
      [ids]
    );
    ctx.jobContext.on('cancel', query.cancel);
    const stored = new Map<number, number>();
    for (const { id, images } of await query.result()) stored.set(id, images ? Number(images) : 0);

    const partialDelta = new Map(ids.map((id) => [id, scoreDeltaByUser.get(id) ?? 0]));
    for (const [userId, score] of foldImageDeltasOntoStored(partialDelta, stored)) {
      ctx.setScore(userId, 'images', score);
    }
  }
}
```

Then delete the now-dead `ImageScoreDeps`/`computeImageScores` **only if** nothing else imports them. **Do not delete** — `backfill-image-scores.ts` imports `computeImageScores`? (It imports `applyUserScoreUpdates` + `getScoreMultipliers`, not `computeImageScores`.) Verify with:

```bash
grep -rn "computeImageScores" src/
```

If the only remaining reference is the definition itself, leave it exported (harmless, and it is the reference implementation the backfill mirrors). Do not remove it in this task — keep the diff focused.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/server/__tests__/update-user-score-image-score.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Typecheck the job file**

Run: `pnpm run typecheck`
Expected: no new errors in `update-user-score.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/server/jobs/update-user-score.ts src/server/__tests__/update-user-score-image-score.test.ts
git commit -m "feat(update-user-score): compute image score incrementally from engagement deltas"
```

---

### Task 3: `force` param on `backfill-image-scores` (bypass skip-marker)

**Files:**
- Modify: `src/pages/api/admin/temp/backfill-image-scores.ts` (schema ~line 45-52; write loop ~line 119-152)

**Interfaces:**
- Produces: query param `force` (booleanString, default `false`). When `true`, every owner is recomputed and re-stamped regardless of an existing `imageScoreRecomputedAt`.

- [ ] **Step 1: Add `force` to the schema**

In `src/pages/api/admin/temp/backfill-image-scores.ts`, extend the zod schema (after the `dryRun` line, ~line 51):

```ts
  // preview: scan + count owners, write nothing.
  dryRun: booleanString().default(true),
  // full sweep: recompute + re-stamp EVERY owner, ignoring imageScoreRecomputedAt.
  // Use to establish a fresh baseline / reconcile drift for the incremental cron.
  force: booleanString().default(false),
```

- [ ] **Step 2: Bypass the skip-check when `force`**

Replace the stamped-skip block inside the `writeTasks` map (currently ~line 121-130):

```ts
    // Always skip owners already backfilled — they're computed, and skipping makes
    // a re-run resume (only fills in the rest) instead of redoing finished users.
    const stamped = await pgDbRead
      .cancellableQuery<{ id: number }>(
        `SELECT id FROM "User" WHERE id = ANY($1::int[]) AND (meta->'scores'->>'imageScoreRecomputedAt') IS NOT NULL`,
        [batch.map(([userId]) => userId)]
      )
      .then((q) => q.result());
    const skip = new Set(stamped.map((s) => s.id));
    const todo = batch.filter(([userId]) => !skip.has(userId));
    if (!todo.length) return;
```

with:

```ts
    // Default: skip owners already backfilled, so a re-run resumes (fills in the
    // rest) instead of redoing finished users. force=true recomputes EVERYONE
    // (fresh baseline / drift reconcile for the incremental cron).
    let todo = batch;
    if (!params.force) {
      const stamped = await pgDbRead
        .cancellableQuery<{ id: number }>(
          `SELECT id FROM "User" WHERE id = ANY($1::int[]) AND (meta->'scores'->>'imageScoreRecomputedAt') IS NOT NULL`,
          [batch.map(([userId]) => userId)]
        )
        .then((q) => q.result());
      const skip = new Set(stamped.map((s) => s.id));
      todo = batch.filter(([userId]) => !skip.has(userId));
    }
    if (!todo.length) return;
```

- [ ] **Step 3: Reflect `force` in the response + top-of-file doc**

Update the final response (`~line 155`) so a full sweep is observable:

```ts
  res.status(200).json({ finished: true, force: params.force, owners: owners.size, written });
```

Add to the block comment's run examples (after the existing GET example, ~line 33):

```
 *   full re-sweep (ignore prior stamps, recompute everyone):
 *     GET /api/admin/temp/backfill-image-scores?token=$WEBHOOK_TOKEN&dryRun=false&force=true
```

- [ ] **Step 4: Typecheck**

Run: `pnpm run typecheck`
Expected: no new errors in `backfill-image-scores.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/pages/api/admin/temp/backfill-image-scores.ts
git commit -m "feat(backfill-image-scores): add force param to recompute every owner"
```

---

### Task 4: Full-sweep writes the images checkpoint (clean handoff to the cron)

**Files:**
- Modify: `src/pages/api/admin/temp/backfill-image-scores.ts` (imports ~line 6; capture start time ~line 54; write checkpoint after phase 2 ~line 152)

**Interfaces:**
- Consumes: `dbWrite` (Prisma), the job's checkpoint key convention `update-user-score:images` (see `getJobDate` in `src/server/jobs/job.ts` — value is `Date.getTime()` stored on `KeyValue`).
- Produces: on a full `force` sweep (`force && !dryRun && start === 0 && end === undefined`), sets `KeyValue['update-user-score:images']` = the sweep's start time so the cron resumes from exactly there (no gap, no double-count).

- [ ] **Step 1: Import `dbWrite` and capture the sweep start**

Extend the db-client import (`~line 6`):

```ts
import { dbRead, dbWrite } from '~/server/db/client';
```

Capture a checkpoint timestamp at the very top of the handler, before the phase-1 scan (right after `console.time('BACKFILL_IMAGE_SCORES');`, ~line 59):

```ts
  // Checkpoint the cron will resume from after a full sweep. Taken BEFORE the scan
  // so no engagement between here and the write is missed by the incremental job
  // (a few duplicate events during the sweep are harmless vs. missing any).
  const sweepStartedAt = new Date();
```

- [ ] **Step 2: Write the checkpoint after a full force sweep**

After `await limitConcurrency(writeTasks, params.concurrency);` and before `console.timeEnd(...)` (~line 153), add:

```ts
  // Hand off to the incremental cron: only after a genuine FULL sweep (force,
  // real writes, whole id range) is every stored score correct as of
  // sweepStartedAt, so the cron can safely sum deltas from there. A partial or
  // resume run must NOT advance the checkpoint (it would skip un-swept owners).
  const fullSweep = params.force && !params.dryRun && params.start === 0 && params.end === undefined;
  if (fullSweep) {
    await dbWrite.keyValue.upsert({
      where: { key: 'update-user-score:images' },
      create: { key: 'update-user-score:images', value: sweepStartedAt.getTime() },
      update: { value: sweepStartedAt.getTime() },
    });
  }
```

- [ ] **Step 3: Surface it in the response**

Update the final response (`~line 155`):

```ts
  res.status(200).json({
    finished: true,
    force: params.force,
    checkpointSet: fullSweep ? sweepStartedAt.toISOString() : null,
    owners: owners.size,
    written,
  });
```

- [ ] **Step 4: Typecheck**

Run: `pnpm run typecheck`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/api/admin/temp/backfill-image-scores.ts
git commit -m "feat(backfill-image-scores): full force sweep sets update-user-score:images checkpoint"
```

---

### Task 5: Cutover runbook (operational — no code, gated on merge/deploy)

**Files:** none. This documents the manual cutover; execute only after Tasks 1-4 are merged and deployed to the environment being cut over.

**Why:** stored `images` scores are truth as of the 2026-06-23 backfill (+ a 4,273-owner top-up on 2026-07-11) — the cron has been dead since ~06-22, so 06-23→now engagement is not in any stored score. The incremental cron only *adds forward* from its checkpoint, so it will not fill that gap on its own. The cutover sweep resets the baseline and sets the checkpoint.

- [ ] **Step 1: Confirm deploy.** The env running the cron includes Tasks 1-4.

- [ ] **Step 2: Dry-run the full sweep (sanity on owner count).**

```
GET /api/admin/temp/backfill-image-scores?token=$WEBHOOK_TOKEN&dryRun=true&force=true
```
Expect `{ dryRun: true, owners: <~400k+>, written: 0 }`.

- [ ] **Step 3: Run the real full sweep** (drive from the no-timeout dev server per the endpoint's own header; keep the client connected — `nohup`/`screen`):

```
GET /api/admin/temp/backfill-image-scores?token=$WEBHOOK_TOKEN&dryRun=false&force=true
```
Expect `{ finished: true, force: true, checkpointSet: "<ISO>", owners, written }`.

- [ ] **Step 4: Verify the checkpoint was set** (postgres-query skill, replica):

```sql
SELECT value, to_timestamp((value)::double precision/1000) AT TIME ZONE 'UTC'
FROM "KeyValue" WHERE key = 'update-user-score:images';
```
Expect the `checkpointSet` time from Step 3.

- [ ] **Step 5: Trigger the cron once and confirm it finishes fast and clean.**

Trigger `update-user-score` (mod/testing path). Confirm in Axiom (`['civitai-prod'] | where name == 'update-user-score'`): **no** `job-error` for the run, and the images checkpoint advanced past the sweep time:

```sql
SELECT to_timestamp((value)::double precision/1000) AT TIME ZONE 'UTC'
FROM "KeyValue" WHERE key = 'update-user-score:images';
```
Expect a timestamp at/after the trigger. If it advanced, the incremental path completed within the connection budget.

- [ ] **Step 6: Update the ClickUp task** (868kb9u4m) with the cutover result and close out the "second failure mode" note.

---

## Self-Review

- **Spec coverage:** incremental image fetcher (Tasks 1-2), `force` param bypassing the skip-marker + re-stamping (Task 3), full sweep + future re-sweep capability (Tasks 3-4), no scheduled reconcile (backfill stays manual — Global Constraints), cutover to fix the stale baseline (Task 5). Covered.
- **Placeholder scan:** none — every code step shows the full code.
- **Type consistency:** `ImageEngagementDelta` defined in Task 1, consumed in Task 2; `rollupImageScoreDeltas`/`foldImageDeltasOntoStored` signatures identical across tasks; checkpoint key string `update-user-score:images` matches the cron's `${jobKey}:${category}` (`jobKey = 'update-user-score'`, category `images`).
- **Known residual drift (accepted, per user steer):** hard-deleted images leave historical engagement baked into stored scores; corrected on demand by `force=true`. Documented in Global Constraints.
