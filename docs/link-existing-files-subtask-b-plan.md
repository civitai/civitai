# Subtask B — Dedupe-by-Hash — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a component/accessory file's bytes already exist on the CivitaiOfficial account, link to the official copy instead of storing a duplicate — preventing the upload client-side (B.1a), catching misses post-scan (B.1b), and retroactively reclaiming existing dupes via an hourly job (B.2).

**Architecture:** All three paths reuse the already-shipped `addLinkedComponent` service (creates a `RecommendedResource` linked-component pointer + deletes the redundant `ModelFile` in one call). Identity is full-file **SHA256**. Two new read-only service helpers (`findOfficialFilesBySize`, `findOfficialFileByHash`) back the size gate + hash confirm. A required read-path staleness fix drops linked components whose source file was deleted, making "rehome onto official" self-healing.

**Tech Stack:** TypeScript, Next.js 14, Prisma/PostgreSQL, tRPC, Zustand, Vitest. Client hashing uses native **WebCrypto** SHA-256 (≤1 GB) and **jsSHA** streaming (>1 GB), run in a Web Worker.

Spec: [`link-existing-files-subtask-b-spec.md`](./link-existing-files-subtask-b-spec.md). Parent design: [`link-existing-files-design.md`](./link-existing-files-design.md).

## Global Constraints

- **Official account:** `constants.system.officialUserId` = `12042163` (`src/server/common/constants.ts:354`). Scope every official query on it.
- **Host-side weights guard:** never dedup a `Model` / `Pruned Model` file (the user's primary weights). The **canonical/official** file is NOT type-filtered — it is frequently `type='Model'` (a standalone VAE/encoder's primary file).
- **`inferComponentType` is not a weights filter:** it returns `'Checkpoint'` (not `null`) for `Model`/`Pruned Model` (`src/server/utils/model-helpers.ts:284-286`). Exclude primary weights by explicit type name. `componentType` for a pointer always derives from the **host** file's type.
- **Hashes are stored/compared lowercased** (`ModelFileHash`, `type='SHA256'`), full-file byte range.
- **Reuse the primitive:** `addLinkedComponent(input & { userId, isModerator })` from `src/server/services/model-version.service.ts:2075`. Server callers pass `userId: officialUserId, isModerator: true`.
- **Client worker hash cap:** `OFFICIAL_MATCH_HASH_MAX_BYTES = 5 * 1024 ** 3` (5 GB) — a *time* guard (jsSHA streaming keeps memory flat, but multi-GB pure-JS hashing is slow). Larger files skip client hashing and rely on B.1b. Hashing dispatches native WebCrypto (≤1 GB, whole-file in RAM, fastest) vs jsSHA streaming (1–5 GB, flat memory).
- **Test runner:** Vitest — `pnpm vitest run <path>`.
- **Never edit `prisma/schema.prisma` directly** (auto-generated) — but this plan adds **no** schema changes.

---

### Task 1: Official-file lookup service

A small, dependency-light module (only `dbRead`) so it is trivially testable and reused by B.1a/B.1b/B.2. Kept out of the ~huge `model-file.service.ts` on purpose.

**Files:**
- Create: `src/server/services/official-file.service.ts`
- Test: `src/server/services/__tests__/official-file.service.test.ts`

**Interfaces:**
- Consumes: `dbRead` (`~/server/db/client`), `constants` (`~/server/common/constants`), `inferComponentType` (`~/server/utils/model-helpers`), `primaryModelFileTypes` (`~/utils/file-display-helpers`), `ModelHashType` (`~/shared/utils/prisma/enums`).
- Produces:
  - `type OfficialFileMatch = { versionId: number; fileId: number; modelId: number; modelName: string; versionName: string; fileName: string; sizeKB: number; componentType: ModelFileComponentType }`
  - `findOfficialFilesBySize(sizeKB: number): Promise<{ id: number }[]>`
  - `findOfficialFileByHash(args: { sha256: string; hostType: string }): Promise<OfficialFileMatch | null>`

- [ ] **Step 1: Write the failing test**

```ts
// src/server/services/__tests__/official-file.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: { modelFile: { findMany: vi.fn(), findFirst: vi.fn() } },
}));
vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead }));

import {
  findOfficialFilesBySize,
  findOfficialFileByHash,
} from '~/server/services/official-file.service';
import { constants } from '~/server/common/constants';

const OFFICIAL = constants.system.officialUserId;

// A standalone VAE stores its bytes as a type='Model' file inside a VAE-type model.
const officialVaeRow = {
  id: 900,
  name: 'boogu.vae.safetensors',
  sizeKB: 300_000,
  modelVersionId: 42,
  modelVersion: { name: 'v1', modelId: 7, model: { name: 'Boogu VAE' } },
};

beforeEach(() => vi.clearAllMocks());

describe('findOfficialFilesBySize', () => {
  it('scopes to the official account and the exact sizeKB', async () => {
    mockDbRead.modelFile.findMany.mockResolvedValue([{ id: 900 }]);
    const rows = await findOfficialFilesBySize(300_000);
    expect(rows).toEqual([{ id: 900 }]);
    const arg = mockDbRead.modelFile.findMany.mock.calls[0][0];
    expect(arg.where.sizeKB).toBe(300_000);
    expect(arg.where.modelVersion.model.userId).toBe(OFFICIAL);
  });
});

describe('findOfficialFileByHash', () => {
  it('matches a canonical file that is itself type="Model" and derives componentType from the host', async () => {
    mockDbRead.modelFile.findFirst.mockResolvedValue(officialVaeRow);
    const match = await findOfficialFileByHash({ sha256: 'ABCDEF', hostType: 'VAE' });
    expect(match).toEqual({
      versionId: 42,
      fileId: 900,
      modelId: 7,
      modelName: 'Boogu VAE',
      versionName: 'v1',
      fileName: 'boogu.vae.safetensors',
      sizeKB: 300_000,
      componentType: 'VAE',
    });
    // hash lowercased in the query
    const arg = mockDbRead.modelFile.findFirst.mock.calls[0][0];
    expect(arg.where.hashes.some.hash).toBe('abcdef');
    expect(arg.where.modelVersion.model.userId).toBe(OFFICIAL);
  });

  it('returns null for a primary-weights host without querying', async () => {
    expect(await findOfficialFileByHash({ sha256: 'abc', hostType: 'Model' })).toBeNull();
    expect(await findOfficialFileByHash({ sha256: 'abc', hostType: 'Pruned Model' })).toBeNull();
    expect(mockDbRead.modelFile.findFirst).not.toHaveBeenCalled();
  });

  it('returns null when no official file has the hash', async () => {
    mockDbRead.modelFile.findFirst.mockResolvedValue(null);
    expect(await findOfficialFileByHash({ sha256: 'abc', hostType: 'VAE' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/services/__tests__/official-file.service.test.ts`
