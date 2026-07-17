import { beforeEach, describe, expect, it } from 'vitest';
import {
  createEntityAppeal,
  getAppealById,
  getAppealCount,
  getAppealImageEntity,
  getPendingAppealsForResolve,
  getRecentAppealsByUserId,
  setAppealStatusMany,
  setImageAppealStatus,
} from './appeal.db';
import { compileHarness } from './test/harness';

const h = compileHarness();

beforeEach(() => {
  h.queries.length = 0;
});

describe('getRecentAppealsByUserId', () => {
  it("selects a user's 10 most recent appeals, newest first", async () => {
    await getRecentAppealsByUserId(h.db, 42);
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe(
      'select * from "Appeal" where "userId" = $1 order by "createdAt" desc limit $2'
    );
    expect(parameters).toEqual([42, 10]);
  });
});

describe('getAppealCount', () => {
  it('short-circuits an empty status list without touching the DB', async () => {
    const result = await getAppealCount(h.db, { userId: 42, status: [] });
    expect(result).toBe(0);
    expect(h.queries).toHaveLength(0);
  });

  it("counts a user's appeals filtered by status and startDate", async () => {
    const startDate = new Date('2026-01-01');
    await getAppealCount(h.db, {
      userId: 42,
      status: ['Pending', 'Rejected'],
      startDate,
    });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe(
      'select count(*) as "count" from "Appeal" ' +
        'where "userId" = $1 and "status" in ($2, $3) and "createdAt" >= $4'
    );
    expect(sql).not.toContain('in ()');
    expect(parameters).toEqual([42, 'Pending', 'Rejected', startDate]);
  });

  it('omits the createdAt predicate when startDate is absent', async () => {
    await getAppealCount(h.db, { userId: 42, status: ['Pending'] });
    const { sql } = h.lastQuery();
    expect(sql).not.toContain('"createdAt"');
  });
});

describe('getAppealById', () => {
  it('selects one appeal by id', async () => {
    await getAppealById(h.db, 7);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe('select * from "Appeal" where "id" = $1');
    expect(parameters).toEqual([7]);
  });
});

describe('getAppealImageEntity', () => {
  it('selects the image detail fields for an image appeal', async () => {
    await getAppealImageEntity(h.db, 99);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe('select "id", "url", "userId" from "Image" where "id" = $1');
    expect(parameters).toEqual([99]);
  });
});

describe('getPendingAppealsForResolve', () => {
  it('short-circuits an empty id list without touching the DB', async () => {
    const result = await getPendingAppealsForResolve(h.db, { ids: [], entityType: 'Image' });
    expect(result).toEqual([]);
    expect(h.queries).toHaveLength(0);
  });

  it('selects pending appeals for the given entity ids and type', async () => {
    await getPendingAppealsForResolve(h.db, { ids: [1, 2], entityType: 'Image' });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe(
      'select "id", "entityId", "entityType", "resolvedAt", "buzzTransactionId", "status", "userId" ' +
        'from "Appeal" where "entityId" in ($1, $2) and "status" = $3 and "entityType" = $4'
    );
    expect(sql).not.toContain('in ()');
    expect(parameters).toEqual([1, 2, 'Pending', 'Image']);
  });
});

describe('createEntityAppeal', () => {
  it('inserts an appeal with a null buzzTransactionId by default and explicit updatedAt', async () => {
    // executeTakeFirstOrThrow rejects on the empty DummyDriver result, but the query is still logged first.
    await createEntityAppeal(h.db, {
      entityId: 5,
      entityType: 'Image',
      message: 'please review',
      userId: 42,
    }).catch(() => {});
    const { sql, parameters } = h.lastQuery();

    expect(sql).toContain('insert into "Appeal"');
    expect(sql).toContain('returning *');
    expect(parameters).toContain('Image');
    expect(parameters).toContain('please review');
    expect(parameters).toContain(42);
    expect(parameters).toContain(null); // buzzTransactionId
    expect(parameters.some((p) => p instanceof Date)).toBe(true); // updatedAt
  });
});

describe('setImageAppealStatus', () => {
  it('closes the pending appeal without resolvedMessage when omitted', async () => {
    await setImageAppealStatus(h.db, { imageId: 42, status: 'Approved', userId: 7 });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe(
      'update "Appeal" set "status" = $1, "resolvedBy" = $2, "resolvedAt" = $3, "updatedAt" = $4 ' +
        'where "entityType" = $5 and "entityId" = $6 and "status" = $7'
    );
    expect(sql).not.toContain('resolvedMessage');
    expect(parameters).toEqual([
      'Approved',
      7,
      expect.any(Date),
      expect.any(Date), // updatedAt, plugin-stamped (Appeal is @updatedAt; Prisma updateMany bumped it too)
      'Image',
      42,
      'Pending',
    ]);
  });

  it('includes resolvedMessage when provided (even null)', async () => {
    await setImageAppealStatus(h.db, {
      imageId: 42,
      status: 'Rejected',
      userId: 7,
      resolvedMessage: null,
    });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toContain('"resolvedMessage" = $4');
    expect(parameters).toEqual([
      'Rejected',
      7,
      expect.any(Date),
      null,
      expect.any(Date), // updatedAt, plugin-stamped
      'Image',
      42,
      'Pending',
    ]);
  });
});

describe('setAppealStatusMany', () => {
  it('short-circuits an empty id list without touching the DB', async () => {
    const result = await setAppealStatusMany(h.db, { ids: [], status: 'Approved' });
    expect(result).toEqual({ numUpdatedRows: BigInt(0) });
    expect(h.queries).toHaveLength(0);
  });

  it('bulk-closes appeals by id, stamping resolver + resolvedAt', async () => {
    await setAppealStatusMany(h.db, {
      ids: [1, 2],
      status: 'Approved',
      userId: 99,
      resolvedMessage: 'ok',
      internalNotes: 'note',
    });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe(
      'update "Appeal" set "status" = $1, "resolvedBy" = $2, "resolvedMessage" = $3, ' +
        '"internalNotes" = $4, "resolvedAt" = $5, "updatedAt" = $6 where "id" in ($7, $8)'
    );
    expect(sql).not.toContain('in ()');
    expect(parameters[0]).toBe('Approved');
    expect(parameters[1]).toBe(99);
    expect(parameters[2]).toBe('ok');
    expect(parameters[3]).toBe('note');
    expect(parameters[6]).toBe(1);
    expect(parameters[7]).toBe(2);
  });
});
