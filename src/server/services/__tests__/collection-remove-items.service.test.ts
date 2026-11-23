import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Removing several items from one collection (a folder's "move"): every item is removed, past
 * the first batch too, and the caller's permissions on the collection are read once. Each item
 * still goes through the single remove's own checks. Ids are invented.
 */

const { removeCollectionItems } = await import('~/server/services/collection.service');

const COLLECTION = 10;
const OWNER = 5;
const ITEM_IDS = Array.from({ length: 23 }, (_, i) => 100 + i);

let permissionReads = 0;

beforeEach(() => {
  vi.clearAllMocks();
  permissionReads = 0;
  dbMock.dbRead.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = Prisma.sql(strings, ...(values as never[])).text;
    if (text.includes('FROM "Collection" c')) {
      permissionReads++;
      return [
        {
          id: COLLECTION,
          read: 'Private',
          write: 'Private',
          userId: OWNER,
          type: 'Model',
          mode: null,
          contributorPermissions: ['MANAGE', 'ADD', 'VIEW'],
          collaborationDisabledAt: null,
        },
      ];
    }
    return [{ userId: OWNER }];
  }) as never);
  // Each item has one row, added by the owner.
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    _s: TemplateStringsArray,
    ...values: unknown[]
  ) => [{ id: Number(values.at(-1)) + 1000, addedById: OWNER, note: null }]) as never);
});

describe('removeCollectionItems', () => {
  it('removes every item and reads the collection permissions once', async () => {
    await removeCollectionItems({
      collectionId: COLLECTION,
      itemIds: ITEM_IDS,
      userId: OWNER,
      type: 'Model',
    });
    const deleted = dbMock.dbWrite.collectionItem.deleteMany.mock.calls.flatMap(
      ([args]) => (args as { where: { id: { in: number[] } } }).where.id.in
    );
    expect(deleted.sort()).toEqual(ITEM_IDS.map((id) => id + 1000).sort());
    expect(permissionReads).toBe(1);
  });
});
