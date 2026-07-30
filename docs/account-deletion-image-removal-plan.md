# Account Deletion Image Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hard-delete every image (database row + S3 object) owned by a self-deleted account, via a rate-limited background job that also drains the 7.2M-image backlog from already-deleted accounts.

**Architecture:** `deleteUser` is left untouched — it stays a fast transaction. A new hourly job derives its worklist from `User.deletedAt IS NOT NULL`, so no queue table and no enqueue step exist to drift out of sync. Per user it batches image ids through the existing `deleteImages()` (which already handles S3, search-index deletion, post-NSFW recompute and cache busting), then deletes that user's posts once their images are fully drained. A Redis key caps images-per-run and doubles as the kill switch.

**Tech Stack:** TypeScript, Prisma (raw SQL via `$queryRaw`), Vitest, Redis (`sysRedis`), Axiom logging.

## Global Constraints

- Spec: `docs/account-deletion-image-removal.md`. ClickUp: 868kj32gm.
- Runner is **Vitest**, not Jest: `pnpm vitest run <path>`.
- Never put test files under `src/pages`. Job tests go in `src/server/jobs/__tests__/`.
- Migrations are **applied by hand** per environment. Never run or suggest `prisma migrate deploy`. Write the SQL, commit it, surface it to the user.
- `sysRedis` returns `Buffer` for BLOB_STRING replies on the HA/Sentinel setup. Always coerce before comparing or parsing — this has caused production incidents twice (PR #2697/#2700).
- Reuse `deleteImages()` from `~/server/services/image.service`. Do not write new deletion logic.
- Follow the existing job-test mocking pattern: `vi.mock('~/server/jobs/job', () => ({ createJob: (_n, _c, fn) => fn }))` makes the job body directly callable.
- Work happens in the worktree `../civitai-account-deletion-image-removal` on branch `feat/account-deletion-image-removal`. Deps are already installed.

## Measured facts driving this design

| Fact | Value |
|---|---|
| Accounts soft-deleted | 1,304,035 |
| Of those, still owning images | 74,828 |
| Images owned by deleted accounts | 7,235,873 |
| Max images owned by one user | 784,498 |
| Users owning >5,000 images | 4,522 |
| Driving query without an index | 1.7 s, parallel seq scan, ~612K buffers |
| FKs referencing `Image` | 13 — 2 CASCADE, 11 SET NULL, 0 RESTRICT |

## File Structure

| File | Responsibility |
|---|---|
| `src/server/jobs/remove-deleted-user-images.ts` (create) | The drain job: worklist query, per-user image deletion, post cleanup, budget/kill switch |
| `src/server/jobs/__tests__/remove-deleted-user-images.test.ts` (create) | Unit tests for the above |
| `packages/civitai-redis/src/client.ts` (modify) | Add the `DELETED_USER_IMAGE_PURGE_LIMIT` system key |
| `packages/civitai-db-schema/prisma/migrations/20260730130000_user_deleted_at_partial_index/migration.sql` (create) | Partial index on `User."deletedAt"` |
| `src/pages/api/webhooks/run-jobs/[[...run]].ts` (modify) | Register the job |
| `src/server/services/user.service.ts` (modify) | Correct the now-wrong `restoreUser` doc comment |
| `docs/account-deletion-image-removal.md` (modify) | Correct the "no migration" claim |

---

### Task 1: Core drain job

**Files:**
- Create: `src/server/jobs/remove-deleted-user-images.ts`
- Test: `src/server/jobs/__tests__/remove-deleted-user-images.test.ts`

**Interfaces:**
- Consumes: `deleteImages(ids: number[], updatePosts?: boolean)` from `~/server/services/image.service` — returns `{ id, url, postId, nsfwLevel, userId }[]` of rows actually deleted.
- Produces: `export const removeDeletedUserImages` (a `Job`), and `export const USERS_PER_RUN = 50`, `export const DELETE_BATCH_SIZE = 100`.

- [ ] **Step 1: Write the failing test**

Create `src/server/jobs/__tests__/remove-deleted-user-images.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbRead, mockDbWrite, mockDeleteImages, mockLogToAxiom, mockSysRedis } = vi.hoisted(
  () => ({
    mockDbRead: { $queryRaw: vi.fn() },
    mockDbWrite: { $executeRaw: vi.fn() },
    mockDeleteImages: vi.fn(),
    mockLogToAxiom: vi.fn(),
    mockSysRedis: { get: vi.fn() },
  })
);

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/services/image.service', () => ({ deleteImages: mockDeleteImages }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));
vi.mock('~/server/redis/client', () => ({
  sysRedis: mockSysRedis,
  REDIS_SYS_KEYS: { SYSTEM: { DELETED_USER_IMAGE_PURGE_LIMIT: 'k' } },
}));
vi.mock('~/server/jobs/job', () => ({ createJob: (_n: string, _c: string, fn: unknown) => fn }));

import { removeDeletedUserImages } from '~/server/jobs/remove-deleted-user-images';

const run = () =>
  (removeDeletedUserImages as unknown as (ctx: { checkIfCanceled: () => void }) => Promise<any>)({
    checkIfCanceled: () => undefined,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockSysRedis.get.mockResolvedValue(null);
  mockDbWrite.$executeRaw.mockResolvedValue(1);
});

describe('removeDeletedUserImages', () => {
  it('deletes a deleted user images in batches of 100 and then removes their posts', async () => {
    // First $queryRaw = user worklist. Second = that user's image ids (150 of them).
    mockDbRead.$queryRaw
      .mockResolvedValueOnce([{ id: 7 }])
      .mockResolvedValueOnce(Array.from({ length: 150 }, (_, i) => ({ id: i + 1 })));
    mockDeleteImages.mockImplementation(async (ids: number[]) => ids.map((id) => ({ id })));

    const result = await run();

    expect(mockDeleteImages).toHaveBeenCalledTimes(2);
    expect(mockDeleteImages.mock.calls[0][0]).toHaveLength(100);
    expect(mockDeleteImages.mock.calls[1][0]).toHaveLength(50);
    // Fewer rows returned than the requested budget => user is drained => posts go.
    expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(1);
    expect(result.deletedImages).toBe(150);
    expect(result.deletedUsers).toBe(1);
  });

  it('does not delete posts when the user still has images left', async () => {
    // Image lookup returns exactly the budget => more may remain => posts must stay.
    mockDbRead.$queryRaw
      .mockResolvedValueOnce([{ id: 7 }])
      .mockResolvedValueOnce(Array.from({ length: 25000 }, (_, i) => ({ id: i + 1 })));
    mockDeleteImages.mockImplementation(async (ids: number[]) => ids.map((id) => ({ id })));

    await run();

    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('does nothing when no deleted users own images', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([]);

    const result = await run();

    expect(mockDeleteImages).not.toHaveBeenCalled();
    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(result.deletedImages).toBe(0);
  });

  it('keeps going when one user fails, and logs the failure', async () => {
    mockDbRead.$queryRaw
      .mockResolvedValueOnce([{ id: 7 }, { id: 8 }])
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 2 }]);
    mockDeleteImages
      .mockRejectedValueOnce(new Error('s3 exploded'))
      .mockResolvedValueOnce([{ id: 2 }]);

    const result = await run();

    // User 8 still processed after user 7 threw.
    expect(mockDeleteImages).toHaveBeenCalledTimes(2);
    expect(result.deletedImages).toBe(1);
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', name: 'remove-deleted-user-images' })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ../civitai-account-deletion-image-removal && pnpm vitest run src/server/jobs/__tests__/remove-deleted-user-images.test.ts`
Expected: FAIL — cannot resolve `~/server/jobs/remove-deleted-user-images`.

- [ ] **Step 3: Write the implementation**

Create `src/server/jobs/remove-deleted-user-images.ts`.

The one subtle bit: capture the remaining budget into `budgetForUser` **before** fetching, and
compare the returned row count against it. Fewer rows than requested means the user has no
images left, which is the only safe moment to delete their posts. Comparing against the
post-decrement `remaining` would be wrong.

```ts
import { chunk } from 'lodash-es';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { deleteImages } from '~/server/services/image.service';
import { createJob } from './job';

export const USERS_PER_RUN = 50;
export const DELETE_BATCH_SIZE = 100;
export const DEFAULT_IMAGES_PER_RUN = 25000;

export const removeDeletedUserImages = createJob(
  'remove-deleted-user-images',
  '15 * * * *',
  async (ctx) => {
    let remaining = DEFAULT_IMAGES_PER_RUN;
    let deletedImages = 0;
    let deletedUsers = 0;

    const users = await dbRead.$queryRaw<{ id: number }[]>`
      SELECT u.id
      FROM "User" u
      WHERE u."deletedAt" IS NOT NULL
        AND EXISTS (SELECT 1 FROM "Image" i WHERE i."userId" = u.id)
      ORDER BY u."deletedAt" DESC
      LIMIT ${USERS_PER_RUN}
    `;

    for (const user of users) {
      if (remaining <= 0) break;
      ctx.checkIfCanceled();

      try {
        const budgetForUser = remaining;
        const images = await dbRead.$queryRaw<{ id: number }[]>`
          SELECT id FROM "Image" WHERE "userId" = ${user.id} LIMIT ${budgetForUser}
        `;
        if (!images.length) continue;

        for (const batch of chunk(
          images.map((i) => i.id),
          DELETE_BATCH_SIZE
        )) {
          const deleted = await deleteImages(batch);
          deletedImages += deleted.length;
          remaining -= batch.length;
        }

        if (images.length < budgetForUser) {
          await dbWrite.$executeRaw`DELETE FROM "Post" WHERE "userId" = ${user.id}`;
          deletedUsers += 1;
        }
      } catch (error) {
        logToAxiom({
          type: 'error',
          name: 'remove-deleted-user-images',
          message: (error as Error).message,
          userId: user.id,
        });
      }
    }

    console.log(`remove-deleted-user-images: ${deletedImages} images, ${deletedUsers} users`);

    return { deletedImages, deletedUsers };
  },
  { lockExpiration: 30 * 60, dedicated: true }
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ../civitai-account-deletion-image-removal && pnpm vitest run src/server/jobs/__tests__/remove-deleted-user-images.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/jobs/remove-deleted-user-images.ts src/server/jobs/__tests__/remove-deleted-user-images.test.ts
git commit -m "feat(account-deletion): add drain job for deleted users' images"
```

---

### Task 2: Redis-backed rate limit and kill switch

**Files:**
- Modify: `packages/civitai-redis/src/client.ts` (add key next to `IMAGE_SCANNER_NEW`, around line 1785)
- Modify: `src/server/jobs/remove-deleted-user-images.ts`
- Test: `src/server/jobs/__tests__/remove-deleted-user-images.test.ts`

**Interfaces:**
- Consumes: `USERS_PER_RUN`, `DEFAULT_IMAGES_PER_RUN` from Task 1.
- Produces: `export async function getImagePurgeBudget(): Promise<number>` — resolves the per-run image cap. `0` means paused.

- [ ] **Step 1: Add the Redis key**

In `packages/civitai-redis/src/client.ts`, immediately after the `IMAGE_SCANNER_NEW` entry inside the `SYSTEM` block:

```ts
    /*
      Per-run image cap for the remove-deleted-user-images job. Set to '0' to
      pause the drain without a deploy. Missing key means the job's compiled
      default applies.
     */
    DELETED_USER_IMAGE_PURGE_LIMIT: 'system:deleted-user-image-purge-limit',
```

- [ ] **Step 2: Write the failing tests**

Append to `src/server/jobs/__tests__/remove-deleted-user-images.test.ts`:

```ts
describe('removeDeletedUserImages budget', () => {
  it('does nothing when the Redis limit is 0', async () => {
    mockSysRedis.get.mockResolvedValue('0');

    const result = await run();

    expect(mockDbRead.$queryRaw).not.toHaveBeenCalled();
    expect(mockDeleteImages).not.toHaveBeenCalled();
    expect(result.paused).toBe(true);
  });

  it('coerces a Buffer reply from the HA sysRedis', async () => {
    mockSysRedis.get.mockResolvedValue(Buffer.from('200'));
    mockDbRead.$queryRaw
      .mockResolvedValueOnce([{ id: 7 }])
      .mockResolvedValueOnce(Array.from({ length: 200 }, (_, i) => ({ id: i + 1 })));
    mockDeleteImages.mockImplementation(async (ids: number[]) => ids.map((id) => ({ id })));

    const result = await run();

    // Budget of 200 honoured: 2 batches of 100, nothing more.
    expect(mockDeleteImages).toHaveBeenCalledTimes(2);
    expect(result.deletedImages).toBe(200);
  });

  it('stops at the budget and leaves later users for the next run', async () => {
    mockSysRedis.get.mockResolvedValue('100');
    mockDbRead.$queryRaw
      .mockResolvedValueOnce([{ id: 7 }, { id: 8 }])
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })));
    mockDeleteImages.mockImplementation(async (ids: number[]) => ids.map((id) => ({ id })));

    const result = await run();

    // Budget exhausted by user 7; user 8 is never fetched.
    expect(mockDeleteImages).toHaveBeenCalledTimes(1);
    expect(result.deletedImages).toBe(100);
  });

  it('falls back to the default when the key is unset', async () => {
    mockSysRedis.get.mockResolvedValue(null);
    mockDbRead.$queryRaw.mockResolvedValueOnce([]);

    const result = await run();

    expect(result.paused).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ../civitai-account-deletion-image-removal && pnpm vitest run src/server/jobs/__tests__/remove-deleted-user-images.test.ts`
Expected: FAIL — the job ignores Redis and never returns `paused`.

- [ ] **Step 4: Implement the budget**

In `src/server/jobs/remove-deleted-user-images.ts`, add the import and helper:

```ts
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

/**
 * The HA/Sentinel sysRedis returns a Buffer for BLOB_STRING replies, so coerce
 * before parsing — comparing the raw reply silently misreads the operator's value.
 */
export async function getImagePurgeBudget(): Promise<number> {
  const raw = await sysRedis.get(REDIS_SYS_KEYS.SYSTEM.DELETED_USER_IMAGE_PURGE_LIMIT);
  if (raw == null) return DEFAULT_IMAGES_PER_RUN;
  const parsed = Number(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_IMAGES_PER_RUN;
  return parsed;
}
```

Then replace the opening of the job body so the budget gates everything:

```ts
    const budget = await getImagePurgeBudget();
    if (budget <= 0) return { paused: true, deletedImages: 0, deletedUsers: 0 };

    let remaining = budget;
    let deletedImages = 0;
    let deletedUsers = 0;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ../civitai-account-deletion-image-removal && pnpm vitest run src/server/jobs/__tests__/remove-deleted-user-images.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/civitai-redis/src/client.ts src/server/jobs/remove-deleted-user-images.ts src/server/jobs/__tests__/remove-deleted-user-images.test.ts
git commit -m "feat(account-deletion): add Redis rate limit and kill switch to image drain"
```

---

### Task 3: Registration, index migration, and doc corrections

**Files:**
- Create: `packages/civitai-db-schema/prisma/migrations/20260730130000_user_deleted_at_partial_index/migration.sql`
- Modify: `src/pages/api/webhooks/run-jobs/[[...run]].ts`
- Modify: `src/server/services/user.service.ts:1085-1095`
- Modify: `docs/account-deletion-image-removal.md`

**Interfaces:**
- Consumes: `removeDeletedUserImages` from Task 1.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the migration**

Create `packages/civitai-db-schema/prisma/migrations/20260730130000_user_deleted_at_partial_index/migration.sql`:

```sql
-- The remove-deleted-user-images job filters "User" on "deletedAt" IS NOT NULL
-- every run. Without this index that is a parallel seq scan over ~12.7M rows
-- (~1.7s, ~612K buffers). The partial index covers only the ~1.3M soft-deleted
-- rows and lets the job take the newest deletions first.
--
-- CONCURRENTLY cannot run inside a transaction block. Run this statement on its
-- own, not wrapped in BEGIN/COMMIT.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_deletedAt_idx"
  ON "User" ("deletedAt" DESC)
  WHERE "deletedAt" IS NOT NULL;
```

- [ ] **Step 2: Register the job**

In `src/pages/api/webhooks/run-jobs/[[...run]].ts`, add the import alongside the other job imports:

```ts
import { removeDeletedUserImages } from '~/server/jobs/remove-deleted-user-images';
```

and add it to the `jobs` array immediately after `userDeletedCleanup` (line ~129):

```ts
  userDeletedCleanup,
  removeDeletedUserImages,
```

- [ ] **Step 3: Correct the restoreUser doc comment**

In `src/server/services/user.service.ts`, the `restoreUser` doc block currently describes what survives deletion and no longer holds — images are now purged. Replace the sentence beginning "We can only restore what survives the deletion:" with:

```
 * We can only restore what survives the deletion: the User row's scrubbed fields (caller
 * supplies them) and the orphaned Model ownership (via ClickHouse audit). Images and Posts are
 * hard-deleted by the remove-deleted-user-images job, S3 objects included, and are never
 * recoverable — restoring an account brings back its models but not its images.
```

- [ ] **Step 4: Correct the spec**

In `docs/account-deletion-image-removal.md`, the design claims no migration is needed. Measurement disproved it. Update the "Execution" section bullet from "No migration." to:

```
- One small migration: a partial index on `User."deletedAt"`. Without it the job's driving
  query is a parallel seq scan over 12.7M users (~1.7s, ~612K buffers) every run. Still no
  schema change and no backfill.
```

and change the final line of the document from `No schema migration. No UI change. No new tRPC procedure.` to:

```
One index-only migration (hand-applied). No schema change, no UI change, no new tRPC procedure.
```

- [ ] **Step 5: Verify the whole suite and types**

Run: `cd ../civitai-account-deletion-image-removal && pnpm vitest run src/server/jobs/__tests__/remove-deleted-user-images.test.ts && pnpm run typecheck`
Expected: tests PASS; typecheck reports no errors in the touched files.

- [ ] **Step 6: Commit**

```bash
git add packages/civitai-db-schema/prisma/migrations src/pages/api/webhooks/run-jobs src/server/services/user.service.ts docs/account-deletion-image-removal.md
git commit -m "feat(account-deletion): register image drain job and add deletedAt index"
```

---

## Post-implementation

- The migration is **not** auto-applied. Surface to the user that
  `20260730130000_user_deleted_at_partial_index` must be run by hand (preview / staging / prod),
  and that `CREATE INDEX CONCURRENTLY` must not be wrapped in a transaction.
- The drain starts as soon as the job is registered and deployed. To ship dark, set
  `system:deleted-user-image-purge-limit` to `0` in sysRedis **before** deploy.
- Backlog drain at the 25,000/run default is ~290 runs, roughly 12 days. Watch S3 delete
  throughput and search-index queue depth on the first few runs before raising the cap.
