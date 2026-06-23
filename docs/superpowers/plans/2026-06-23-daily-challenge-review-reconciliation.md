# Daily Challenge Reconciliation + Pending-Review Badge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Back-pay daily-challenge participation prizes to users whose entries get rated *after* the challenge completes, and show entry owners a "Pending review" badge on their still-under-review entries.

**Architecture:** Workstream A adds an idempotent reconciliation pass to the existing hourly `challenge-completion` cron that re-runs the normal review promotion over recently-completed challenges and pays newly-eligible users. Workstream B surfaces `CollectionItem.status` from the image feed query and renders an owner-only badge. The two workstreams are independent and can ship/merge separately.

**Tech Stack:** Next.js 14, TypeScript, Prisma + raw Postgres SQL, tRPC, Mantine v7, Tailwind, Vitest, cron jobs (`createJob`), Buzz service, Flipt.

## Global Constraints

- Spec: `docs/features/daily-challenge-review-reconciliation.md`. Read it before starting.
- **Never pay for an unrated entry.** Eligibility always requires a real `ACCEPTED` state; the promotion SQL must keep skipping `Image."nsfwLevel" = 0`.
- **Never re-pick or re-judge winners** after completion.
- **Idempotent:** Buzz key is `challenge-entry-prize-${challengeId}-${userId}`; never double-pay or double-notify.
- Test runner is **Vitest**: `pnpm vitest run <path>` (NOT Jest).
- **Do NOT** put test files under `src/pages` (Next.js treats them as routes; `next build` fails). Backend tests live in `src/server/games/daily-challenge/__tests__/` or beside existing `*.test.ts` in `src/server/games/daily-challenge/`.
- **Do NOT** run `prisma migrate deploy` / `resolve`. No SQL migration is needed here (metadata is JSON).
- Do not run `prettier` or `typecheck`/`lint` manually unless asked — editor diagnostics suffice (per project preferences).
- Feature gate: the `challenge-completion` job already checks `FLIPT_FEATURE_FLAGS.CHALLENGE_PLATFORM_ENABLED`; the new pass inherits it.
- Branch off `main`. No stacked PRs.

---

## File Structure

**Workstream A (backend)**
- Modify: `src/server/schema/challenge.schema.ts` — add `reconciliation` to metadata schema.
- Create: `src/server/games/daily-challenge/challenge-rewards.ts` — extracted reusable helpers (`promoteChallengeEntries`, `distributeParticipationPrizes`, pure `selectPayableUsers`) + `reconcileCompletedChallenge`.
- Modify: `src/server/jobs/daily-challenge-processing.ts` — call the extracted helpers in `reviewEntriesForChallenge` and `pickWinnersForChallenge` (no behavior change).
- Modify: `src/server/games/daily-challenge/daily-challenge.utils.ts` — add `getChallengesToReconcile()` selector.
- Modify: `src/server/jobs/challenge-completion.ts` — wire the reconciliation pass into the hourly job.
- Create: `src/pages/api/testing/challenge-reconcile.ts` — guarded debug endpoint to run reconciliation for one challenge.
- Create: `src/server/games/daily-challenge/__tests__/challenge-rewards.test.ts` — Vitest for pure logic + metadata.

**Workstream B (frontend)**
- Modify: `src/server/services/image.service.ts` — expose `collectionItemStatus`.
- Create: `src/components/Image/Infinite/pending-review-badge.utils.ts` — pure `shouldShowPendingReviewBadge`.
- Create: `src/components/Image/Infinite/__tests__/pending-review-badge.utils.test.ts` — Vitest.
- Modify: `src/components/Image/Infinite/ImagesCard.tsx` — render the badge.

---

# Workstream A — Reconciliation

### Task A1: Extend challenge metadata schema with `reconciliation`

**Files:**
- Modify: `src/server/schema/challenge.schema.ts:90-105`
- Test: `src/server/games/daily-challenge/__tests__/challenge-rewards.test.ts`

**Interfaces:**
- Produces: `ChallengeMetadata.reconciliation?: { paidUserIds?: number[]; lastRunAt?: string; done?: boolean }`, parsed by the existing `parseChallengeMetadata`.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/games/daily-challenge/__tests__/challenge-rewards.test.ts
import { describe, it, expect } from 'vitest';
import { parseChallengeMetadata } from '~/server/schema/challenge.schema';

