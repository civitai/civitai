import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as S3Utils from '~/utils/s3-utils';

const { mockDeleteManyObjects } = vi.hoisted(() => ({ mockDeleteManyObjects: vi.fn() }));

vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  deleteManyObjects: mockDeleteManyObjects,
  getS3Client: () => ({}),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import {
  CLEAR_VAULT_ITEMS_MAX_ITEMS_PER_RUN,
  CLEAR_VAULT_ITEMS_TIME_BUDGET_MS,
  runClearVaultItems,
} from '~/server/jobs/clear-vault-items';
import {
  deleteVaultItems,
  VAULT_OBJECT_DELETE_TIMEOUT_MS,
} from '~/server/services/vault-item-deletion';

type Item = {
  id: number;
  vaultId: number;
  modelVersionId: number;
  createdAt: number;
  detailsSizeKb: number;
  imagesSizeKb: number;
  modelSizeKb: number;
};

let items: Item[];
let deletionOrder: string[];
let objectDeleteCalls: number;
let failKeys: Set<string>;
let onObjectDelete: (() => void) | undefined;
let clock: number;

const addItem = (vaultId: number, createdAt: number, sizes: [number, number, number]) => {
  const id = items.length + 1;
  const [detailsSizeKb, imagesSizeKb, modelSizeKb] = sizes;
  items.push({
    id,
    vaultId,
    modelVersionId: vaultId * 10_000 + id,
    createdAt,
    detailsSizeKb,
    imagesSizeKb,
    modelSizeKb,
  });
  return items[items.length - 1];
};
const addVault = (vaultId: number, count: number, sizeKb = 1) => {
  for (let n = 0; n < count; n++) addItem(vaultId, items.length + 1, [0, 0, sizeKb]);
};
const remaining = (vaultId: number) => items.filter((i) => i.vaultId === vaultId);

const runningContext = () => ({
  status: 'running' as 'running' | 'canceled' | 'finished',
  checkIfCanceled() {
    if (this.status !== 'running') throw new Error('Job has ended');
  },
});
// Fake time, so a loop that stops making progress ends at the budget instead of spinning for real minutes.
const run = (jobContext = runningContext()) =>
  runClearVaultItems({ jobContext, now: () => clock++ });

beforeEach(() => {
  items = [];
  deletionOrder = [];
  objectDeleteCalls = 0;
  failKeys = new Set();
  onObjectDelete = undefined;
  clock = 0;
  setEnv({ S3_VAULT_BUCKET: 'vault-bucket' });
  dbMock.dbWrite.$queryRaw.mockReset();
  loggingMock.logToAxiom.mockImplementation(() => Promise.resolve());

  mockDeleteManyObjects.mockReset().mockImplementation(async (_bucket: string, keys: string[]) => {
    objectDeleteCalls++;
    deletionOrder.push(`objects:${keys.length}`);
    onObjectDelete?.();
    return { Errors: keys.filter((k) => failKeys.has(k)).map((Key) => ({ Key, Code: 'Err' })) };
  });

  dbMock.dbWrite.vaultItem.findMany.mockImplementation((async ({ where, orderBy, take }: any) => {
    const order = orderBy as Record<string, 'asc' | 'desc'>[];
    return remaining(where.vaultId)
      .sort((a: any, b: any) => {
        for (const clause of order) {
          const [field, dir] = Object.entries(clause)[0];
          if (a[field] !== b[field])
            return (a[field] < b[field] ? -1 : 1) * (dir === 'asc' ? 1 : -1);
        }
        return 0;
      })
      .slice(0, take);
  }) as any);
  dbMock.dbWrite.vaultItem.deleteMany.mockImplementation((async ({ where }: any) => {
    const ids = new Set<number>(where.modelVersionId.in);
    const before = items.length;
    items = items.filter((i) => !(i.vaultId === where.vaultId && ids.has(i.modelVersionId)));
    deletionOrder.push(`rows:${before - items.length}`);
    return { count: before - items.length };
  }) as any);
});

const overCap = (...vaults: [userId: number, storageKb: number][]) =>
  dbMock.dbWrite.$queryRaw.mockResolvedValue(
    vaults.map(([userId, storageKb]) => ({ userId, storageKb })) as any
  );