Expected: FAIL — `Cannot find module '~/server/services/official-file.service'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/server/services/official-file.service.ts
import { dbRead } from '~/server/db/client';
import { constants } from '~/server/common/constants';
import { inferComponentType } from '~/server/utils/model-helpers';
import { primaryModelFileTypes } from '~/utils/file-display-helpers';
import { ModelHashType } from '~/shared/utils/prisma/enums';
import type { ModelFileType } from '~/server/common/constants';

const OFFICIAL_USER_ID = constants.system.officialUserId;

export type OfficialFileMatch = {
  versionId: number;
  fileId: number;
  modelId: number;
  modelName: string;
  versionName: string;
  fileName: string;
  sizeKB: number;
  componentType: ModelFileComponentType;
};

export async function findOfficialFilesBySize(sizeKB: number): Promise<{ id: number }[]> {
  return dbRead.modelFile.findMany({
    where: { sizeKB, modelVersion: { model: { userId: OFFICIAL_USER_ID } } },
    select: { id: true },
  });
}

export async function findOfficialFileByHash({
  sha256,
  hostType,
}: {
  sha256: string;
  hostType: string;
}): Promise<OfficialFileMatch | null> {
  // Host-side weights guard — never dedup the user's primary weights.
  if (primaryModelFileTypes.includes(hostType as ModelFileType)) return null;
  const componentType = inferComponentType(hostType);
  if (!componentType) return null;

  // Canonical is matched purely on bytes + official ownership — its own file
  // type is not constrained (a standalone VAE's file is type='Model').
  const file = await dbRead.modelFile.findFirst({
    where: {
      hashes: { some: { type: ModelHashType.SHA256, hash: sha256.toLowerCase() } },
      modelVersion: { model: { userId: OFFICIAL_USER_ID } },
    },
    orderBy: { modelVersionId: 'asc' },
    select: {
      id: true,
      name: true,
      sizeKB: true,
      modelVersionId: true,
      modelVersion: { select: { name: true, modelId: true, model: { select: { name: true } } } },
    },
  });
  if (!file) return null;

  return {
    versionId: file.modelVersionId,
    fileId: file.id,
    modelId: file.modelVersion.modelId,
    modelName: file.modelVersion.model.name,
    versionName: file.modelVersion.name,
    fileName: file.name,
    sizeKB: file.sizeKB,
    componentType,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/services/__tests__/official-file.service.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/services/official-file.service.ts src/server/services/__tests__/official-file.service.test.ts
git commit -m "feat(model-files): official-file lookup helpers (size + hash) for dedupe"
```

---

### Task 2: tRPC surface for the lookups

Exposes the two helpers so the client size gate + hash confirm can call them. Converts the client's byte size to KB with the **same** `bytesToKB` that `createFile` uses, so the stored `sizeKB` and the gate agree exactly.

**Files:**
- Modify: `src/server/schema/model-file.schema.ts` (append two schemas)
- Modify: `src/server/routers/model-file.router.ts` (append two queries)
- Test: `src/server/routers/__tests__/model-file.official-lookup.router.test.ts`

**Interfaces:**
- Consumes: `findOfficialFilesBySize`, `findOfficialFileByHash` (Task 1); `bytesToKB` (`~/utils/number-helpers`).
- Produces (tRPC): `modelFile.findOfficialFilesBySize({ size: number })` → `{ id: number }[]`; `modelFile.findOfficialFileByHash({ sha256: string; hostType: string })` → `OfficialFileMatch | null`.

- [ ] **Step 1: Add the input schemas**

Append to `src/server/schema/model-file.schema.ts`:

```ts
export const findOfficialFilesBySizeSchema = z.object({
  size: z.number().int().positive(), // bytes (client file.size)
});
export type FindOfficialFilesBySizeInput = z.infer<typeof findOfficialFilesBySizeSchema>;

export const findOfficialFileByHashSchema = z.object({
  sha256: z.string().min(1),
  hostType: z.string().min(1),
});
export type FindOfficialFileByHashInput = z.infer<typeof findOfficialFileByHashSchema>;
```

(If `z` is imported as `import * as z from 'zod'` elsewhere in the file, match that import style.)

- [ ] **Step 2: Write the failing router test**

```ts
// src/server/routers/__tests__/model-file.official-lookup.router.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindBySize, mockFindByHash } = vi.hoisted(() => ({
  mockFindBySize: vi.fn(),
  mockFindByHash: vi.fn(),
}));
vi.mock('~/server/services/official-file.service', () => ({
  findOfficialFilesBySize: mockFindBySize,
  findOfficialFileByHash: mockFindByHash,
}));

import { findOfficialFilesBySizeHandler } from '~/server/routers/model-file.router';

beforeEach(() => vi.clearAllMocks());

describe('findOfficialFilesBySize handler', () => {
  it('converts bytes to KB before querying', async () => {
    mockFindBySize.mockResolvedValue([{ id: 1 }]);
    const res = await findOfficialFilesBySizeHandler({ size: 300_000 * 1024 });
    expect(mockFindBySize).toHaveBeenCalledWith(300_000);
    expect(res).toEqual([{ id: 1 }]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/server/routers/__tests__/model-file.official-lookup.router.test.ts`
Expected: FAIL — `findOfficialFilesBySizeHandler` is not exported.

- [ ] **Step 4: Implement the handler + register the queries**

