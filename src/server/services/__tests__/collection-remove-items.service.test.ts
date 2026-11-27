import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Removing several items from one collection (a folder's "move"): every item is removed, with the
 * single remove's checks applied per item, the permissions read once and the item rows read in
 * one query each. A refused item removes none. Ids are invented.
 */

const { removeCollectionItems } = await import('~/server/services/collection.service');

const COLLECTION = 10;
const OWNER = 5;
const STRANGER = 6;
const CONTRIBUTOR = 7;
const ITEM_IDS = Array.from({ length: 23 }, (_, i) => 100 + i);

let permissionReads = 0;
let itemReads = 0;
let rowReads = 0;
let manage = true;
// Who owns each item; the owner unless a test says otherwise.
let itemOwner: (id: number) => number;

const sqlOf = (strings: TemplateStringsArray, values: unknown[]) =>
  Prisma.sql(strings, ...(values as never[]));

beforeEach(() => {
  vi.clearAllMocks();
  permissionReads = itemReads = rowReads = 0;
  manage = true;
  itemOwner = () => OWNER;
  dbMock.dbRead.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const query = sqlOf(strings, values);
    if (query.text.includes('FROM "Collection" c')) {
      permissionReads++;
      return [
        {
          id: COLLECTION,
          read: 'Private',
          write: 'Private',
          userId: OWNER,
          type: 'Model',
          mode: null,
          contributorPermissions: manage ? ['MANAGE', 'ADD', 'VIEW'] : ['ADD', 'VIEW'],
          collaborationDisabledAt: null,
        },
      ];
    }
    itemReads++;
    return (query.values as number[]).map((id) => ({ id, userId: itemOwner(id) }));
  }) as never);
  // Each item has one row, added by the owner.
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    rowReads++;
    const ids = (sqlOf(strings, values).values as number[]).slice(1);
    return ids.map((id) => ({ id: id + 1000, itemId: id, addedById: OWNER, note: null }));
  }) as never);
});

const remove = (userId = OWNER) =>
  removeCollectionItems({ collectionId: COLLECTION, itemIds: ITEM_IDS, userId, type: 'Model' });
const deleted = () =>
  dbMock.dbWrite.collectionItem.deleteMany.mock.calls.flatMap(
    ([args]) => (args as { where: { id: { in: number[] } } }).where.id.in
  );

describe('removeCollectionItems', () => {
  it('removes every item, reading permissions, items and rows once each', async () => {
    await remove();
    expect(deleted().sort()).toEqual(ITEM_IDS.map((id) => id + 1000).sort());
    expect([permissionReads, itemReads, rowReads]).toEqual([1, 1, 1]);
  });

  it("removes none when a contributor's batch holds one item someone else added", async () => {
    // A contributor without MANAGE: they may remove what they own or added, nothing else.
    manage = false;
    itemOwner = (id) => (id === ITEM_IDS[5] ? STRANGER : CONTRIBUTOR);
    dbMock.dbWrite.$queryRaw.mockImplementation((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) =>
      (sqlOf(strings, values).values as number[]).slice(1).map((id) => ({
        id: id + 1000,
        itemId: id,
        addedById: id === ITEM_IDS[5] ? STRANGER : CONTRIBUTOR,
        note: null,
      }))) as never);

    await expect(remove(CONTRIBUTOR)).rejects.toThrow(/permission/);
    expect(dbMock.dbWrite.collectionItem.deleteMany).not.toHaveBeenCalled();
  });
});