describe('parseChallengeMetadata reconciliation', () => {
  it('round-trips the reconciliation field', () => {
    const parsed = parseChallengeMetadata({
      reconciliation: { paidUserIds: [1, 2], lastRunAt: '2026-06-23T05:00:00.000Z', done: false },
    });
    expect(parsed.reconciliation?.paidUserIds).toEqual([1, 2]);
    expect(parsed.reconciliation?.done).toBe(false);
  });

  it('defaults reconciliation to undefined when absent', () => {
    expect(parseChallengeMetadata({ themeElements: ['a'] }).reconciliation).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/games/daily-challenge/__tests__/challenge-rewards.test.ts`
Expected: FAIL — `reconciliation` is stripped by the schema (undefined in first test).

- [ ] **Step 3: Add the field to the schema**

In `src/server/schema/challenge.schema.ts`, inside `challengeMetadataSchema = z.object({ ... })`, add:

```ts
    reconciliation: z
      .object({
        paidUserIds: z.array(z.number()).optional(),
        lastRunAt: z.string().optional(),
        done: z.boolean().optional(),
      })
      .optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/games/daily-challenge/__tests__/challenge-rewards.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/schema/challenge.schema.ts src/server/games/daily-challenge/__tests__/challenge-rewards.test.ts
git commit -m "feat(challenges): add reconciliation field to challenge metadata schema"
```

---

### Task A2: Pure `selectPayableUsers` helper

**Files:**
- Create: `src/server/games/daily-challenge/challenge-rewards.ts`
- Test: `src/server/games/daily-challenge/__tests__/challenge-rewards.test.ts`

**Interfaces:**
- Produces: `selectPayableUsers(qualifierIds: number[], excludeUserIds: number[]): number[]` — qualifiers minus excluded, de-duplicated, order-preserving.

- [ ] **Step 1: Write the failing test**

```ts
// append to challenge-rewards.test.ts
import { selectPayableUsers } from '~/server/games/daily-challenge/challenge-rewards';

describe('selectPayableUsers', () => {
  it('removes excluded users (winners ∪ already-paid)', () => {
    expect(selectPayableUsers([1, 2, 3, 4], [2, 4])).toEqual([1, 3]);
  });
  it('returns empty when all excluded', () => {
    expect(selectPayableUsers([1, 2], [1, 2, 3])).toEqual([]);
  });
  it('de-duplicates qualifiers', () => {
    expect(selectPayableUsers([1, 1, 2], [])).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/games/daily-challenge/__tests__/challenge-rewards.test.ts`
Expected: FAIL — module/function does not exist.

- [ ] **Step 3: Create the file with the pure helper**

```ts
// src/server/games/daily-challenge/challenge-rewards.ts
export function selectPayableUsers(qualifierIds: number[], excludeUserIds: number[]): number[] {
  const exclude = new Set(excludeUserIds);
  const seen = new Set<number>();
  const result: number[] = [];
  for (const id of qualifierIds) {
    if (exclude.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/games/daily-challenge/__tests__/challenge-rewards.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/games/daily-challenge/challenge-rewards.ts src/server/games/daily-challenge/__tests__/challenge-rewards.test.ts
git commit -m "feat(challenges): add pure selectPayableUsers reward-eligibility helper"
```

---

### Task A3: Extract `promoteChallengeEntries` SQL helper + reuse in live job

**Files:**
- Modify: `src/server/games/daily-challenge/challenge-rewards.ts`
- Modify: `src/server/jobs/daily-challenge-processing.ts:636-662`

**Interfaces:**
- Produces:
  ```ts
  promoteChallengeEntries(args: {
    collectionId: number;
    allowedNsfwLevel: number;
    modelVersionIds: number[];
    challengeDate: Date;
    reviewerId: number;
  }): Promise<number> // count of CollectionItems updated
  ```
- Consumes: `dbWrite`, `Prisma` from `~/server/db/client` / `@prisma/client`.

> No new behavior. This is a pure extraction of the existing review-promotion SQL so the
> reconciliation pass can call the exact same logic. Verified by existing job behavior being
> unchanged (manual/integration; the SQL is identical to `daily-challenge-processing.ts:636-662`).

- [ ] **Step 1: Add the helper (move the SQL verbatim)**

Append to `src/server/games/daily-challenge/challenge-rewards.ts`:

```ts
import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';

export async function promoteChallengeEntries(args: {
  collectionId: number;
  allowedNsfwLevel: number;
  modelVersionIds: number[];
  challengeDate: Date;
  reviewerId: number;
}): Promise<number> {
  const { collectionId, allowedNsfwLevel, modelVersionIds, challengeDate, reviewerId } = args;
  const hasModelVersionRestriction = modelVersionIds.length > 0;

  return dbWrite.$executeRaw`
    WITH source AS (
      SELECT
        i.id,
        (i."nsfwLevel" & ${allowedNsfwLevel}) > 0 as "isSafe",
        ${
          hasModelVersionRestriction
            ? Prisma.sql`EXISTS (SELECT 1 FROM "ImageResourceNew" ir WHERE ir."modelVersionId" = ANY(${modelVersionIds}) AND ir."imageId" = i.id)`
            : Prisma.sql`true`
        } as "hasResource",
        i."createdAt" >= ${challengeDate} as "isRecent"
      FROM "CollectionItem" ci
      JOIN "Image" i ON i.id = ci."imageId"
      WHERE ci."collectionId" = ${collectionId}
        AND ci.status = 'REVIEW'
        AND i."nsfwLevel" != 0
    )
    UPDATE "CollectionItem" ci SET
      status = CASE
        WHEN "isSafe" AND "hasResource" AND "isRecent" THEN 'ACCEPTED'::"CollectionItemStatus"
        ELSE 'REJECTED'::"CollectionItemStatus"
      END,
      "reviewedAt" = now(),
      "reviewedById" = ${reviewerId}
    FROM source s
    WHERE s.id = ci."imageId";
  `;
}
```

- [ ] **Step 2: Replace the inline SQL in `reviewEntriesForChallenge`**

In `src/server/jobs/daily-challenge-processing.ts`, replace the `const reviewedCount = await dbWrite.$executeRaw\`...\`;` block at lines 636-662 with:

```ts
  const reviewedCount = await promoteChallengeEntries({
    collectionId: currentChallenge.collectionId,
    allowedNsfwLevel,
    modelVersionIds: currentChallenge.modelVersionIds,
    challengeDate: currentChallenge.date,
    reviewerId: judgingConfig.userId,
  });
```

Add the import at the top of the file:

```ts
import { promoteChallengeEntries } from '~/server/games/daily-challenge/challenge-rewards';
```

- [ ] **Step 3: Verify no behavior change via editor diagnostics**

Confirm the file type-checks in the editor (no red diagnostics on the changed lines). The SQL is byte-for-byte the original, only the inputs are now parameters.

- [ ] **Step 4: Commit**

```bash
git add src/server/games/daily-challenge/challenge-rewards.ts src/server/jobs/daily-challenge-processing.ts
git commit -m "refactor(challenges): extract promoteChallengeEntries helper (no behavior change)"
```

---

### Task A4: Extract `distributeParticipationPrizes` helper + reuse in final path

**Files:**
- Modify: `src/server/games/daily-challenge/challenge-rewards.ts`
- Modify: `src/server/jobs/daily-challenge-processing.ts:1219-1267`

**Interfaces:**
- Consumes: `selectPayableUsers` (Task A2), `createBuzzTransactionMany`, `createNotification`, `withRetries`, `TransactionType`, `NotificationCategory`, `dbRead`.
- Produces:
  ```ts
  distributeParticipationPrizes(args: {
    challengeId: number;
    collectionId: number;
    title: string;
    entryPrize: { buzz: number; points: number };
    entryPrizeRequirement: number;
    excludeUserIds: number[]; // winners ∪ already-paid
    notificationKey: string;
  }): Promise<number[]> // user IDs paid this call
  ```

> Behavior-preserving for the final path: with `excludeUserIds = winnerUserIds` and
> `notificationKey = challenge-participation:{id}:final`, this reproduces section 6 exactly,
> and additionally returns the paid IDs (used by callers to persist `paidUserIds`).

- [ ] **Step 1: Add the helper**

Append to `src/server/games/daily-challenge/challenge-rewards.ts`:

```ts
import { dbRead } from '~/server/db/client';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { createNotification } from '~/server/services/notification.service';
import { withRetries } from '~/server/utils/errorHandling';
import { TransactionType } from '~/server/schema/buzz.schema';
import { NotificationCategory } from '~/server/common/enums';

export async function distributeParticipationPrizes(args: {
  challengeId: number;
  collectionId: number;
  title: string;
  entryPrize: { buzz: number; points: number };
  entryPrizeRequirement: number;
  excludeUserIds: number[];
  notificationKey: string;
}): Promise<number[]> {
  const {
    challengeId,
    collectionId,
    title,
    entryPrize,
    entryPrizeRequirement,
    excludeUserIds,
    notificationKey,
  } = args;

  if (!entryPrize || entryPrize.buzz <= 0) return [];

  const earned = await dbRead.$queryRaw<{ userId: number }[]>`
    SELECT i."userId"
    FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    WHERE ci."collectionId" = ${collectionId}
      AND ci.status = 'ACCEPTED'
    GROUP BY i."userId"
    HAVING COUNT(*) >= ${entryPrizeRequirement}
  `;

  const payUserIds = selectPayableUsers(
    earned.map((e) => e.userId),
    excludeUserIds
  );
  if (payUserIds.length === 0) return [];

  await withRetries(() =>
    createBuzzTransactionMany(
      payUserIds.map((userId) => ({
        type: TransactionType.Reward,
        toAccountId: userId,
        fromAccountId: 0,
        amount: entryPrize.buzz,
        description: `Challenge Entry Prize: ${title}`,
        externalTransactionId: `challenge-entry-prize-${challengeId}-${userId}`,
        toAccountType: 'blue',
      }))
    )
  );

  await createNotification({
    type: 'challenge-participation',
    category: NotificationCategory.System,
    key: notificationKey,
    userIds: payUserIds,
    details: { challengeId, challengeName: title, prize: entryPrize.buzz },
  });

  return payUserIds;
}
```

> Verify the exact import path of `withRetries`, `TransactionType`, and `NotificationCategory`
> against `daily-challenge-processing.ts`'s existing imports and copy them verbatim if these differ.

- [ ] **Step 2: Replace the inline section-6 block in `pickWinnersForChallenge`**

In `src/server/jobs/daily-challenge-processing.ts`, replace the entire `// 6. Distribute entry participation prizes` block (lines 1219-1267) with:

```ts
    // 6. Distribute entry participation prizes
    const participationKeyId = currentChallenge.challengeId ?? currentChallenge.collectionId;
    const paidParticipants = await distributeParticipationPrizes({
      challengeId: currentChallenge.challengeId,
      collectionId: currentChallenge.collectionId,
      title: currentChallenge.title,
      entryPrize: currentChallenge.entryPrize,
      entryPrizeRequirement: currentChallenge.entryPrizeRequirement,
      excludeUserIds: winningEntries.map((e) => e.userId),
      notificationKey: `challenge-participation:${participationKeyId}:final`,
    });
    log('Entry participation prizes sent:', paidParticipants.length);
```

Add the import:

```ts
import { distributeParticipationPrizes } from '~/server/games/daily-challenge/challenge-rewards';
```

- [ ] **Step 3: Persist final-path paid users into metadata**

Still in `pickWinnersForChallenge`, find step 7 (the `dbWrite.challenge.update` that writes
`completionSummary`, ~lines 1272-1285). Merge the paid participants into the reconciliation
bookkeeping so reconciliation won't re-handle them. Change the `metadata` object built there to include:

```ts
        metadata: {
          ...existingMetadata,
          completionSummary: {
            judgingProcess: process,
            outcome: outcome,
            completedAt: new Date().toISOString(),
          },
          reconciliation: {
            ...(existingMetadata.reconciliation ?? {}),
            paidUserIds: Array.from(
              new Set([...(existingMetadata.reconciliation?.paidUserIds ?? []), ...paidParticipants])
            ),
          },
        },
```

- [ ] **Step 4: Verify via editor diagnostics**

Confirm no type errors on the changed block; `paidParticipants` is `number[]`, `existingMetadata`
is the parsed `ChallengeMetadata` (already in scope at line 1271).

- [ ] **Step 5: Commit**

```bash
git add src/server/games/daily-challenge/challenge-rewards.ts src/server/jobs/daily-challenge-processing.ts
git commit -m "refactor(challenges): extract distributeParticipationPrizes + record paid users in metadata"
```

---

### Task A5: `getChallengesToReconcile()` selector

**Files:**
- Modify: `src/server/games/daily-challenge/daily-challenge.utils.ts`

**Interfaces:**
- Produces: `getChallengesToReconcile(windowHours?: number): Promise<DailyChallengeDetails[]>` —
  challenges with `status = 'Completed'`, `endsAt > now() - windowHours`, that still have at
  least one `REVIEW` `CollectionItem`, mapped to the same `DailyChallengeDetails` shape the
  completion job already consumes.

- [ ] **Step 1: Add the selector**

In `src/server/games/daily-challenge/daily-challenge.utils.ts`, near `getEndedActiveChallenges`
(line ~544), add a sibling that reuses the existing `*FromDb` + mapping path. Mirror the
status filter used by `getEndedActiveChallengesFromDb`, swapping the predicate to:

```sql
  WHERE c.status = 'Completed'::"ChallengeStatus"
    AND c."endsAt" > now() - (${windowHours} || ' hours')::interval
    AND EXISTS (
      SELECT 1 FROM "CollectionItem" ci
      WHERE ci."collectionId" = c."collectionId" AND ci.status = 'REVIEW'
    )
```

Concretely, add to `daily-challenge.utils.ts`:

```ts
export async function getChallengesToReconcile(windowHours = 48): Promise<DailyChallengeDetails[]> {
  const challenges = await getChallengesToReconcileFromDb(windowHours);
  return challenges.map(challengeToLegacyFormat);
}
```

and implement `getChallengesToReconcileFromDb(windowHours)` next to
`getEndedActiveChallengesFromDb` (in whichever `*FromDb` module it lives — follow the import
at `daily-challenge.utils.ts:16`), copying that function and replacing only the `WHERE` clause
with the predicate above. Use the same `SELECT` column list and `challengeToLegacyFormat`
mapping so the returned shape is identical to `getEndedActiveChallenges`.

> If `getEndedActiveChallengesFromDb` is defined in `challenge-helpers.ts`, add the new
> `*FromDb` there and export it; import it in `daily-challenge.utils.ts` alongside line 16.

- [ ] **Step 2: Verify via editor diagnostics + a read-only spot check**

Run the predicate directly to confirm it returns recently-completed challenges with stuck
reviews (read-only):

```bash
node .claude/skills/postgres-query/query.mjs --json "
SELECT c.id, c.title, c.status, c.\"endsAt\"
FROM \"Challenge\" c
WHERE c.status='Completed' AND c.\"endsAt\" > now() - interval '48 hours'
  AND EXISTS (SELECT 1 FROM \"CollectionItem\" ci WHERE ci.\"collectionId\"=c.\"collectionId\" AND ci.status='REVIEW')
ORDER BY c.\"endsAt\" DESC"
```

Expected: at least the most recent completed challenge(s) with stuck reviews appear.

- [ ] **Step 3: Commit**

```bash
git add src/server/games/daily-challenge/daily-challenge.utils.ts src/server/games/daily-challenge/challenge-helpers.ts
git commit -m "feat(challenges): add getChallengesToReconcile selector (recently-completed w/ stuck reviews)"
```

---

### Task A6: `reconcileCompletedChallenge` orchestrator

**Files:**
- Modify: `src/server/games/daily-challenge/challenge-rewards.ts`

**Interfaces:**
- Consumes: `promoteChallengeEntries` (A3), `distributeParticipationPrizes` (A4),
  `getChallengeById`, `parseChallengeMetadata`, `getJudgingConfigForChallenge` (export it from
  `daily-challenge-processing.ts` if not already exported), `dbRead`, `dbWrite`.
- Produces:
  ```ts
  reconcileCompletedChallenge(
    challenge: DailyChallengeDetails,
    config: ChallengeConfig
  ): Promise<{ promoted: number; paid: number }>
  ```

- [ ] **Step 1: Implement the orchestrator**

Append to `src/server/games/daily-challenge/challenge-rewards.ts`:

```ts
import dayjs from 'dayjs';
import { getChallengeById } from '~/server/games/daily-challenge/challenge-helpers';
import { parseChallengeMetadata } from '~/server/schema/challenge.schema';
import { getJudgingConfigForChallenge } from '~/server/jobs/daily-challenge-processing';
import type { DailyChallengeDetails, ChallengeConfig } from '~/server/games/daily-challenge/daily-challenge.utils';

export async function reconcileCompletedChallenge(
  challenge: DailyChallengeDetails,
  config: ChallengeConfig
): Promise<{ promoted: number; paid: number }> {
  const record = await getChallengeById(challenge.challengeId);
  const allowedNsfwLevel = record?.allowedNsfwLevel ?? 1;
  const judgeId = record?.judgeId ?? config.defaultJudgeId;
  if (!judgeId) throw new Error('No judge assigned and no defaultJudgeId configured');
  const judgingConfig = await getJudgingConfigForChallenge(
    judgeId,
    config.defaultJudge,
    record?.judgingPrompt
  );

  // 1. Promote any now-scanned REVIEW entries (skips nsfwLevel = 0).
  const promoted = await promoteChallengeEntries({
    collectionId: challenge.collectionId,
    allowedNsfwLevel,
    modelVersionIds: challenge.modelVersionIds,
    challengeDate: challenge.date,
    reviewerId: judgingConfig.userId,
  });

  // 2. Winners + already-paid are excluded from participation back-pay.
  const winners = await dbRead.$queryRaw<{ userId: number }[]>`
    SELECT "userId" FROM "ChallengeWinner" WHERE "challengeId" = ${challenge.challengeId}
  `;
  const metadata = parseChallengeMetadata(record?.metadata);
  const alreadyPaid = metadata.reconciliation?.paidUserIds ?? [];
  const excludeUserIds = [...winners.map((w) => w.userId), ...alreadyPaid];

  // 3. Pay newly-eligible users (idempotent), hour-bucketed notification key.
  const hourBucket = dayjs().utc().format('YYYY-MM-DD-HH');
  const paid = await distributeParticipationPrizes({
    challengeId: challenge.challengeId,
    collectionId: challenge.collectionId,
    title: challenge.title,
    entryPrize: challenge.entryPrize,
    entryPrizeRequirement: challenge.entryPrizeRequirement,
    excludeUserIds,
    notificationKey: `challenge-participation:${challenge.challengeId}:reconcile:${hourBucket}`,
  });

  // 4. Bookkeeping: mark paid users + whether the queue has drained.
  const remainingReview = await dbRead.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint as count FROM "CollectionItem"
    WHERE "collectionId" = ${challenge.collectionId} AND status = 'REVIEW'
  `;
  const done = Number(remainingReview[0]?.count ?? 0) === 0;
  await dbWrite.challenge.update({
    where: { id: challenge.challengeId },
    data: {
      metadata: {
        ...metadata,
        reconciliation: {
          ...(metadata.reconciliation ?? {}),
          paidUserIds: Array.from(new Set([...alreadyPaid, ...paid])),
          lastRunAt: new Date().toISOString(),
          done,
        },
      } as object,
    },
  });

  return { promoted, paid: paid.length };
}
```

> If `getJudgingConfigForChallenge` is currently a private `async function` in
> `daily-challenge-processing.ts:77`, add `export` to it. Confirm `ChallengeConfig` and
> `DailyChallengeDetails` are exported from `daily-challenge.utils.ts` (they are referenced by
> the completion job, so they should be).

- [ ] **Step 2: Verify via editor diagnostics**

Confirm imports resolve and the `metadata` cast type-checks (Prisma `InputJsonValue`). If
Prisma complains, cast as `Prisma.InputJsonValue` matching the pattern used in
`daily-challenge-processing.ts` step 7.

- [ ] **Step 3: Commit**

```bash
git add src/server/games/daily-challenge/challenge-rewards.ts src/server/jobs/daily-challenge-processing.ts
git commit -m "feat(challenges): add reconcileCompletedChallenge orchestrator"
```

---

### Task A7: Wire reconciliation into the hourly completion job

**Files:**
- Modify: `src/server/jobs/challenge-completion.ts`

**Interfaces:**
- Consumes: `getChallengesToReconcile` (A5), `reconcileCompletedChallenge` (A6).

- [ ] **Step 1: Add the reconciliation pass after the completion loop**

In `src/server/jobs/challenge-completion.ts`, after the existing
`for (const challenge of endedChallenges) { ... }` loop and before the job callback closes,
add:

```ts
  // Reconciliation: back-pay participation prizes for entries rated after completion.
  const toReconcile = await getChallengesToReconcile();
  if (toReconcile.length) {
    log(`Reconciling ${toReconcile.length} recently-completed challenge(s)`);
    for (const challenge of toReconcile) {
      try {
        const { promoted, paid } = await reconcileCompletedChallenge(challenge, config);
        if (promoted > 0 || paid > 0) {
          log(`Reconciled challenge ${challenge.challengeId}: promoted=${promoted} paid=${paid}`);
        }
      } catch (error) {
        const err = error as Error;
        logToAxiom({
          type: 'error',
          name: 'challenge-reconciliation',
          message: err.message,
          challengeId: challenge.challengeId,
        });
        log(`Failed to reconcile challenge ${challenge.challengeId}:`, error);
      }
    }
  }
```

Add imports:

```ts
import { getChallengesToReconcile } from '~/server/games/daily-challenge/daily-challenge.utils';
import { reconcileCompletedChallenge } from '~/server/games/daily-challenge/challenge-rewards';
```

> Note `config` is already fetched in the job only when `endedChallenges.length` is truthy
> (it currently returns early at `if (!endedChallenges.length) return;`). Move the early
> return / `getChallengeConfig()` so `config` is available for reconciliation even when there
> are no ended challenges: fetch `const config = await getChallengeConfig();` before the
> `endedChallenges` handling, and replace the early `return` with `if (endedChallenges.length) { ...loop... }`.

- [ ] **Step 2: Verify via editor diagnostics**

Confirm the job still type-checks and `config` is in scope for both passes.

- [ ] **Step 3: Commit**

```bash
git add src/server/jobs/challenge-completion.ts
git commit -m "feat(challenges): run participation reconciliation pass in hourly completion job"
```

---

### Task A8: Guarded debug endpoint for manual reconciliation

**Files:**
- Create: `src/pages/api/testing/challenge-reconcile.ts`

**Interfaces:**
- Consumes: `reconcileCompletedChallenge` (A6), `getChallengeById`, `getChallengeConfig`,
  `challengeToLegacyFormat`, `WebhookEndpoint`.

- [ ] **Step 1: Create the endpoint**

```ts
// src/pages/api/testing/challenge-reconcile.ts
//
// Debug endpoint — manually run participation reconciliation for ONE challenge.
// Auth: WEBHOOK_TOKEN via ?token=. Scoped to a single challengeId per call.
//
// POST /api/testing/challenge-reconcile?token=$WEBHOOK_TOKEN
//   body: { "challengeId": 306 }
//   -> { promoted, paid }   (idempotent: a second call pays 0)
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getChallengeConfig } from '~/server/games/daily-challenge/daily-challenge.utils';
import { getChallengeById, challengeToLegacyFormat } from '~/server/games/daily-challenge/challenge-helpers';
import { reconcileCompletedChallenge } from '~/server/games/daily-challenge/challenge-rewards';

const schema = z.object({ challengeId: z.number() });

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const { challengeId } = schema.parse(req.body);
  const record = await getChallengeById(challengeId);
  if (!record) return res.status(404).json({ error: 'challenge not found' });
  const config = await getChallengeConfig();
  const result = await reconcileCompletedChallenge(challengeToLegacyFormat(record), config);
  return res.status(200).json(result);
});
```

> Verify `challengeToLegacyFormat` is exported from `challenge-helpers.ts` (it is used by
> `getChallengesToReconcile`); if it lives elsewhere, import it from there. Confirm
> `WebhookEndpoint` import path matches other files in `src/pages/api/testing/`.

- [ ] **Step 2: Manually verify against a real completed challenge (preview)**

Pick a recently-completed challenge that has stuck reviews (from the Task A5 spot-check),
then:

```bash
curl -s -X POST "$SITE_URL/api/testing/challenge-reconcile?token=$WEBHOOK_TOKEN" \
  -H 'Content-Type: application/json' -d '{"challengeId": 306}'
```

Expected: `{ "promoted": <n≥0>, "paid": <n≥0> }`. Run again immediately:
Expected: `{ "promoted": 0, "paid": 0 }` (idempotent — already promoted + recorded).

- [ ] **Step 3: Commit**

```bash
git add src/pages/api/testing/challenge-reconcile.ts
git commit -m "feat(challenges): add challenge-reconcile debug endpoint"
```

---

# Workstream B — Pending-review badge

### Task B1: Expose `collectionItemStatus` from the image feed query

**Files:**
- Modify: `src/server/services/image.service.ts` (CTE `:1569-1603`, SELECT `:1832`, raw-row type `:1140-1167`)

**Interfaces:**
- Produces: `ImagesInfiniteModel.collectionItemStatus?: CollectionItemStatus | null` —
  populated only when the query is collection-filtered (`collectionId` set).

- [ ] **Step 1: Add `status` to the `ct` CTE**

At `image.service.ts:1569-1574`, change the inner select to also carry status:

```ts
        ct AS (
          SELECT "imageId", note, status, "sortKey"
          FROM (
            SELECT
              ci."imageId",
              ci.note,
              ci.status,
              abs(mod(hashtext(concat(ci.id::text, '${Prisma.raw(seedStr)}')), 1000000000)) as "sortKey"
```

- [ ] **Step 2: Select it in the outer query when `collectionId` is set**

At `image.service.ts:1832`, extend the conditional projection:

```ts
      ${Prisma.raw(collectionId ? ', ct.note as "collectionItemNote", ct.status as "collectionItemStatus"' : '')}
```

- [ ] **Step 3: Add the field to the raw-row type**

At `image.service.ts:1166`, next to `collectionItemNote?: string | null;`, add:

```ts
  collectionItemStatus?: CollectionItemStatus | null;
```

Ensure `CollectionItemStatus` is imported in this file (from `~/shared/utils/prisma/enums`).
The field flows into `ImagesInfiniteModel` automatically via the `...i` spread at
`image.service.ts:2046` (it is NOT destructured out, unlike `collectionItemNote`).

- [ ] **Step 4: Verify via editor diagnostics + read-only query smoke test**

Confirm no type errors. Optionally smoke-test the raw projection:

```bash
node .claude/skills/postgres-query/query.mjs --json "
SELECT ci.\"imageId\", ci.status
FROM \"CollectionItem\" ci
JOIN \"Challenge\" c ON c.\"collectionId\"=ci.\"collectionId\"
WHERE c.id=306 AND ci.status='REVIEW' LIMIT 3"
```

Expected: rows with `status = 'REVIEW'` — confirming the column is selectable.

- [ ] **Step 5: Commit**

```bash
git add src/server/services/image.service.ts
git commit -m "feat(images): expose collectionItemStatus on collection-filtered image feed"
```

---

### Task B2: Pure `shouldShowPendingReviewBadge` helper

**Files:**
- Create: `src/components/Image/Infinite/pending-review-badge.utils.ts`
- Test: `src/components/Image/Infinite/__tests__/pending-review-badge.utils.test.ts`

**Interfaces:**
- Produces:
  ```ts
  shouldShowPendingReviewBadge(
    image: { userId: number; collectionItemStatus?: string | null },
    currentUserId?: number
  ): boolean
  ```

- [ ] **Step 1: Write the failing test**

```ts
// src/components/Image/Infinite/__tests__/pending-review-badge.utils.test.ts
import { describe, it, expect } from 'vitest';
import { shouldShowPendingReviewBadge } from '~/components/Image/Infinite/pending-review-badge.utils';

describe('shouldShowPendingReviewBadge', () => {
  it('shows for the owner when status is REVIEW', () => {
    expect(shouldShowPendingReviewBadge({ userId: 7, collectionItemStatus: 'REVIEW' }, 7)).toBe(true);
  });
  it('hides for non-owners', () => {
    expect(shouldShowPendingReviewBadge({ userId: 7, collectionItemStatus: 'REVIEW' }, 9)).toBe(false);
  });
  it('hides when not under review', () => {
    expect(shouldShowPendingReviewBadge({ userId: 7, collectionItemStatus: 'ACCEPTED' }, 7)).toBe(false);
  });
  it('hides when status is absent (non-collection feed)', () => {
    expect(shouldShowPendingReviewBadge({ userId: 7 }, 7)).toBe(false);
  });
  it('hides for anonymous viewers', () => {
    expect(shouldShowPendingReviewBadge({ userId: 7, collectionItemStatus: 'REVIEW' }, undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/Image/Infinite/__tests__/pending-review-badge.utils.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the helper**

```ts
// src/components/Image/Infinite/pending-review-badge.utils.ts
import { CollectionItemStatus } from '~/shared/utils/prisma/enums';

export function shouldShowPendingReviewBadge(
  image: { userId: number; collectionItemStatus?: string | null },
  currentUserId?: number
): boolean {
  return (
    !!currentUserId &&
    image.userId === currentUserId &&
    image.collectionItemStatus === CollectionItemStatus.REVIEW
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/Image/Infinite/__tests__/pending-review-badge.utils.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/Image/Infinite/pending-review-badge.utils.ts src/components/Image/Infinite/__tests__/pending-review-badge.utils.test.ts
git commit -m "feat(images): add shouldShowPendingReviewBadge helper"
```

---

### Task B3: Render the badge in `ImagesCard`

**Files:**
- Modify: `src/components/Image/Infinite/ImagesCard.tsx:150-172`

**Interfaces:**
- Consumes: `shouldShowPendingReviewBadge` (B2), existing `useCurrentUser()` (`:51`), `image` (`:54`).

- [ ] **Step 1: Add the badge to the top-left cluster**

In `src/components/Image/Infinite/ImagesCard.tsx`, inside the existing top-left badge
container (`<div className="absolute left-2 top-2">` … `:150-172`), after the POI badge, add:

```tsx
            {shouldShowPendingReviewBadge(image, currentUser?.id) && (
              <Tooltip label="Still being reviewed — not yet eligible for judging" withinPortal>
                <Badge variant="filled" radius="xl" h={26} color="yellow">
                  Pending review
                </Badge>
              </Tooltip>
            )}
```

Add the import (group with other `~/components` imports):

```tsx
import { shouldShowPendingReviewBadge } from '~/components/Image/Infinite/pending-review-badge.utils';
```

Confirm `Badge` and `Tooltip` are already imported from `@mantine/core` in this file
(the POI example uses `Badge`; add `Tooltip` to the import if missing).

- [ ] **Step 2: Visual verification (component-preview / Ladle)**

Use the `component-preview` skill to render `ImagesCard` with a mock `image` where
`userId === currentUser.id` and `collectionItemStatus = 'REVIEW'`, in dark + light mode.
Confirm the "Pending review" badge shows only for the owner case and not when status is
`ACCEPTED` or the viewer is a different user.

- [ ] **Step 3: Commit**

```bash
git add src/components/Image/Infinite/ImagesCard.tsx
git commit -m "feat(images): show owner-only Pending review badge on challenge entries"
```

---

## Self-Review

- **Spec coverage:**
  - G1 back-pay rated late entries → Tasks A3–A8.
  - G2 close on time → reconciliation runs *after* completion, no completion delay (A7).
  - G3 owner-only badge → Tasks B1–B3.
  - NG1 no re-judging → reconciliation never touches winners/`ChallengeWinner` (A6).
  - NG2 no paying unrated → `promoteChallengeEntries` keeps `nsfwLevel != 0` guard (A3); prize gates on `ACCEPTED` (A4).
  - Idempotency (no double-pay/notify) → Buzz key + `paidUserIds` + hour-bucketed notification key (A4, A6).
  - Metadata schema → A1.
- **Placeholder scan:** every code step contains full code; no TBD/TODO.
- **Type consistency:** `promoteChallengeEntries`, `distributeParticipationPrizes`,
  `selectPayableUsers`, `reconcileCompletedChallenge`, `getChallengesToReconcile`,
  `shouldShowPendingReviewBadge`, `collectionItemStatus` are named identically across all
  tasks that define/consume them.
- **Known verification points flagged inline** (export `getJudgingConfigForChallenge`; confirm
  `challengeToLegacyFormat` / `getEndedActiveChallengesFromDb` locations; confirm challenge
  entries grid uses the raw-SQL feed path, not Meili search). Resolve these during execution.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-23-daily-challenge-review-reconciliation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