describe('clear-vault-items', () => {
  it('deletes the oldest items by createdAt, counting every size column, until under the cap', async () => {
    // Insertion order differs from createdAt order, and each item's 60 KB is spread over all
    // three columns, so dropping a column or the sort changes which items survive.
    const newest = addItem(1, 300, [20, 20, 20]);
    addItem(1, 100, [20, 20, 20]);
    addItem(1, 200, [20, 20, 20]);
    overCap([1, 100]);

    const summary = await run();

    expect(remaining(1).map((i) => i.id)).toEqual([newest.id]);
    expect(summary).toMatchObject({
      itemsDeleted: 2,
      vaultsTrimmed: 1,
      vaultsLeftOverCap: 0,
      stoppedBy: 'done',
    });
  });

  it('measures usage over the whole vault, not only the batch it deletes from', async () => {
    addVault(1, 100);
    // The 50 oldest items alone fit under this cap; the vault as a whole does not.
    overCap([1, 60]);

    await run();

    expect(remaining(1)).toHaveLength(60);
  });

  it('breaks a createdAt tie by id, oldest first', async () => {
    addItem(1, 100, [0, 0, 1]);
    const second = addItem(1, 100, [0, 0, 1]);
    overCap([1, 1]);

    await run();

    expect(remaining(1).map((i) => i.id)).toEqual([second.id]);
  });

  it('refuses to run without a vault bucket, before selecting or deleting anything', async () => {
    setEnv({ S3_VAULT_BUCKET: undefined });
    addVault(1, 1);
    overCap([1, 0]);

    await expect(run()).rejects.toThrow('S3_VAULT_BUCKET is not defined');

    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(remaining(1)).toHaveLength(1);
  });

  it('deletes stored objects before the rows that record their keys', async () => {
    addVault(1, 2);
    overCap([1, 0]);

    await run();

    expect(deletionOrder).toEqual(['objects:6', 'rows:2']);
  });

  it('keeps every row when the object delete throws, and moves on to the next vault', async () => {
    addVault(1, 2);
    addVault(2, 1);
    overCap([1, 0], [2, 0]);
    mockDeleteManyObjects.mockRejectedValueOnce(new Error('R2 unavailable'));

    const summary = await run();

    expect(remaining(1)).toHaveLength(2);
    expect(remaining(2)).toHaveLength(0);
    expect(summary).toMatchObject({ vaultsFailed: 1, itemsDeleted: 1, vaultsLeftOverCap: 1 });
  });

  it('keeps the row of an item whose objects failed to delete, and stops trimming that vault', async () => {
    addVault(1, 3);
    overCap([1, 0]);
    const [, second] = remaining(1);
    failKeys.add(`${second.modelVersionId}/1/images.zip`);

    const summary = await run();

    expect(remaining(1).map((i) => i.id)).toEqual([second.id]);
    expect(objectDeleteCalls).toBe(1);
    expect(summary).toMatchObject({ vaultsFailed: 1, itemsDeleted: 2, vaultsLeftOverCap: 1 });
  });

  it('re-reads usage every batch, so items removed elsewhere mid-run are not deleted twice over', async () => {
    addVault(1, 100);
    overCap([1, 30]);
    // During the first batch of 50, the member removes the 30 newest items: usage is now 20.
    onObjectDelete = () => {
      if (objectDeleteCalls === 1) items = items.filter((i) => i.id <= 70);
    };

    await run();

    expect(remaining(1)).toHaveLength(20);
  });

  it(`stops at ${CLEAR_VAULT_ITEMS_MAX_ITEMS_PER_RUN} items and leaves the rest for the next run`, async () => {
    // 30 does not divide the cap, so the cap lands part-way through a vault.
    const vaultCount = Math.ceil(CLEAR_VAULT_ITEMS_MAX_ITEMS_PER_RUN / 30) + 2;
    for (let v = 1; v <= vaultCount; v++) addVault(v, 30);
    overCap(...Array.from({ length: vaultCount }, (_, i) => [i + 1, 0] as [number, number]));

    const summary = await run();

    expect(summary.itemsDeleted).toBe(CLEAR_VAULT_ITEMS_MAX_ITEMS_PER_RUN);
    expect(items).toHaveLength(vaultCount * 30 - CLEAR_VAULT_ITEMS_MAX_ITEMS_PER_RUN);
    expect(summary).toMatchObject({ stoppedBy: 'item-cap', vaultsLeftOverCap: 3 });
  });

  it('stops when the time budget runs out, mid-vault', async () => {
    addVault(1, 500);
    overCap([1, 0]);
    let time = 0;
    onObjectDelete = () => {
      time += 60_000;
    };

    const summary = await runClearVaultItems({ jobContext: runningContext(), now: () => time });

    expect(objectDeleteCalls).toBe(CLEAR_VAULT_ITEMS_TIME_BUDGET_MS / 60_000);
    expect(remaining(1)).toHaveLength(500 - objectDeleteCalls * 50);
    expect(summary).toMatchObject({ stoppedBy: 'time-budget', avgBatchMs: 60_000 });
  });

  it('stops deleting once the run is canceled', async () => {
    addVault(1, 200);
    addVault(2, 1);
    overCap([1, 0], [2, 0]);
    const jobContext = runningContext();
    onObjectDelete = () => {
      jobContext.status = 'canceled';
    };

    await expect(run(jobContext)).rejects.toThrow('Job has ended');

    expect(objectDeleteCalls).toBe(1);
    expect(remaining(1)).toHaveLength(150);
    expect(remaining(2)).toHaveLength(1);
  });
});

