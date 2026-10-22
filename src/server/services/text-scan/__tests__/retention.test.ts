import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { cleanupTextScanRows, TEXT_SCAN_CLEAN_ROW_ENTITY_TYPES } = await import(
  '~/server/services/text-scan/retention'
);

const em = dbMock.dbWrite.entityModeration;
const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => ({ id: from + i }));

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps queued *Once values; an unconsumed one would leak into the next test.
  em.findMany.mockReset();
  em.deleteMany.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
  em.findMany.mockResolvedValue([]);
  em.deleteMany.mockImplementation(async ({ where }: any) => ({ count: where.id.in.length }));
});
afterEach(() => vi.useRealTimers());

describe('cleanupTextScanRows', () => {
  it('deletes old shadow rows of graduated entities only', async () => {
    em.findMany.mockResolvedValueOnce(ids(3)).mockResolvedValueOnce([]);
    const result = await cleanupTextScanRows({
      graduatedEntityTypes: ['Post', 'Model'],
      cleanRowEntityTypes: [],
      olderThanDays: 14,
      batchSize: 10,
    });
    expect(em.findMany.mock.calls[0][0]).toMatchObject({
      where: {
        entityType: { in: ['Post:shadow', 'Model:shadow'] },
        updatedAt: { lt: new Date('2026-09-17T00:00:00Z') },
      },
      select: { id: true },
      take: 10,
    });
    expect(em.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [1, 2, 3] } } });
    expect(result).toMatchObject({ shadowDeleted: 3, cleanDeleted: 0, exhausted: false });
  });

  it('deletes old web-search shadow rows of graduated entities, never the live search rows', async () => {
    em.findMany.mockResolvedValueOnce(ids(2)).mockResolvedValueOnce([]);
    const result = await cleanupTextScanRows({
      graduatedEntityTypes: ['Post'],
      graduatedWebSearchEntityTypes: ['Model'],
      cleanRowEntityTypes: [],
      olderThanDays: 14,
    });
    expect(em.findMany.mock.calls[0][0].where).toEqual({
      entityType: { in: ['Post:shadow', 'Model:search-shadow'] },
      updatedAt: { lt: new Date('2026-09-17T00:00:00Z') },
    });
    expect(result.shadowDeleted).toBe(2);
  });

  it('deletes only clean, succeeded, old per-item rows, live and shadow', async () => {
    em.findMany.mockResolvedValueOnce(ids(2));
    const result = await cleanupTextScanRows({ graduatedEntityTypes: [], olderThanDays: 30 });
    expect(em.findMany.mock.calls[0][0].where).toEqual({
      entityType: {
        in: TEXT_SCAN_CLEAN_ROW_ENTITY_TYPES.flatMap((t) => [t, `${t}:shadow`]),
      },
      status: 'Succeeded',
      triggeredLabels: { isEmpty: true },
      updatedAt: { lt: new Date('2026-09-01T00:00:00Z') },
    });
    expect(result.cleanDeleted).toBe(2);
  });

  it('stops at maxBatches and reports exhausted instead of looping on a full table', async () => {
    // The fake runs dry after 10 full pages, so a removed cap fails on the count below instead of hanging.
    let pages = 0;
    em.findMany.mockImplementation(async () => (pages++ < 10 ? ids(5) : []));
    const result = await cleanupTextScanRows({
      graduatedEntityTypes: ['Post'],
      cleanRowEntityTypes: [],
      olderThanDays: 1,
      batchSize: 5,
      maxBatches: 3,
    });
    expect(em.deleteMany).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ shadowDeleted: 15, cleanDeleted: 0, exhausted: true });
  });

  it('deletes only the web-search shadow rows when no main entity type has graduated', async () => {
    em.findMany.mockResolvedValueOnce(ids(2)).mockResolvedValueOnce([]);
    const result = await cleanupTextScanRows({
      graduatedEntityTypes: [],
      graduatedWebSearchEntityTypes: ['Model'],
      cleanRowEntityTypes: [],
      olderThanDays: 14,
    });
    expect(em.findMany.mock.calls[0][0].where).toEqual({
      entityType: { in: ['Model:search-shadow'] },
      updatedAt: { lt: new Date('2026-09-17T00:00:00Z') },
    });
    expect(result).toMatchObject({ shadowDeleted: 2, cleanDeleted: 0, exhausted: false });
  });

  it('does nothing when no entity types are named', async () => {
    await cleanupTextScanRows({
      graduatedEntityTypes: [],
      cleanRowEntityTypes: [],
      olderThanDays: 1,
    });
    expect(em.findMany).not.toHaveBeenCalled();
  });
});