In `src/server/routers/model-file.router.ts`, add imports and an exported handler (exported so it's unit-testable without a tRPC caller):

```ts
import { bytesToKB } from '~/utils/number-helpers';
import {
  findOfficialFilesBySize,
  findOfficialFileByHash,
} from '~/server/services/official-file.service';
import {
  findOfficialFilesBySizeSchema,
  findOfficialFileByHashSchema,
} from '~/server/schema/model-file.schema';

export function findOfficialFilesBySizeHandler(input: { size: number }) {
  return findOfficialFilesBySize(bytesToKB(input.size));
}
```

Add these two entries to the `modelFileRouter` object:

```ts
  findOfficialFilesBySize: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(findOfficialFilesBySizeSchema)
    .query(({ input }) => findOfficialFilesBySizeHandler(input)),
  findOfficialFileByHash: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(findOfficialFileByHashSchema)
    .query(({ input }) => findOfficialFileByHash(input)),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/server/routers/__tests__/model-file.official-lookup.router.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/schema/model-file.schema.ts src/server/routers/model-file.router.ts src/server/routers/__tests__/model-file.official-lookup.router.test.ts
git commit -m "feat(model-files): tRPC queries for official file size/hash lookup"
```

---

### Task 3: Read-path staleness (drop deleted linked sources)

When a linked component's source `ModelFile` (its `settings.fileId`) no longer exists, drop it from public reads so consumers never see a broken component. This makes B's "rehome onto official" self-healing. A pure helper keeps both controllers DRY and unit-testable.

**Files:**
- Create: `src/server/utils/linked-component-helpers.ts`
- Modify: `src/server/controllers/model-version.controller.ts:217-236` (filter the mapped list)
- Modify: `src/server/controllers/model.controller.ts` (linked hydration around `:360-384` — apply the same filter)
- Test: `src/server/utils/__tests__/linked-component-helpers.test.ts`

**Interfaces:**
- Produces: `selectLiveLinkedComponents<T extends { fileId?: number | null }>(components: T[], liveFileIds: Set<number>): T[]`

- [ ] **Step 1: Write the failing test**

```ts
// src/server/utils/__tests__/linked-component-helpers.test.ts
import { describe, it, expect } from 'vitest';
import { selectLiveLinkedComponents } from '~/server/utils/linked-component-helpers';

describe('selectLiveLinkedComponents', () => {
  const comps = [
    { fileId: 1, name: 'live' },
    { fileId: 2, name: 'deleted' },
    { fileId: undefined, name: 'no-file' },
  ];

  it('keeps only components whose fileId is in the live set', () => {
    const live = new Set([1]);
    expect(selectLiveLinkedComponents(comps, live)).toEqual([{ fileId: 1, name: 'live' }]);
  });

  it('drops everything when the live set is empty', () => {
    expect(selectLiveLinkedComponents(comps, new Set())).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/utils/__tests__/linked-component-helpers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

```ts
// src/server/utils/linked-component-helpers.ts

// A linked component whose source ModelFile (settings.fileId) has been deleted
// must not surface on public reads — otherwise consumers see a component that
// 404s on download. `liveFileIds` is the set of fileIds still present in the DB.
export function selectLiveLinkedComponents<T extends { fileId?: number | null }>(
  components: T[],
  liveFileIds: Set<number>
): T[] {
  return components.filter((c) => c.fileId != null && liveFileIds.has(c.fileId));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/utils/__tests__/linked-component-helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Apply in `model-version.controller.ts`**

At `src/server/controllers/model-version.controller.ts:217`, wrap the existing `.map(...)` result: build the live-id set from the already-fetched `linkedFileDataMap` and filter. Import at top: `import { selectLiveLinkedComponents } from '~/server/utils/linked-component-helpers';`

```ts
    const linkedComponents = selectLiveLinkedComponents(
      linkedComponentResources.map((r) => {
        const s = r.settings as LinkedComponentSettings;
        const fileData = linkedFileDataMap.get(s.fileId);
        return {
          recommendedResourceId: r.id,
          componentType: s.componentType,
          modelId: s.modelId,
          modelName: s.modelName,
          versionId: r.resource?.id ?? 0,
          versionName: s.versionName,
          fileId: s.fileId,
          fileName: fileData?.name ?? s.fileName,
          sizeKB: fileData?.sizeKB,
          fileType: fileData?.type,
          fileMetadata: fileData?.metadata as
            | { format?: string | null; size?: string | null; fp?: string | null }
            | undefined,
          isRequired: s.isRequired,
        };
      }),
      new Set(linkedFileDataMap.keys())
    );
```

- [ ] **Step 6: Apply the same filter in `model.controller.ts`**

Read `src/server/controllers/model.controller.ts` around the linked-component hydration (`:360-384`). It batch-fetches linked source files into a map keyed by fileId; wrap its mapped linked-components list in `selectLiveLinkedComponents(list, new Set(<thatMap>.keys()))` exactly as Step 5. Add the same import.

- [ ] **Step 7: Verify nothing else broke + commit**

Run: `pnpm vitest run src/server/utils/__tests__/linked-component-helpers.test.ts`
Expected: PASS.

```bash
git add src/server/utils/linked-component-helpers.ts src/server/utils/__tests__/linked-component-helpers.test.ts src/server/controllers/model-version.controller.ts src/server/controllers/model.controller.ts
git commit -m "fix(model-files): drop stale linked components (deleted source) on reads"
```

---

### Task 4: B.1b — server post-scan safety net

In `applyScanOutcome`, after SHA256 rows are written, if the just-scanned file's bytes match an official file (and the uploader isn't official), convert it to a pointer and reclaim the bytes.

**Files:**
- Modify: `src/server/services/model-file-scan.service.ts` (the `file` select `:121-128` + a block after the hash upsert `:204`)
- Test: `src/server/services/__tests__/model-file-scan.service.test.ts` (extend)

**Interfaces:**
- Consumes: `findOfficialFileByHash` (Task 1), `addLinkedComponent` (`~/server/services/model-version.service`), `constants.system.officialUserId`.

- [ ] **Step 1: Write the failing test**

Add to `src/server/services/__tests__/model-file-scan.service.test.ts`. Mirror the file's existing mock setup; ensure these mocks exist (add if missing):

```ts
// in the vi.hoisted / vi.mock block:
vi.mock('~/server/services/official-file.service', () => ({ findOfficialFileByHash: vi.fn() }));
vi.mock('~/server/services/model-version.service', () => ({ addLinkedComponent: vi.fn() }));

// then in the tests:
import { applyScanOutcome } from '~/server/services/model-file-scan.service';
import { findOfficialFileByHash } from '~/server/services/official-file.service';
import { addLinkedComponent } from '~/server/services/model-version.service';
import { constants } from '~/server/common/constants';

describe('applyScanOutcome — B.1b official dedup', () => {
  const OFFICIAL = constants.system.officialUserId;

  it('converts a matching non-official upload to a pointer and deletes the row', async () => {
    // file owned by a normal user, a VAE
    mockDbWrite.modelFile.findUnique.mockResolvedValue({
      id: 500,
      type: 'VAE',
      modelVersionId: 10,
      modelVersion: { modelId: 1, model: { userId: 999 } },
    });
    vi.mocked(findOfficialFileByHash).mockResolvedValue({
      versionId: 42, fileId: 900, modelId: 7, modelName: 'Boogu VAE',
      versionName: 'v1', fileName: 'boogu.vae.safetensors', sizeKB: 300_000, componentType: 'VAE',
    });

    await applyScanOutcome({ fileId: 500, hashes: { SHA256: 'abc' }, virusScan: { result: 'Success', message: null } });

    expect(addLinkedComponent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 10, targetVersionId: 42, targetFileId: 900, replaceFileId: 500,
        componentType: 'VAE', userId: OFFICIAL, isModerator: true,
      })
    );
  });

  it('does nothing when the uploader IS official', async () => {
    mockDbWrite.modelFile.findUnique.mockResolvedValue({
      id: 501, type: 'VAE', modelVersionId: 11, modelVersion: { modelId: 2, model: { userId: OFFICIAL } },
    });
    await applyScanOutcome({ fileId: 501, hashes: { SHA256: 'abc' }, virusScan: { result: 'Success', message: null } });
    expect(findOfficialFileByHash).not.toHaveBeenCalled();
    expect(addLinkedComponent).not.toHaveBeenCalled();
  });

  it('never throws out of scan finalization when dedup fails', async () => {
    mockDbWrite.modelFile.findUnique.mockResolvedValue({
      id: 502, type: 'VAE', modelVersionId: 12, modelVersion: { modelId: 3, model: { userId: 999 } },
    });
    vi.mocked(findOfficialFileByHash).mockRejectedValue(new Error('boom'));
    await expect(
      applyScanOutcome({ fileId: 502, hashes: { SHA256: 'abc' }, virusScan: { result: 'Success', message: null } })
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/services/__tests__/model-file-scan.service.test.ts`
Expected: FAIL — `addLinkedComponent` not called (logic absent) / import errors for the new mocks.

- [ ] **Step 3: Extend the `file` select**

In `applyScanOutcome` (`:121-128`), add `type` and the owner:

```ts
  const file = await dbWrite.modelFile.findUnique({
    where: { id: fileId },
    select: {
      id: true,
      type: true,
      modelVersionId: true,
      modelVersion: { select: { modelId: true, model: { select: { userId: true } } } },
    },
  });
```

- [ ] **Step 4: Add the dedup block after the hash upsert**

Immediately after the `if (outcome.hashes) { ... }` block (`:204`), add. Import at top: `import { findOfficialFileByHash } from '~/server/services/official-file.service';`, `import { addLinkedComponent } from '~/server/services/model-version.service';`, `import { constants } from '~/server/common/constants';`.

```ts
  // B.1b safety net: a non-official upload whose bytes match an official file
  // is rehomed onto that file (pointer) and its row deleted to reclaim storage.
  const sha256 = outcome.hashes?.SHA256;
  if (sha256 && file.modelVersion?.model?.userId !== constants.system.officialUserId) {
    try {
      const match = await findOfficialFileByHash({ sha256, hostType: file.type });
      if (match) {
        await addLinkedComponent({
          id: file.modelVersionId,
          targetVersionId: match.versionId,
          targetFileId: match.fileId,
          replaceFileId: file.id,
          componentType: match.componentType,
          modelId: match.modelId,
          modelName: match.modelName,
          versionName: match.versionName,
          isRequired: true,
          userId: constants.system.officialUserId,
          isModerator: true,
        });
      }
    } catch (e) {
      logToAxiom(
        { type: 'warning', name: 'b1b-official-dedup', message: (e as Error).message, fileId },
        'webhooks'
      ).catch(() => null);
    }
  }
```

> If Vitest reports a circular import between `model-file-scan.service` and `model-version.service`, import `addLinkedComponent` lazily inside the block: `const { addLinkedComponent } = await import('~/server/services/model-version.service');`.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/server/services/__tests__/model-file-scan.service.test.ts`
Expected: PASS (existing tests + 3 new).

- [ ] **Step 6: Commit**

```bash
git add src/server/services/model-file-scan.service.ts src/server/services/__tests__/model-file-scan.service.test.ts
git commit -m "feat(model-files): B.1b post-scan dedup of official-matching uploads"
```

---

### Task 5: B.2 — hourly official-uploads reclaim job

When official uploads a file, retroactively rehome every existing non-official copy onto it.

**Files:**
- Create: `src/server/jobs/dedupe-official-uploads.ts`
- Modify: `src/pages/api/webhooks/run-jobs/[[...run]].ts` (import + add to `jobs` array `:106`)
- Test: `src/server/jobs/__tests__/dedupe-official-uploads.test.ts`

**Interfaces:**
- Consumes: `createJob`, `getJobDate`, `setJobDate` (`~/server/jobs/job`); `dbRead` raw query; `addLinkedComponent`; `inferComponentType`; `limitConcurrency`; `constants.system.officialUserId`.
- Produces: `export const dedupeOfficialUploadsJob` (cron `0 * * * *`); `export async function findOfficialDedupePairs(since: Date, limit: number)` (exported for testing the SQL contract shape).

- [ ] **Step 1: Write the failing test (pair-processing logic)**

```ts
// src/server/jobs/__tests__/dedupe-official-uploads.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAddLinked } = vi.hoisted(() => ({ mockAddLinked: vi.fn() }));
vi.mock('~/server/services/model-version.service', () => ({ addLinkedComponent: mockAddLinked }));

import { processDedupePairs } from '~/server/jobs/dedupe-official-uploads';
import { constants } from '~/server/common/constants';

const OFFICIAL = constants.system.officialUserId;

beforeEach(() => vi.clearAllMocks());

describe('processDedupePairs', () => {
  const pair = {
    hostFileId: 500, hostType: 'VAE', hostVersionId: 10,
    canonicalFileId: 900, canonicalVersionId: 42, canonicalModelId: 7,
    canonicalModelName: 'Boogu VAE', canonicalVersionName: 'v1',
  };

  it('links each host onto the official canonical and reclaims its bytes', async () => {
    await processDedupePairs([pair], 10);
    expect(mockAddLinked).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 10, targetVersionId: 42, targetFileId: 900, replaceFileId: 500,
        componentType: 'VAE', userId: OFFICIAL, isModerator: true,
      })
    );
  });

  it('skips a host whose type has no component mapping', async () => {
    await processDedupePairs([{ ...pair, hostType: 'Archive' }], 10);
    expect(mockAddLinked).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/jobs/__tests__/dedupe-official-uploads.test.ts`
Expected: FAIL — module/export not found.

- [ ] **Step 3: Implement the job**

```ts
// src/server/jobs/dedupe-official-uploads.ts
import { dbRead } from '~/server/db/client';
import { constants } from '~/server/common/constants';
import { addLinkedComponent } from '~/server/services/model-version.service';
import { inferComponentType } from '~/server/utils/model-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { logToAxiom } from '~/server/logging/client';
import { createJob, getJobDate, setJobDate } from './job';

const OFFICIAL_USER_ID = constants.system.officialUserId;
const CONCURRENCY = 10;
const BATCH_LIMIT = 1000;

export type DedupePair = {
  hostFileId: number;
  hostType: string;
  hostVersionId: number;
  canonicalFileId: number;
  canonicalVersionId: number;
  canonicalModelId: number;
  canonicalModelName: string;
  canonicalVersionName: string;
};

// Official files scanned since `since`, joined to every non-official published
// copy of the same SHA256 that isn't already linked. Canonical is NOT type-
// filtered (a standalone VAE's file is type='Model'); the host is.
export async function findOfficialDedupePairs(since: Date, limit: number): Promise<DedupePair[]> {
  return dbRead.$queryRaw<DedupePair[]>`
    WITH official_recent AS (
      SELECT mf.id AS canonical_file_id, mf."modelVersionId" AS canonical_version_id,
             mfh.hash, mv."modelId" AS canonical_model_id,
             m.name AS canonical_model_name, mv.name AS canonical_version_name
      FROM "ModelFile" mf
      JOIN "ModelFileHash" mfh ON mfh."fileId" = mf.id AND mfh.type = 'SHA256'
      JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE m."userId" = ${OFFICIAL_USER_ID} AND mf."scannedAt" >= ${since}
    ),
    canonical AS (
      SELECT DISTINCT ON (hash) hash, canonical_file_id, canonical_version_id,
             canonical_model_id, canonical_model_name, canonical_version_name
      FROM official_recent
      ORDER BY hash, canonical_version_id ASC
    )
    SELECT h.id                     AS "hostFileId",
           h.type                   AS "hostType",
           h."modelVersionId"       AS "hostVersionId",
           c.canonical_file_id      AS "canonicalFileId",
           c.canonical_version_id   AS "canonicalVersionId",
           c.canonical_model_id     AS "canonicalModelId",
           c.canonical_model_name   AS "canonicalModelName",
           c.canonical_version_name AS "canonicalVersionName"
    FROM canonical c
    JOIN "ModelFileHash" hh ON hh.hash = c.hash AND hh.type = 'SHA256'
    JOIN "ModelFile" h ON h.id = hh."fileId"
    JOIN "ModelVersion" hv ON hv.id = h."modelVersionId"
    JOIN "Model" hm ON hm.id = hv."modelId"
    WHERE hm."userId" <> ${OFFICIAL_USER_ID}
      AND hm.status = 'Published'
      AND h.type NOT IN ('Model', 'Pruned Model')
      AND h."modelVersionId" <> c.canonical_version_id
      AND NOT EXISTS (
        SELECT 1 FROM "RecommendedResource" rr
        WHERE rr."sourceId" = h."modelVersionId"
          AND rr."resourceId" = c.canonical_version_id
          AND rr.settings->>'isLinkedComponent' = 'true'
          AND (rr.settings->>'fileId')::int = c.canonical_file_id
      )
    ORDER BY h."modelVersionId", h.id
    LIMIT ${limit}
  `;
}

// Group by host version and run each group sequentially (parallel across
// groups): two host files on one version sharing a canonical would race the
// check-then-act dedupe in addLinkedComponent and create duplicate pointers.
export async function processDedupePairs(pairs: DedupePair[], concurrency: number) {
  const byVersion = new Map<number, DedupePair[]>();
  for (const p of pairs) {
    const list = byVersion.get(p.hostVersionId) ?? [];
    list.push(p);
    byVersion.set(p.hostVersionId, list);
  }

  const groups = [...byVersion.values()].map((group) => async () => {
    for (const pair of group) {
      const componentType = inferComponentType(pair.hostType);
      if (!componentType) continue;
      try {
        await addLinkedComponent({
          id: pair.hostVersionId,
          targetVersionId: pair.canonicalVersionId,
          targetFileId: pair.canonicalFileId,
          replaceFileId: pair.hostFileId,
          componentType,
          modelId: pair.canonicalModelId,
          modelName: pair.canonicalModelName,
          versionName: pair.canonicalVersionName,
          isRequired: true,
          userId: OFFICIAL_USER_ID,
          isModerator: true,
        });
      } catch (e) {
        logToAxiom(
          { type: 'warning', name: 'b2-official-dedup', message: (e as Error).message, hostFileId: pair.hostFileId },
          'webhooks'
        ).catch(() => null);
      }
    }
  });

  await limitConcurrency(groups, concurrency);
}

export const dedupeOfficialUploadsJob = createJob(
  'dedupe-official-uploads',
  '0 * * * *',
  async () => {
    // Overlap the window by an hour; the pointer dedupe makes re-processing safe.
    const lastRun = await getJobDate('dedupe-official-uploads');
    const since = new Date(lastRun.getTime() - 60 * 60 * 1000);
    const pairs = await findOfficialDedupePairs(since, BATCH_LIMIT);
    await processDedupePairs(pairs, CONCURRENCY);
    await setJobDate('dedupe-official-uploads');
    return { pairs: pairs.length };
  }
);
```

> Confirm `getJobDate`/`setJobDate` signatures in `src/server/jobs/job.ts:109` — `getJobDate(key, defaultValue?)` returns a `Date` (epoch default). If `setJobDate` isn't the sibling name, use the actual setter the file exports.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/jobs/__tests__/dedupe-official-uploads.test.ts`
Expected: PASS.

- [ ] **Step 5: Register the job**

In `src/pages/api/webhooks/run-jobs/[[...run]].ts`: add `import { dedupeOfficialUploadsJob } from '~/server/jobs/dedupe-official-uploads';` near the other job imports (~`:83`), and add `dedupeOfficialUploadsJob,` to the `jobs` array (`:106`).

- [ ] **Step 6: Commit**

```bash
git add src/server/jobs/dedupe-official-uploads.ts src/server/jobs/__tests__/dedupe-official-uploads.test.ts "src/pages/api/webhooks/run-jobs/[[...run]].ts"
git commit -m "feat(model-files): B.2 hourly job rehoming non-official dupes onto official files"
```

---

### Task 6: Client hashing core + worker + hook

A pure, node-testable SHA256-over-a-Blob function; a classic Web Worker wrapping it (bundled to `public/workers` like the existing workers); and a hook to run it with the 5 GB cap.

**Files:**
- Add dep: `jssha`
- Create: `src/utils/file-hash.ts` (pure core)
- Create: `src/workers/file-hash.worker.ts` (worker entry)
- Modify: `scripts/build-workers.mjs` (register the worker)
- Create: `src/hooks/useFileHash.ts` (hook)
- Test: `src/utils/__tests__/file-hash.test.ts`

**Interfaces:**
- Produces:
  - `computeBlobSha256(blob: Blob): Promise<string>` (full-file, lowercase hex; native WebCrypto ≤1 GB, jsSHA streaming above)
  - `sha256WebCrypto(blob: Blob): Promise<string>` and `sha256Streaming(blob: Blob, chunkSize?: number): Promise<string>` (exported for testing that both strategies agree)
  - `OFFICIAL_MATCH_HASH_MAX_BYTES = 5 * 1024 ** 3`
  - `useFileHash(): { hashFile: (file: File) => Promise<string | null> }` (returns `null` when the file exceeds the cap or the worker errors)

- [ ] **Step 1: Install the dependency**

Run: `pnpm add jssha`
Expected: `jssha` added to `package.json` dependencies.

- [ ] **Step 2: Write the failing test (known-vector + strategy agreement)**

```ts
// src/utils/__tests__/file-hash.test.ts
import { describe, it, expect } from 'vitest';
import { computeBlobSha256, sha256WebCrypto, sha256Streaming } from '~/utils/file-hash';

const KNOWN_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('file-hash', () => {
  it('computeBlobSha256 matches the known SHA256 of "abc" (lowercase hex)', async () => {
    const blob = new Blob([new TextEncoder().encode('abc')]);
    expect(await computeBlobSha256(blob)).toBe(KNOWN_ABC);
  });

  it('native and streaming strategies both match the known vector', async () => {
    const blob = new Blob([new TextEncoder().encode('abc')]);
    expect(await sha256WebCrypto(blob)).toBe(KNOWN_ABC);
    expect(await sha256Streaming(blob, 1)).toBe(KNOWN_ABC); // 1-byte chunks exercise the update loop
  });

  it('streaming matches native on a larger buffer', async () => {
    const bytes = new Uint8Array(50_000).map((_, i) => i % 256);
    const blob = new Blob([bytes]);
    expect(await sha256Streaming(blob, 1024)).toBe(await sha256WebCrypto(blob));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/utils/__tests__/file-hash.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the pure core**

```ts
// src/utils/file-hash.ts
import jsSHA from 'jssha';

export const OFFICIAL_MATCH_HASH_MAX_BYTES = 5 * 1024 ** 3; // 5 GB — above this, defer to server B.1b
const WEBCRYPTO_MAX_BYTES = 1024 ** 3; // ≤1 GB: native one-shot; larger: streamed jsSHA
const STREAM_CHUNK = 100 * 1024 * 1024; // 100 MB

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

// Native WebCrypto SHA-256 over the whole file — fastest, but buffers the
// entire file in memory. Used for ≤1 GB. Available in workers + node 20+.
export async function sha256WebCrypto(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return toHex(new Uint8Array(digest));
}

// Streaming SHA-256 via jsSHA — flat memory, handles arbitrarily large files.
// Used above the WebCrypto threshold. (NOT the broken hash-chaining variant —
// this feeds every chunk into one running digest via jsSHA.update.)
export async function sha256Streaming(blob: Blob, chunkSize: number = STREAM_CHUNK): Promise<string> {
  const sha = new jsSHA('SHA-256', 'ARRAYBUFFER');
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    const chunk = blob.slice(offset, offset + chunkSize);
    sha.update(await chunk.arrayBuffer());
  }
  return sha.getHash('HEX');
}

// Full-file SHA256 (lowercase hex) = byte identity, matching the stored
// ModelFileHash.SHA256. Dispatches native vs streaming on size.
export async function computeBlobSha256(blob: Blob): Promise<string> {
  return blob.size <= WEBCRYPTO_MAX_BYTES ? sha256WebCrypto(blob) : sha256Streaming(blob);
}
```

> `jssha` v3 has a default export and ships its own types. `crypto.subtle` needs a secure context (HTTPS or `localhost`) — both dev and prod qualify. Do **not** port `computeSHA256InChunks` from the reference snippet — it hash-chains and produces a wrong digest.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/utils/__tests__/file-hash.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Write the worker entry**

```ts
// src/workers/file-hash.worker.ts
import { computeBlobSha256 } from '~/utils/file-hash';

export type FileHashRequest = { file: File };
export type FileHashResponse = { sha256: string } | { error: string };

self.onmessage = async (e: MessageEvent<FileHashRequest>) => {
  try {
    const sha256 = await computeBlobSha256(e.data.file);
    (self as unknown as Worker).postMessage({ sha256 } as FileHashResponse);
  } catch (err) {
    (self as unknown as Worker).postMessage({ error: (err as Error).message } as FileHashResponse);
  }
};
```

- [ ] **Step 7: Register the worker in the build script**

In `scripts/build-workers.mjs`, add to the `workers` array:

```js
  { in: 'src/workers/file-hash.worker.ts', out: 'public/workers/file-hash.worker.js' },
```

Run: `pnpm build:workers`
Expected: `public/workers/file-hash.worker.js` is written (log line `public/workers/file-hash.worker.js`).

- [ ] **Step 8: Write the hook**

```ts
// src/hooks/useFileHash.ts
import { useCallback } from 'react';
import { OFFICIAL_MATCH_HASH_MAX_BYTES } from '~/utils/file-hash';
import type { FileHashRequest, FileHashResponse } from '~/workers/file-hash.worker';

// Runs the full-file SHA256 in a dedicated Web Worker (off the main thread).
// Returns null when the file is over the cap (defer to server B.1b) or the
// worker errors — callers treat null as "no client match, upload normally".
export function useFileHash() {
  const hashFile = useCallback((file: File): Promise<string | null> => {
    if (file.size > OFFICIAL_MATCH_HASH_MAX_BYTES) return Promise.resolve(null);
    return new Promise((resolve) => {
      // Static path (not new URL(import.meta.url)) — Turbopack can't compile
      // .ts worker entries; build:workers bundles it to /public. See build-workers.mjs.
      const worker = new Worker('/workers/file-hash.worker.js');
      worker.onmessage = (e: MessageEvent<FileHashResponse>) => {
        worker.terminate();
        resolve('sha256' in e.data ? e.data.sha256 : null);
      };
      worker.onerror = () => {
        worker.terminate();
        resolve(null);
      };
      worker.postMessage({ file } as FileHashRequest);
    });
  }, []);

  return { hashFile };
}
```

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml src/utils/file-hash.ts src/utils/__tests__/file-hash.test.ts src/workers/file-hash.worker.ts scripts/build-workers.mjs src/hooks/useFileHash.ts
git commit -m "feat(model-files): client SHA256 worker + hook for official-match dedup"
```

---

### Task 7: B.1a — wire prevent-the-upload into FilesProvider

A pure decision helper (testable with stubbed queries) plus its wiring at the top of `handleUpload`.

**Files:**
- Create: `src/components/Resource/official-match.ts` (pure decision helper)
- Modify: `src/components/Resource/FilesProvider.tsx` (`handleUpload` intercept `:551`)
- Test: `src/components/Resource/__tests__/official-match.test.ts`

**Interfaces:**
- Consumes: `primaryModelFileTypes` (`~/utils/file-display-helpers`); `OfficialFileMatch` (`~/server/services/official-file.service`).
- Produces: `resolveOfficialMatch(args): Promise<OfficialFileMatch | null>` where
  `args = { file: File; hostType: string; findBySize: (size: number) => Promise<{ id: number }[]>; hashFile: (file: File) => Promise<string | null>; findByHash: (a: { sha256: string; hostType: string }) => Promise<OfficialFileMatch | null> }`

- [ ] **Step 1: Write the failing test**

```ts
// src/components/Resource/__tests__/official-match.test.ts
import { describe, it, expect, vi } from 'vitest';
import { resolveOfficialMatch } from '~/components/Resource/official-match';

const file = { size: 1000 } as File;
const match = { versionId: 42, fileId: 900, modelId: 7, modelName: 'Boogu VAE', versionName: 'v1', fileName: 'x', sizeKB: 1, componentType: 'VAE' } as const;

const deps = (over = {}) => ({
  file, hostType: 'VAE',
  findBySize: vi.fn().mockResolvedValue([{ id: 900 }]),
  hashFile: vi.fn().mockResolvedValue('abc'),
  findByHash: vi.fn().mockResolvedValue(match),
  ...over,
});

describe('resolveOfficialMatch', () => {
  it('returns the match when size collides and hash confirms', async () => {
    expect(await resolveOfficialMatch(deps())).toEqual(match);
  });

  it('returns null (no hashing) for a primary-weights host', async () => {
    const d = deps({ hostType: 'Model' });
    expect(await resolveOfficialMatch(d)).toBeNull();
    expect(d.findBySize).not.toHaveBeenCalled();
    expect(d.hashFile).not.toHaveBeenCalled();
  });

  it('returns null (no hashing) when no official file shares the size', async () => {
    const d = deps({ findBySize: vi.fn().mockResolvedValue([]) });
    expect(await resolveOfficialMatch(d)).toBeNull();
    expect(d.hashFile).not.toHaveBeenCalled();
  });

  it('returns null when the file is over the hash cap (hashFile → null)', async () => {
    const d = deps({ hashFile: vi.fn().mockResolvedValue(null) });
    expect(await resolveOfficialMatch(d)).toBeNull();
    expect(d.findByHash).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/Resource/__tests__/official-match.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the decision helper**

```ts
// src/components/Resource/official-match.ts
import { primaryModelFileTypes } from '~/utils/file-display-helpers';
import type { ModelFileType } from '~/server/common/constants';
import type { OfficialFileMatch } from '~/server/services/official-file.service';

// Staged cheap→definitive check: host-type gate → size gate → worker hash →
// hash confirm. Every early exit means "upload normally".
export async function resolveOfficialMatch(args: {
  file: File;
  hostType: string;
  findBySize: (size: number) => Promise<{ id: number }[]>;
  hashFile: (file: File) => Promise<string | null>;
  findByHash: (a: { sha256: string; hostType: string }) => Promise<OfficialFileMatch | null>;
}): Promise<OfficialFileMatch | null> {
  const { file, hostType, findBySize, hashFile, findByHash } = args;
  if (primaryModelFileTypes.includes(hostType as ModelFileType)) return null;

  const sized = await findBySize(file.size);
  if (sized.length === 0) return null;

  const sha256 = await hashFile(file);
  if (!sha256) return null; // over cap or worker error → defer to B.1b

  return findByHash({ sha256, hostType });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/Resource/__tests__/official-match.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire into `handleUpload`**

In `src/components/Resource/FilesProvider.tsx`, add imports:

```ts
import { useFileHash } from '~/hooks/useFileHash';
import { resolveOfficialMatch } from '~/components/Resource/official-match';
```

Inside the provider body (near `const queryUtils = trpc.useUtils();`, `:94`), add:

```ts
  const { hashFile } = useFileHash();
```

At the very top of `handleUpload` (`:562`, right after the `if (!file || !type) return;` guard), insert the intercept:

```ts
    const officialMatch = await resolveOfficialMatch({
      file,
      hostType: type,
      findBySize: (size) => queryUtils.modelFile.findOfficialFilesBySize.fetch({ size }),
      hashFile,
      findByHash: (a) => queryUtils.modelFile.findOfficialFileByHash.fetch(a),
    });

    if (officialMatch && versionId) {
      // Bytes already exist on the official account — skip the upload and the
      // createFile row entirely; create a linked-component pointer instead.
      const result = await addLinkedComponentMutation.mutateAsync({
        id: versionId,
        targetVersionId: officialMatch.versionId,
        targetFileId: officialMatch.fileId,
        componentType: officialMatch.componentType,
        modelId: officialMatch.modelId,
        modelName: officialMatch.modelName,
        versionName: officialMatch.versionName,
        isRequired: isRequired ?? true,
      });
      const enriched: LinkedComponent = {
        recommendedResourceId: result.recommendedResourceId,
        componentType: result.componentType as ModelFileComponentType,
        modelId: result.modelId,
        modelName: result.modelName,
        versionId: result.versionId,
        versionName: result.versionName,
        fileId: result.fileId,
        fileName: result.fileName,
        sizeKB: result.sizeKB,
        fileType: result.fileType,
        fileMetadata: result.fileMetadata ?? undefined,
        isRequired: result.isRequired,
      };
      setLinkedComponents((prev) => [...prev, enriched]);
      setFiles((state) => state.filter((x) => x.uuid !== uuid));
      showSuccessNotification({
        title: 'Linked to official file',
        message: `${officialMatch.modelName} already hosts this file — upload skipped.`,
      });
      return;
    }
```

> Match the exact `LinkedComponent` enrichment shape already used at `FilesProvider.tsx:224-237`; if a field name differs there, use theirs. Confirm `showSuccessNotification` is already imported in this file (it is used across the Resource components) — if not, import from `~/utils/notifications`.

- [ ] **Step 6: Run the helper test + build workers**

Run: `pnpm vitest run src/components/Resource/__tests__/official-match.test.ts`
Expected: PASS.

Run: `pnpm build:workers`
Expected: worker bundle present.

- [ ] **Step 7: Manual verification**

1. As a non-official user, add a component file (e.g. a VAE) byte-identical to an official file → the file card flips to a linked-component "Linked to official … — upload skipped"; confirm no S3 object and no `ModelFile` row were created (network tab shows no `/api/upload`; DB shows no new file).
2. Add a unique file of the same size as an official file → worker hashes once, no match, uploads normally.
3. Delete the official source file → the dependent component disappears from the model page (Task 3) and its download returns not-found (never a 404 of wrong bytes).

- [ ] **Step 8: Commit**

```bash
git add src/components/Resource/official-match.ts src/components/Resource/__tests__/official-match.test.ts src/components/Resource/FilesProvider.tsx
git commit -m "feat(model-files): B.1a prevent upload when bytes match an official file"
```

---

## Self-Review

**Spec coverage:**
- §1 shared foundation → Task 1 (helpers), Global Constraints.
- §2 B.1a → Task 6 (worker/hook) + Task 7 (helper + wiring); host-type gate, size gate, hash confirm, skip-upload-create-pointer all present.
- §3 B.1b → Task 4.
- §4 B.2 → Task 5 (hourly cron, cursor via getJobDate, host-type guard, canonical un-filtered, per-version sequential).
- §5 tRPC surface → Task 2.
- §6 read-path staleness → Task 3 (both controllers). Download-path caveats (§6.1/§6.2) are recorded as out-of-scope in the spec; no task needed (current behavior already returns not-found).
- §8 testing → tests folded into each task.

**Placeholder scan:** none — every code/test step carries full code and an exact `pnpm vitest run` command with expected output.

**Type consistency:** `OfficialFileMatch` defined in Task 1 is consumed unchanged in Tasks 2, 4, 5, 7. `componentType` is always host-derived. `findOfficialFileByHash({ sha256, hostType })` signature identical across Tasks 1/2/4/7. `hashFile: (file) => Promise<string | null>` identical in Task 6 hook and Task 7 helper. Job export `dedupeOfficialUploadsJob` matches the registration in Task 5 Step 5.

**Known follow-ups to confirm during execution (flagged inline, not blockers):** exact `getJobDate`/`setJobDate` names (Task 5 Step 3); possible lazy import if a scan↔model-version cycle appears (Task 4 Step 4); `Model.status` string literal `'Published'` in the raw query (Task 5); exact `LinkedComponent` field names at `FilesProvider.tsx:224-237` (Task 7 Step 5).
