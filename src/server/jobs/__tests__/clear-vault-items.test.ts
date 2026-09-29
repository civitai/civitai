import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as S3Utils from '~/utils/s3-utils';

const { mockDeleteManyObjects } = vi.hoisted(() => ({ mockDeleteManyObjects: vi.fn() }));

vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  deleteManyObjects: mockDeleteManyObjects,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import {
  CLEAR_VAULT_ITEMS_MAX_ITEMS_PER_RUN,
  CLEAR_VAULT_ITEMS_TIME_BUDGET_MS,
  runClearVaultItems,
} from '~/server/jobs/clear-vault-items';
import { deleteVaultItems } from '~/server/services/vault-item-deletion';

type Item = { id: number; vaultId: number; modelVersionId: number; sizeKb: number };

// In-memory vault store behind the Prisma calls the job makes. `events` records the order in
// which objects and rows are deleted.
let items: Item[];
let events: string[];
let objectDeleteCalls: number;
let failKeys: Set<string>;
let onObjectDelete: (() => void) | undefined;

const addVault = (vaultId: number, sizes: number[]) => {
  for (const sizeKb of sizes) {
    const id = items.length + 1;
    items.push({ id, vaultId, modelVersionId: vaultId * 10_000 + id, sizeKb });
  }
};
const remaining = (vaultId: number) => items.filter((i) => i.vaultId === vaultId);

const runningContext = () => ({
  status: 'running' as 'running' | 'canceled' | 'finished',
  checkIfCanceled() {
    if (this.status !== 'running') throw new Error('Job has ended');
  },
});

beforeEach(() => {
  items = [];
  events = [];
  objectDeleteCalls = 0;
  failKeys = new Set();
  onObjectDelete = undefined;
  setEnv({ S3_VAULT_BUCKET: 'vault-bucket' });
  loggingMock.logToAxiom.mockImplementation(() => Promise.resolve());

  mockDeleteManyObjects.mockReset().mockImplementation(async (_bucket: string, keys: string[]) => {
    objectDeleteCalls++;
    // A fake that never stopped deleting would loop forever instead of failing an assertion.
    if (objectDeleteCalls > 500) throw new Error('object delete called more than 500 times');
    events.push(`objects:${keys.length}`);
    onObjectDelete?.();
    return { Errors: keys.filter((k) => failKeys.has(k)).map((Key) => ({ Key, Code: 'Err' })) };
  });

  dbMock.dbWrite.vaultItem.aggregate.mockImplementation((async ({ where }: any) => ({
    _sum: {
      detailsSizeKb: 0,
      imagesSizeKb: 0,
      modelSizeKb: remaining(where.vaultId).reduce((acc, i) => acc + i.sizeKb, 0),
    },
  })) as any);
  dbMock.dbWrite.vaultItem.findMany.mockImplementation((async ({ where, take }: any) =>
    remaining(where.vaultId)
      .sort((a, b) => a.id - b.id)
      .slice(0, take)
      .map((i) => ({
        modelVersionId: i.modelVersionId,
        detailsSizeKb: 0,
        imagesSizeKb: 0,
        modelSizeKb: i.sizeKb,
      }))) as any);
  dbMock.dbWrite.vaultItem.deleteMany.mockImplementation((async ({ where }: any) => {
    const ids = new Set<number>(where.modelVersionId.in);
    const before = items.length;
    items = items.filter((i) => !(i.vaultId === where.vaultId && ids.has(i.modelVersionId)));
    events.push(`rows:${before - items.length}`);
    return { count: before - items.length };
  }) as any);
});

const overCap = (...vaults: [userId: number, storageKb: number][]) =>
  dbMock.dbWrite.$queryRaw.mockResolvedValue(
    vaults.map(([userId, storageKb]) => ({ userId, storageKb })) as any
  );

