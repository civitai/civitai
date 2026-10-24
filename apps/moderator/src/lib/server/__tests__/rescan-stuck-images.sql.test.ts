import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The SQL `rescanStuckImages` compiles to, asserted without a database. The UPDATE's WHERE is the
 * whole safety story — it is what stops a rescan from resetting a verdict that already landed or a
 * moderator's locked rating — so it is pinned clause by clause, with the values bound to it.
 */

const h = vi.hoisted(() => ({
  sql: [] as string[],
  params: [] as unknown[][],
  rows: [] as unknown[],
  recordModActivity: vi.fn(),
}));

vi.mock('../db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const db = capturingDb(h.sql, h.rows, h.params);
  return { dbRead: db, dbWrite: db };
});
vi.mock('../mod-activity', () => ({ recordModActivity: h.recordModActivity }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn() }));
vi.mock('../cache', () => ({ bustCachedObject: vi.fn() }));
vi.mock('../storage', () => ({ getStorage: vi.fn(), getMediaProbeStorage: vi.fn() }));

const { rescanStuckImages, MAX_RESCAN_PER_REQUEST } = await import('../ingestion.service');

const NOW = new Date('2026-09-11T12:00:00.000Z');
const STUCK_CUTOFF = new Date(NOW.getTime() - 15 * 60_000);
const flat = (i: number) => h.sql[i].replace(/\s+/g, ' ').trim();
const cannedRows = (...ids: number[]) => {
  h.rows.length = 0;
  h.rows.push(...ids.map((id) => ({ id })));
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  h.sql.length = 0;
  h.params.length = 0;
  h.recordModActivity.mockReset();
  cannedRows();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('rescanStuckImages', () => {
  it('moves only still-stuck, unlocked rows from the selection to Rescan', async () => {
    cannedRows(11, 12);

    const result = await rescanStuckImages({ imageIds: [11, 12, 12], userId: 7 });

    expect(h.sql).toHaveLength(1);
    const update = flat(0);
    expect(update).toMatch(/^update "Image" set "ingestion" = \$1 where "id" in \(\$2, \$3\) and /);
    expect(update).toContain(`ingestion = 'Pending'::"ImageIngestionStatus" AND "createdAt" < $4`);
    expect(update).toContain(`"nsfwLevelLocked" = $5`);
    expect(update).toMatch(/returning "id"$/);
    expect(h.params[0]).toEqual(['Rescan', 11, 12, STUCK_CUTOFF, false]);
    expect(result).toEqual({ ok: true, count: 2 });
  });

  it('records one mod-activity row per image it actually moved', async () => {
    cannedRows(11);

    await rescanStuckImages({ imageIds: [11, 12], userId: 7 });

    expect(h.recordModActivity).toHaveBeenCalledTimes(1);
    expect(h.recordModActivity).toHaveBeenCalledWith({
      userId: 7,
      entityType: 'image',
      entityId: 11,
      activity: 'rescanStuck',
    });
  });

  it('without ids, picks the oldest stuck unlocked images up to the cap, then updates those', async () => {
    cannedRows(21, 22);

    const result = await rescanStuckImages({ userId: 7 });

    expect(h.sql).toHaveLength(2);
    const pick = flat(0);
    expect(pick).toMatch(/^select "id" from "Image" where /);
    expect(pick).toContain(`ingestion = 'Pending'::"ImageIngestionStatus" AND "createdAt" < $1`);
    expect(pick).toContain(`"nsfwLevelLocked" = $2`);
    expect(pick).toMatch(/order by "id" limit \$3$/);
    expect(h.params[0]).toEqual([STUCK_CUTOFF, false, MAX_RESCAN_PER_REQUEST]);
    expect(h.params[1]).toEqual(['Rescan', 21, 22, STUCK_CUTOFF, false]);
    expect(result).toEqual({ ok: true, count: 2 });
  });

  it('with nothing stuck, stops after the pick and records nothing', async () => {
    const result = await rescanStuckImages({ userId: 7 });

    expect(h.sql).toHaveLength(1);
    expect(result).toEqual({ ok: true, count: 0 });
    expect(h.recordModActivity).not.toHaveBeenCalled();
  });

  it('refuses an empty or oversized selection without touching the database', async () => {
    const tooMany = Array.from({ length: MAX_RESCAN_PER_REQUEST + 1 }, (_, i) => i + 1);

    expect(await rescanStuckImages({ imageIds: [], userId: 7 })).toEqual({
      ok: false,
      error: 'Select at least one image.',
    });
    expect(await rescanStuckImages({ imageIds: tooMany, userId: 7 })).toMatchObject({ ok: false });
    expect(h.sql).toHaveLength(0);
  });
});