describe('cleanupTextScanRows on csam holds', () => {
  const db = { pg: null as unknown as PGlite };
  const asRawSql = (strings: TemplateStringsArray, values: unknown[]) =>
    strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''), '');
  const SUPERSEDED = { decision: 'superseded', superseded: true, supersededBy: 1 };

  beforeAll(async () => {
    db.pg = await PGlite.create();
    await db.pg.exec(
      readFileSync(
        path.resolve(
          __dirname,
          '../../../../../packages/civitai-db-schema/prisma/migrations/20261016150000_text_scan_hold/migration.sql'
        ),
        'utf8'
      )
    );
  });
  afterAll(async () => {
    await db.pg.close();
  });
  beforeEach(async () => {
    await db.pg.exec('TRUNCATE "TextScanHold" RESTART IDENTITY');
    dbMock.dbWrite.$executeRaw.mockImplementation(
      async (strings: TemplateStringsArray, ...values) =>
        (await db.pg.query(asRawSql(strings, values), values)).affectedRows ?? 0
    );
  });

  const hold = (
    entityId: number,
    status: string,
    decidedAt: string | null,
    decidedById: number | null,
    meta: object
  ) =>
    db.pg.query(
      `INSERT INTO "TextScanHold" ("entityType","entityId","label","textHash","text","reason","status",
         "decidedAt","decidedById","meta","updatedAt")
       VALUES ('Comment',$1,'csam','h','held text','r',$2,$3,$4,$5::jsonb,now())`,
      [entityId, status, decidedAt, decidedById, JSON.stringify(meta)]
    );
  const held = async () =>
    (
      await db.pg.query<{ entityId: number; text: string; meta: unknown }>(
        'SELECT "entityId","text","meta" FROM "TextScanHold" ORDER BY "entityId"'
      )
    ).rows;

  it('clears dismissed and superseded holds 30 days after the decision, keeping the superseded marker', async () => {
    // System time is 2026-10-01; the cutoff is 2026-09-01.
    await hold(1, 'Dismissed', '2026-08-31T00:00:00', 9, { decision: 'dismiss', note: 'x' });
    await hold(2, 'Dismissed', '2026-08-31T00:00:00', null, SUPERSEDED);
    await hold(3, 'Dismissed', '2026-09-02T00:00:00', null, SUPERSEDED);
    await hold(4, 'Dismissed', '2026-09-02T00:00:00', 9, { decision: 'dismiss' });
    await hold(5, 'Pending', null, null, { decisionClaim: { by: 9 } });
    await hold(6, 'Confirmed', '2026-08-31T00:00:00', 9, { decision: 'remove' });

    const result = await cleanupTextScanRows({
      graduatedEntityTypes: [],
      cleanRowEntityTypes: [],
      olderThanDays: 1,
    });

    expect(result.holdTextCleared).toBe(2);
    expect(await held()).toEqual([
      { entityId: 1, text: '', meta: null },
      { entityId: 2, text: '', meta: SUPERSEDED },
      { entityId: 3, text: 'held text', meta: SUPERSEDED },
      { entityId: 4, text: 'held text', meta: { decision: 'dismiss' } },
      { entityId: 5, text: 'held text', meta: { decisionClaim: { by: 9 } } },
      { entityId: 6, text: 'held text', meta: { decision: 'remove' } },
    ]);
  });
});
