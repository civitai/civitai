import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteCollectionForUser,
  setCollectionItemNsfwLevel,
  updateCollectionItemsStatus,
  updateCollectionsNsfwLevels,
} from './collection.db';
import { compileHarness } from './test/harness';

const h = compileHarness();

beforeEach(() => {
  h.queries.length = 0;
});

describe('updateCollectionItemsStatus', () => {
  it('short-circuits an empty item list without a query', async () => {
    const result = await updateCollectionItemsStatus(h.db, {
      collectionId: 1,
      collectionItemIds: [],
      status: 'ACCEPTED',
      userId: 9,
    });
    expect(result).toEqual([]);
    expect(h.queries).toHaveLength(0);
  });

  it('stamps reviewer + status + updatedAt for the given items in one statement', async () => {
    await updateCollectionItemsStatus(h.db, {
      collectionId: 1,
      collectionItemIds: [10, 11],
      status: 'REJECTED',
      userId: 9,
    });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe(
      'update "CollectionItem" set "reviewedById" = $1, "reviewedAt" = $2, "updatedAt" = $3, "status" = $4 ' +
        'where "collectionId" = $5 and "id" in ($6, $7)'
    );
    expect(parameters[0]).toBe(9); // reviewedById
    expect(parameters[1]).toBeInstanceOf(Date); // reviewedAt
    expect(parameters[2]).toBeInstanceOf(Date); // updatedAt stamped, not left to a trigger
    expect(parameters[3]).toBe('REJECTED');
    expect(parameters[4]).toBe(1);
    expect(parameters[5]).toBe(10);
    expect(parameters[6]).toBe(11);
  });
});

describe('setCollectionItemNsfwLevel', () => {
  it('marks the image scanned at the assigned level, stamping updatedAt', async () => {
    await setCollectionItemNsfwLevel(h.db, { imageId: 55, nsfwLevel: 4 });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe(
      'update "Image" set "nsfwLevel" = $1, "scannedAt" = $2, "ingestion" = $3, "updatedAt" = $4 ' +
        'where "id" = $5'
    );
    expect(parameters[0]).toBe(4);
    expect(parameters[1]).toBeInstanceOf(Date);
    expect(parameters[2]).toBe('Scanned');
    expect(parameters[3]).toBeInstanceOf(Date);
    expect(parameters[4]).toBe(55);
  });
});

describe('updateCollectionsNsfwLevels', () => {
  it('short-circuits an empty id list without a query', async () => {
    const result = await updateCollectionsNsfwLevels(h.db, []);
    expect(result).toEqual([]);
    expect(h.queries).toHaveLength(0);
  });

  it('recomputes and writes only changed collections, returning changed ids', async () => {
    await updateCollectionsNsfwLevels(h.db, [1, 2]);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toContain('UPDATE "Collection"');
    expect(sql).toContain('forcedBrowsingLevel');
    expect(sql).toContain('c."nsfwLevel" != c2."nsfwLevel"');
    expect(sql).toContain('RETURNING c.id');
    expect(sql).not.toContain('IN ()');
    expect(parameters).toContain(1);
    expect(parameters).toContain(2);
  });
});

describe('deleteCollectionForUser', () => {
  it("deletes the user's collections", async () => {
    await deleteCollectionForUser(h.db, 7);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe('delete from "Collection" where "userId" = $1');
    expect(parameters).toEqual([7]);
  });
});
