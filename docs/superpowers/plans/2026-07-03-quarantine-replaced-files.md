# Quarantine Replaced Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the immediate hard-delete of a redundant local file (when a linked component is created) with a 30-day quarantine — flag + hide the file, keep its bytes, purge S3 via a daily job, and allow moderator restore during the window.

**Architecture:** Add one nullable `ModelFile.replacedAt` column. At link time, `addLinkedComponent` flags the redundant file (`replacedAt=now`, `visibility=Private`, stashes restore metadata) instead of deleting it. Three render selectors filter out `replacedAt IS NOT NULL`; `visibility=Private` backstops API/search/download. A daily job purges S3 (refcount-guarded) and sets `dataPurged=true` for rows past 30 days. A moderator-only tRPC mutation restores a file while `dataPurged=false`.

**Tech Stack:** Next.js 14 + TypeScript, Prisma (Postgres), tRPC, Vitest. Design doc: `docs/link-existing-files-quarantine-design.md`.

## Global Constraints

- **Migrations are applied manually.** Write the SQL, commit it, surface it for manual apply. Never `prisma migrate deploy`/`resolve`.
- **Never edit `prisma/schema.prisma` directly** — edit `packages/civitai-db-schema/prisma/schema.full.prisma`, then `pnpm run db:generate`.
- Enums import from `~/shared/utils/prisma/enums`.
- Test runner is Vitest: `pnpm vitest run <path>`. Never place tests under `src/pages`.
- The design's read-path audit resolved to exactly three render selectors (below). `model.service.ts` `dataPurged:false` sites are `type:'Training Data'`-scoped and out of scope (a replaced component is never Training Data).

---

### Task 1: Add `ModelFile.replacedAt` column + migration

**Files:**
- Modify: `packages/civitai-db-schema/prisma/schema.full.prisma` (ModelFile model)
- Create: `prisma/migrations/20260703120000_add_modelfile_replacedat/migration.sql`
- Generated (do not hand-edit): `prisma/schema.prisma`

**Interfaces:**
- Produces: `ModelFile.replacedAt: DateTime | null` on the Prisma client, consumed by every later task.

- [ ] **Step 1: Add the column to the full schema**

In `packages/civitai-db-schema/prisma/schema.full.prisma`, in `model ModelFile`, add the field directly after the `dataPurged` line:

```prisma
  dataPurged        Boolean             @default(false)
  replacedAt        DateTime?
```

(No `@@index` in the schema — the partial index is SQL-only and lives in the migration.)

- [ ] **Step 2: Regenerate the slim schema + client**

Run: `pnpm run db:generate`
Expected: completes; `prisma/schema.prisma` now shows `replacedAt DateTime?` on `ModelFile`.

- [ ] **Step 3: Verify the generated column**

Run: `grep -n "replacedAt" prisma/schema.prisma`
Expected: one match inside the `ModelFile` model.

- [ ] **Step 4: Write the migration SQL**

Create `prisma/migrations/20260703120000_add_modelfile_replacedat/migration.sql`:

```sql
-- Quarantine marker for files replaced by a linked component (see
-- docs/link-existing-files-quarantine-design.md). NULL = active file.
ALTER TABLE "ModelFile" ADD COLUMN "replacedAt" timestamptz;

-- Partial index: the purge job and read-path filters only ever look at rows
-- where replacedAt IS NOT NULL, so keep the index tiny. CONCURRENTLY cannot run
-- inside a transaction — apply this statement on its own.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ModelFile_replacedAt_idx"
  ON "ModelFile" ("replacedAt") WHERE "replacedAt" IS NOT NULL;
```

- [ ] **Step 5: Commit**

```bash
git add packages/civitai-db-schema/prisma/schema.full.prisma prisma/schema.prisma prisma/migrations/20260703120000_add_modelfile_replacedat/migration.sql
git commit -m "feat(model-file): add replacedAt column for quarantine"
```

> **Manual apply required:** surface to the user that `prisma/migrations/20260703120000_add_modelfile_replacedat/migration.sql` must be applied by hand to preview / staging / prod.

---

### Task 2: `markFileReplaced` service fn + swap into `addLinkedComponent`

**Files:**
- Modify: `src/server/services/model-file.service.ts` (add `markFileReplaced`)
- Modify: `src/server/services/model-version.service.ts:99` (import) and `:2212-2216` (call site)
- Test: `src/server/services/__tests__/model-file.service.test.ts` (add `markFileReplaced` tests)
- Test: `src/server/services/__tests__/model-version.linked-component.service.test.ts` (swap `deleteFile` → `markFileReplaced`)