describe('clear-vault-items', () => {
  it('deletes the oldest items only until the vault is back under its cap', async () => {
    addVault(1, [60, 60, 60]);
    overCap([1, 100]);

    const summary = await runClearVaultItems({ jobContext: runningContext() });

    expect(remaining(1).map((i) => i.id)).toEqual([3]);
    expect(summary.itemsDeleted).toBe(2);
  });

  it('deletes stored objects before the rows that record their keys', async () => {
    addVault(1, [10, 10]);
    overCap([1, 0]);

    await runClearVaultItems({ jobContext: runningContext() });

    expect(events).toEqual(['objects:6', 'rows:2']);
  });

  it('keeps every row when the object delete throws, and moves on to the next vault', async () => {
    addVault(1, [10, 10]);
    addVault(2, [10]);
    overCap([1, 0], [2, 0]);
    mockDeleteManyObjects.mockRejectedValueOnce(new Error('R2 unavailable'));

    const summary = await runClearVaultItems({ jobContext: runningContext() });

    expect(remaining(1)).toHaveLength(2);
    expect(remaining(2)).toHaveLength(0);
    expect(summary).toMatchObject({ vaultsFailed: 1, itemsDeleted: 1 });
  });

  it('keeps the row of an item whose objects failed to delete, and stops trimming that vault', async () => {
    addVault(1, [10, 10, 10]);
    overCap([1, 0]);
    const [, second] = remaining(1);
    failKeys.add(`${second.modelVersionId}/1/images.zip`);

    const summary = await runClearVaultItems({ jobContext: runningContext() });

    expect(remaining(1).map((i) => i.id)).toEqual([second.id]);
    expect(objectDeleteCalls).toBe(1);
    expect(summary).toMatchObject({ vaultsFailed: 1, itemsDeleted: 2 });
  });

  it('re-reads usage every batch, so items removed elsewhere mid-run are not deleted twice over', async () => {
    addVault(1, Array(100).fill(1));
    overCap([1, 30]);
    // After the first batch of 50, something else removes the 30 newest items: usage is now 20.
    onObjectDelete = () => {
      if (objectDeleteCalls === 1) items = items.filter((i) => i.id <= 70);
    };

    await runClearVaultItems({ jobContext: runningContext() });

    expect(remaining(1)).toHaveLength(20);
  });

  it(`stops at ${CLEAR_VAULT_ITEMS_MAX_ITEMS_PER_RUN} items and leaves the rest for the next run`, async () => {
    // 30 does not divide the cap, so the cap lands part-way through a vault.
    const vaultCount = Math.ceil(CLEAR_VAULT_ITEMS_MAX_ITEMS_PER_RUN / 30) + 2;
    for (let v = 1; v <= vaultCount; v++) addVault(v, Array(30).fill(1));
    overCap(...Array.from({ length: vaultCount }, (_, i) => [i + 1, 0] as [number, number]));

    const summary = await runClearVaultItems({ jobContext: runningContext() });

    expect(summary.itemsDeleted).toBe(CLEAR_VAULT_ITEMS_MAX_ITEMS_PER_RUN);
    expect(items).toHaveLength(vaultCount * 30 - CLEAR_VAULT_ITEMS_MAX_ITEMS_PER_RUN);
    expect(summary.stoppedBy).toBe('item-cap');
  });

  it('stops when the time budget runs out, mid-vault', async () => {
    addVault(1, Array(500).fill(1));
    overCap([1, 0]);
    let clock = 0;
    onObjectDelete = () => {
      clock += 60_000;
    };

    const summary = await runClearVaultItems({ jobContext: runningContext(), now: () => clock });

    expect(objectDeleteCalls).toBe(CLEAR_VAULT_ITEMS_TIME_BUDGET_MS / 60_000);
    expect(remaining(1)).toHaveLength(500 - objectDeleteCalls * 50);
    expect(summary.stoppedBy).toBe('time-budget');
  });

  it('stops deleting once the run is canceled', async () => {
    addVault(1, Array(200).fill(1));
    addVault(2, [1]);
    overCap([1, 0], [2, 0]);
    const jobContext = runningContext();
    onObjectDelete = () => {
      jobContext.status = 'canceled';
    };

    await expect(runClearVaultItems({ jobContext })).rejects.toThrow('Job has ended');

    expect(objectDeleteCalls).toBe(1);
    expect(remaining(1)).toHaveLength(150);
    expect(remaining(2)).toHaveLength(1);
  });
});

describe('deleteVaultItems', () => {
  it('splits object deletes to stay within the 1,000-key request limit', async () => {
    addVault(1, Array(400).fill(1));

    const result = await deleteVaultItems({
      userId: 1,
      modelVersionIds: remaining(1).map((i) => i.modelVersionId),
    });

    expect(mockDeleteManyObjects.mock.calls.map(([, keys]) => keys.length)).toEqual([999, 201]);
    expect(result.removedModelVersionIds).toHaveLength(400);
    expect(remaining(1)).toHaveLength(0);
  });

  it('keeps every row in a request when an error names no key', async () => {
    addVault(1, [1, 1]);
    mockDeleteManyObjects.mockResolvedValueOnce({ Errors: [{ Code: 'InternalError' }] });

    const result = await deleteVaultItems({
      userId: 1,
      modelVersionIds: remaining(1).map((i) => i.modelVersionId),
    });

    expect(result.removedModelVersionIds).toEqual([]);
    expect(remaining(1)).toHaveLength(2);
  });
});
