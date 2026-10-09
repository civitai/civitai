import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    expect(result).toEqual({ shadowDeleted: 3, cleanDeleted: 0, exhausted: false });
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
    expect(result).toEqual({ shadowDeleted: 15, cleanDeleted: 0, exhausted: true });
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