**Interfaces:**
- Produces: `markFileReplaced({ fileId: number; recommendedResourceId: number }): Promise<{ modelVersionId: number }>`. Sets `replacedAt=now`, `visibility=Private`, `metadata.replacedBy={recommendedResourceId, at, priorVisibility}`; busts `filesForModelVersionCache`. Does **not** touch S3 or delete the row. Ownership/primary-file guards are already enforced by `addLinkedComponent` upstream (version passed `isOwnerOrModerator`; the replaceFileId branch at model-version.service.ts:2158-2176 rejects primary/Training-Data files), so this fn does not re-check.
- Consumes: `deleteFilesForModelVersionCache` (existing, model-file.service.ts:79), `ModelFileVisibility` enum.

- [ ] **Step 1: Adjust the shared cache mock in the existing service test**

In `src/server/services/__tests__/model-file.service.test.ts`, change the `createCachedObject` mock so the cache exposes `bust` (markFileReplaced busts it), and extend the db mock with `findUnique`/`update`:

```typescript
const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: {
    modelFile: {
      count: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));
vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbRead }));
vi.mock('~/server/utils/cache-helpers', () => ({
  createCachedObject: () => ({ bust: vi.fn(), fetch: vi.fn() }),
}));
```

- [ ] **Step 2: Write the failing test for `markFileReplaced`**

Append to `src/server/services/__tests__/model-file.service.test.ts`:

```typescript
import { markFileReplaced } from '~/server/services/model-file.service';
import { ModelFileVisibility } from '~/shared/utils/prisma/enums';

describe('markFileReplaced', () => {
  it('flags the file replaced + private and stashes prior visibility, without deleting', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue({
      id: 88,
      visibility: ModelFileVisibility.Public,
      metadata: { format: 'SafeTensor' },
      modelVersionId: 10,
    });

    const res = await markFileReplaced({ fileId: 88, recommendedResourceId: 1 });

    expect(res).toEqual({ modelVersionId: 10 });
    const arg = mockDbRead.modelFile.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 88 });
    expect(arg.data.replacedAt).toBeInstanceOf(Date);
    expect(arg.data.visibility).toBe(ModelFileVisibility.Private);
    expect(arg.data.metadata).toMatchObject({
      format: 'SafeTensor',
      replacedBy: { recommendedResourceId: 1, priorVisibility: ModelFileVisibility.Public },
    });
  });

  it('throws when the file does not exist', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue(null);
    await expect(markFileReplaced({ fileId: 999, recommendedResourceId: 1 })).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm vitest run src/server/services/__tests__/model-file.service.test.ts`
Expected: FAIL — `markFileReplaced` is not exported.

- [ ] **Step 4: Implement `markFileReplaced`**

In `src/server/services/model-file.service.ts`, add the enum import near the other imports:

```typescript
import { ModelFileVisibility } from '~/shared/utils/prisma/enums';
```

Add the function (place it just after `deleteFile`, around line 264):

```typescript
export async function markFileReplaced({
  fileId,
  recommendedResourceId,
}: {
  fileId: number;
  recommendedResourceId: number;
}) {
  // Quarantine (don't delete) the redundant local file: retain bytes for the
  // grace window so a bad link can be restored. Ownership + primary/Training
  // guards are enforced by addLinkedComponent before this is called.
  const file = await dbWrite.modelFile.findUnique({
    where: { id: fileId },
    select: { id: true, visibility: true, metadata: true, modelVersionId: true },
  });
  if (!file) throw throwNotFoundError();

  const metadata = (file.metadata ?? {}) as Record<string, unknown>;
  const now = new Date();
  await dbWrite.modelFile.update({
    where: { id: fileId },
    data: {
      replacedAt: now,
      visibility: ModelFileVisibility.Private,
      metadata: {
        ...metadata,
        replacedBy: {
          recommendedResourceId,
          at: now.toISOString(),
          priorVisibility: file.visibility,
        },
      },
    },
  });

  await deleteFilesForModelVersionCache(file.modelVersionId);
  return { modelVersionId: file.modelVersionId };
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `pnpm vitest run src/server/services/__tests__/model-file.service.test.ts`
Expected: PASS (new + existing tests).

- [ ] **Step 6: Swap the call site in `addLinkedComponent`**

In `src/server/services/model-version.service.ts` line 99, change the import (drop `deleteFile`, add `markFileReplaced` — `deleteFile` is used nowhere else in this file):

```typescript
import { markFileReplaced, filesForModelVersionCache } from './model-file.service';
```

Replace the block at lines 2212-2216:

```typescript
  // Quarantine the now-redundant local file instead of hard-deleting it: bytes
  // are retained for 30 days (restorable) and freed later by the
  // purge-replaced-files job. Requires the created pointer's id.
  if (input.replaceFileId != null) {
    await markFileReplaced({ fileId: input.replaceFileId, recommendedResourceId: result.id });
  }