describe('deleteVaultItems', () => {
  const deleteAll = (userId: number) =>
    deleteVaultItems({ userId, modelVersionIds: remaining(userId).map((i) => i.modelVersionId) });

  it('splits object deletes to stay within the 1,000-key request limit', async () => {
    addVault(1, 400);

    const result = await deleteAll(1);

    expect(mockDeleteManyObjects.mock.calls.map(([, keys]) => keys.length)).toEqual([999, 201]);
    expect(result.removedModelVersionIds).toHaveLength(400);
    expect(remaining(1)).toHaveLength(0);
  });

  it('removes the rows of each chunk before the next chunk, so a later failure strands nothing', async () => {
    addVault(1, 400);
    mockDeleteManyObjects
      .mockImplementationOnce(async () => ({ Errors: [] }))
      .mockRejectedValueOnce(new Error('R2 unavailable'));

    await expect(deleteAll(1)).rejects.toThrow('R2 unavailable');

    expect(remaining(1)).toHaveLength(400 - 333);
  });

  it('bounds each object delete with a timeout shorter than the run budget', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    addVault(1, 1);

    await deleteAll(1);

    expect(timeout).toHaveBeenCalledWith(VAULT_OBJECT_DELETE_TIMEOUT_MS);
    expect(mockDeleteManyObjects.mock.calls[0][3]?.abortSignal).toBe(timeout.mock.results[0].value);
    expect(VAULT_OBJECT_DELETE_TIMEOUT_MS).toBeLessThan(CLEAR_VAULT_ITEMS_TIME_BUDGET_MS);
    timeout.mockRestore();
  });

  it('keeps every row in a request when an error names no key', async () => {
    addVault(1, 2);
    mockDeleteManyObjects.mockResolvedValueOnce({ Errors: [{ Code: 'InternalError' }] });

    const result = await deleteAll(1);

    expect(result.removedModelVersionIds).toEqual([]);
    expect(remaining(1)).toHaveLength(2);
  });

  it('treats an object that is already gone as deleted', async () => {
    const item = addItem(1, 1, [0, 0, 1]);
    mockDeleteManyObjects.mockResolvedValueOnce({
      Errors: [{ Key: `${item.modelVersionId}/1/cover.jpg`, Code: 'NoSuchKey' }],
    });

    await deleteAll(1);

    expect(remaining(1)).toHaveLength(0);
  });

  // No vault bucket locally (.env-example sets none), so there is nothing stored to orphan.
  it('removes rows without touching storage when no vault bucket is configured', async () => {
    setEnv({ S3_VAULT_BUCKET: undefined });
    addVault(1, 2);

    await deleteAll(1);

    expect(mockDeleteManyObjects).not.toHaveBeenCalled();
    expect(remaining(1)).toHaveLength(0);
  });
});