```

- [ ] **Step 7: Update the linked-component test to expect flag, not delete**

In `src/server/services/__tests__/model-version.linked-component.service.test.ts`:

Rename every `mockDeleteFile` → `mockMarkReplaced` (hoisted decl line 8, init line 19, and each assertion). Change the service mock (line 57) from `deleteFile: mockDeleteFile` to `markFileReplaced: mockMarkReplaced`. Change the positive assertion (line 188) to:

```typescript
    expect(mockMarkReplaced).toHaveBeenCalledWith({ fileId: 888, recommendedResourceId: 1 });
```

(The `recommendedResource.create` mock resolves `{ id: 1 }`, so `result.id` is `1`.) Every `expect(mockMarkReplaced).not.toHaveBeenCalled()` and the invocation-order assertion (create before markFileReplaced) stay valid — `markFileReplaced` inherently runs after `create` because it needs `result.id`.

- [ ] **Step 8: Run both test files**

Run: `pnpm vitest run src/server/services/__tests__/model-file.service.test.ts src/server/services/__tests__/model-version.linked-component.service.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/server/services/model-file.service.ts src/server/services/model-version.service.ts src/server/services/__tests__/model-file.service.test.ts src/server/services/__tests__/model-version.linked-component.service.test.ts
git commit -m "feat(link-existing-files): quarantine replaced file instead of deleting"
```

---

### Task 3: Hide quarantined rows from the three render selectors

**Files:**
- Modify: `src/server/services/model-file.service.ts:33` (`fetchModelFilesForCache`)
- Modify: `src/server/selectors/model.selector.ts:143`
- Modify: `src/server/selectors/modelVersion.selector.ts:36`
- Test: `src/server/services/__tests__/model-file.service.test.ts` (assert cache query excludes replaced rows)

**Interfaces:**
- Consumes: `ModelFile.replacedAt` (Task 1).
- Produces: no new symbols — read paths now exclude `replacedAt IS NOT NULL`. `visibility=Private` (Task 2) backstops API/search/download.

- [ ] **Step 1: Write the failing test for the cache filter**

Append to `src/server/services/__tests__/model-file.service.test.ts` — verify `fetchModelFilesForCache`'s query carries `replacedAt: null`. It is invoked via the cache's `lookupFn`; assert against `dbRead.modelFile.findMany`. Extend the hoisted db mock to add `findMany: vi.fn()` on `modelFile`, then:

```typescript
import { filesForModelVersionCache } from '~/server/services/model-file.service';

describe('filesForModelVersionCache lookup', () => {
  it('excludes replaced (quarantined) files from the version file list', async () => {
    mockDbRead.modelFile.findMany.mockResolvedValue([]);
    // lookupFn is the second arg passed to createCachedObject; call it directly.
    await filesForModelVersionCache.lookupFn?.([10]);
    const arg = mockDbRead.modelFile.findMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({ modelVersionId: { in: [10] }, replacedAt: null });
  });
});
```

> If `filesForModelVersionCache.lookupFn` is not reachable through the mocked `createCachedObject`, instead export the inner `fetchModelFilesForCache` from the module and call it directly in the test — do not assert on Redis. Adjust the mock so `createCachedObject` returns `{ bust: vi.fn(), fetch: vi.fn(), lookupFn: undefined }` and test `fetchModelFilesForCache` directly.

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run src/server/services/__tests__/model-file.service.test.ts -t "excludes replaced"`
Expected: FAIL — `where` currently only has `modelVersionId`.

- [ ] **Step 3: Add the filter to `fetchModelFilesForCache`**

In `src/server/services/model-file.service.ts`, in `fetchModelFilesForCache` (line 30-35), change the query `where`:

```typescript
async function fetchModelFilesForCache(ids: number[]) {
  return await dbRead.modelFile
    .findMany({
      where: { modelVersionId: { in: ids }, replacedAt: null },
      select: modelFileSelect,
    })
```

(Do **not** add `dataPurged` here — that would change existing behavior for purged Training-Data rows.)

- [ ] **Step 4: Add the filter to `model.selector.ts`**

In `src/server/selectors/model.selector.ts` line ~142, change the files select `where`:

```typescript
      files: {
        select: modelFileSelect,
        where: { dataPurged: false, replacedAt: null },
      },
```

- [ ] **Step 5: Add the filter to `modelVersion.selector.ts`**

In `src/server/selectors/modelVersion.selector.ts` line ~35, add a `where` to the files select (currently unfiltered):

```typescript
  files: {
    select: modelFileSelect,
    where: { replacedAt: null },
  },
```

- [ ] **Step 6: Run the cache test**

Run: `pnpm vitest run src/server/services/__tests__/model-file.service.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify no other unfiltered version-file render path was missed**

Run: `grep -rn "select: modelFileSelect" src/server`
Expected: only the two selectors above (`model.selector.ts`, `modelVersion.selector.ts`) plus the `modelFile.selector.ts` self-reference. If a new render selector appears, add `replacedAt: null` to it; operational reads (merge/delete/publish in `model.service.ts` / `model-version.service.ts`) do not need it.

- [ ] **Step 8: Commit**

```bash
git add src/server/services/model-file.service.ts src/server/selectors/model.selector.ts src/server/selectors/modelVersion.selector.ts src/server/services/__tests__/model-file.service.test.ts
git commit -m "feat(link-existing-files): hide quarantined files from version file lists"
```

---

### Task 4: Daily purge job

**Files:**
- Create: `src/server/jobs/purge-replaced-files.ts`
- Modify: `src/pages/api/webhooks/run-jobs/[[...run]].ts` (import + register in `jobs` array)
- Test: `src/server/jobs/__tests__/purge-replaced-files.test.ts`

**Interfaces:**
- Produces: `processReplacedFiles(rows: { id: number; url: string }[]): Promise<{ purged: number; failed: number }>` and `purgeReplacedFilesJob: Job`.
- Consumes: `deleteModelFileObject` (s3-utils, refcount-guarded), `createJob` (jobs/job).

- [ ] **Step 1: Write the failing job test**

Create `src/server/jobs/__tests__/purge-replaced-files.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbWrite, mockDeleteObj } = vi.hoisted(() => ({
  mockDbWrite: { modelFile: { update: vi.fn() } },
  mockDeleteObj: vi.fn(),
}));
vi.mock('~/server/db/client', () => ({ dbWrite: mockDbWrite }));
vi.mock('~/utils/s3-utils', () => ({ deleteModelFileObject: mockDeleteObj }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: () => ({ catch: () => {} }) }));
vi.mock('~/server/jobs/job', () => ({ createJob: (_n: string, _c: string, fn: unknown) => fn }));

import { processReplacedFiles } from '~/server/jobs/purge-replaced-files';

beforeEach(() => vi.clearAllMocks());

describe('processReplacedFiles', () => {
  it('purges S3 (refcount-guarded) then marks dataPurged for each row', async () => {
    const res = await processReplacedFiles([{ id: 1, url: 'https://bucket/a' }]);
    expect(mockDeleteObj).toHaveBeenCalledWith('https://bucket/a');
    expect(mockDbWrite.modelFile.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { dataPurged: true },
    });
    expect(res).toEqual({ purged: 1, failed: 0 });
  });

  it('counts a failure and continues to the next row', async () => {
    mockDeleteObj.mockRejectedValueOnce(new Error('boom'));
    const res = await processReplacedFiles([
      { id: 1, url: 'u1' },
      { id: 2, url: 'u2' },
    ]);
    expect(res).toEqual({ purged: 1, failed: 1 });
    expect(mockDbWrite.modelFile.update).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run src/server/jobs/__tests__/purge-replaced-files.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the job**

Create `src/server/jobs/purge-replaced-files.ts`:

```typescript
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { deleteModelFileObject } from '~/utils/s3-utils';
import { createJob } from '~/server/jobs/job';

const GRACE_DAYS = 30;

const logJob = (data: MixedObject) =>
  logToAxiom({ name: 'purge-replaced-files', type: 'error', ...data }, 'webhooks').catch(() => {});

type ReplacedRow = { id: number; url: string };

export async function processReplacedFiles(rows: ReplacedRow[]) {
  let purged = 0;
  let failed = 0;
  for (const { id, url } of rows) {
    try {
      // Refcount-guarded: skips the S3 delete if another live ModelFile still
      // references this url. Do NOT swap for raw deleteObject.
      await deleteModelFileObject(url);
      await dbWrite.modelFile.update({ where: { id }, data: { dataPurged: true } });
      purged += 1;
    } catch (e) {
      failed += 1;
      logJob({ message: 'purge error', data: { modelFileId: id, error: (e as Error)?.message } });
    }
  }
  return { purged, failed };
}

export const purgeReplacedFilesJob = createJob(
  'purge-replaced-files',
  '15 11 * * *',
  async () => {
    const rows = await dbWrite.$queryRaw<ReplacedRow[]>`
      SELECT id, url
      FROM "ModelFile"
      WHERE "replacedAt" < now() - make_interval(days => ${GRACE_DAYS})
        AND "dataPurged" IS NOT TRUE
    `;
    if (rows.length === 0) return { status: 'ok' };
    const { purged, failed } = await processReplacedFiles(rows);
    logJob({ type: 'info', message: 'finished', data: { purged, failed } });
    return { status: 'ok' };
  }
);
```

(`make_interval(days => $1)` keeps `GRACE_DAYS` a bound parameter — a plain `interval '${n} days'` would produce an invalid `interval '$1 days'`.)

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm vitest run src/server/jobs/__tests__/purge-replaced-files.test.ts`
Expected: PASS.

- [ ] **Step 5: Register the job**

In `src/pages/api/webhooks/run-jobs/[[...run]].ts`, add the import next to the other job imports (near line 33):

```typescript
import { purgeReplacedFilesJob } from '~/server/jobs/purge-replaced-files';
```

Add it to the `jobs: Job[]` array (after `deleteOldTrainingData` if present, else anywhere in the array):

```typescript
  purgeReplacedFilesJob,
```

- [ ] **Step 6: Commit**

```bash
git add src/server/jobs/purge-replaced-files.ts src/server/jobs/__tests__/purge-replaced-files.test.ts "src/pages/api/webhooks/run-jobs/[[...run]].ts"
git commit -m "feat(link-existing-files): daily job purges replaced files after 30d"
```

---

### Task 5: Moderator-only restore endpoint

**Files:**
- Modify: `src/server/services/model-file.service.ts` (add `restoreReplacedFile`)
- Modify: `src/server/controllers/model-file.controller.ts` (add `restoreReplacedFileHandler`)
- Modify: `src/server/routers/model-file.router.ts` (add `restoreReplaced` mutation)
- Test: `src/server/services/__tests__/model-file.service.test.ts` (restore tests)

**Interfaces:**
- Consumes: `ModelFile.replacedAt` / `dataPurged` / `metadata.replacedBy` (Tasks 1-2), `deleteFilesForModelVersionCache`.
- Produces: `restoreReplacedFile({ id: number }): Promise<{ modelVersionId: number }>`; `restoreReplacedFileHandler`; tRPC `modelFile.restoreReplaced` (moderator-only).

- [ ] **Step 1: Write the failing restore tests**

Append to `src/server/services/__tests__/model-file.service.test.ts`:

```typescript
import { restoreReplacedFile } from '~/server/services/model-file.service';

describe('restoreReplacedFile', () => {
  it('reverts replacedAt + prior visibility and clears the replacedBy marker', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue({
      id: 88,
      replacedAt: new Date(),
      dataPurged: false,
      metadata: { format: 'SafeTensor', replacedBy: { priorVisibility: ModelFileVisibility.Public } },
      modelVersionId: 10,
    });

    const res = await restoreReplacedFile({ id: 88 });

    expect(res).toEqual({ modelVersionId: 10 });
    const arg = mockDbRead.modelFile.update.mock.calls[0][0];
    expect(arg.data.replacedAt).toBeNull();
    expect(arg.data.visibility).toBe(ModelFileVisibility.Public);
    expect(arg.data.metadata).toEqual({ format: 'SafeTensor' });
  });

  it('rejects when the file is not replaced', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue({
      id: 88, replacedAt: null, dataPurged: false, metadata: {}, modelVersionId: 10,
    });
    await expect(restoreReplacedFile({ id: 88 })).rejects.toThrow();
  });

  it('rejects once bytes have been purged', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue({
      id: 88, replacedAt: new Date(), dataPurged: true, metadata: {}, modelVersionId: 10,
    });
    await expect(restoreReplacedFile({ id: 88 })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm vitest run src/server/services/__tests__/model-file.service.test.ts -t "restoreReplacedFile"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement `restoreReplacedFile`**

In `src/server/services/model-file.service.ts` (after `markFileReplaced`). Ensure `throwBadRequestError` is imported (it already is — used at line 152/219):

```typescript
export async function restoreReplacedFile({ id }: { id: number }) {
  const file = await dbWrite.modelFile.findUnique({
    where: { id },
    select: { id: true, replacedAt: true, dataPurged: true, metadata: true, modelVersionId: true },
  });
  if (!file) throw throwNotFoundError();
  if (file.replacedAt == null) throw throwBadRequestError('File is not replaced');
  if (file.dataPurged)
    throw throwBadRequestError('File bytes were already purged and cannot be restored');

  const metadata = (file.metadata ?? {}) as Record<string, unknown>;
  const replacedBy = metadata.replacedBy as { priorVisibility?: ModelFileVisibility } | undefined;
  const priorVisibility = replacedBy?.priorVisibility ?? ModelFileVisibility.Public;
  const { replacedBy: _dropped, ...restMetadata } = metadata;

  await dbWrite.modelFile.update({
    where: { id },
    data: { replacedAt: null, visibility: priorVisibility, metadata: restMetadata },
  });

  await deleteFilesForModelVersionCache(file.modelVersionId);
  return { modelVersionId: file.modelVersionId };
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm vitest run src/server/services/__tests__/model-file.service.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the controller handler**

In `src/server/controllers/model-file.controller.ts`, add the import to the existing service import block:

```typescript
import { restoreReplacedFile } from '~/server/services/model-file.service';
```

Add the handler (mirror `deleteFileHandler`'s error shape; `GetByIdInput` + `throwDbError` are already imported):

```typescript
export const restoreReplacedFileHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    return await restoreReplacedFile({ id: input.id });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
```

- [ ] **Step 6: Register the moderator-only route**

In `src/server/routers/model-file.router.ts`, add `moderatorProcedure` to the trpc import and `restoreReplacedFileHandler` to the controller import:

```typescript
import { moderatorProcedure, protectedProcedure, publicProcedure, router } from '~/server/trpc';
```

Add the mutation inside `modelFileRouter`:

```typescript
  restoreReplaced: moderatorProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(getByIdSchema)
    .mutation(restoreReplacedFileHandler),
```

- [ ] **Step 7: Commit**

```bash
git add src/server/services/model-file.service.ts src/server/controllers/model-file.controller.ts src/server/routers/model-file.router.ts src/server/services/__tests__/model-file.service.test.ts
git commit -m "feat(link-existing-files): moderator restore endpoint for quarantined files"
```

---

## Verification (after all tasks)

- [ ] Full suite for touched files: `pnpm vitest run src/server/services/__tests__/model-file.service.test.ts src/server/services/__tests__/model-version.linked-component.service.test.ts src/server/jobs/__tests__/purge-replaced-files.test.ts`
- [ ] Typecheck (8GB heap; bare `tsc` OOMs → false pass): `pnpm run typecheck`
- [ ] Surface the migration to the user for manual apply to preview/staging/prod.
- [ ] Note the deliberate tradeoff for reviewers: the bulk dedupe job (`dedupe-official-uploads.ts`) now flags instead of deletes, so backfill S3 bytes are retained 30 days rather than freed immediately.

## Self-Review notes

- **Spec coverage:** column (T1), flag-at-link + retain bytes (T2), hide from lists (T3), 30-day S3 purge keeping row + `dataPurged=true` (T4), mod-only restore with precondition (T5). All spec sections mapped.
- **Types consistent:** `markFileReplaced({fileId, recommendedResourceId})`, `restoreReplacedFile({id})`, `processReplacedFiles(rows)`, `{modelVersionId}` return — same names used in call sites, controller, and tests.
- **Non-goals honored:** no new table/dbKV; restore does not remove the `RecommendedResource` link; no retroactive recovery.
