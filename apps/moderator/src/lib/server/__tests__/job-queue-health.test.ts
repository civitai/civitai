import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_QUEUE_OVERDUE_MINUTES, JOB_QUEUE_UNCONSUMED_TYPES } from '@civitai/shared/job-queue';

/**
 * `getJobQueueHealth` compiles to one grouped scan whose whole point is the OVERDUE column. Depth is
 * not a health signal — the deepest lane is routinely the healthiest — so the two failures worth
 * catching are the overdue cutoff silently becoming a WHERE (which would make depth track overdue) and
 * the cutoffs being restated in SQL instead of read from the shared table.
 */

const h = vi.hoisted(() => ({
  sql: [] as string[],
  params: [] as unknown[][],
  rows: [] as unknown[],
}));

vi.mock('../db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const db = capturingDb(h.sql, h.rows, h.params);
  return { dbRead: db, dbWrite: db };
});

const { getJobQueueHealth } = await import('../job-queue.service');

const NOW = new Date('2026-09-15T12:00:00.000Z');
const lane = (over: Partial<Record<string, unknown>>) => ({
  type: 'ImageScan',
  entityType: 'Image',
  depth: '0',
  overdue: '0',
  oldest: null,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  h.sql.length = 0;
  h.params.length = 0;
  h.rows.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getJobQueueHealth', () => {
  it('counts overdue rows with a FILTER, leaving depth an unconditional count', async () => {
    await getJobQueueHealth();

    expect(h.sql).toHaveLength(1);
    const statement = h.sql[0].replace(/\s+/g, ' ');
    expect(statement).toMatch(/count\(\*\) filter\(where "createdAt" < CASE type::text/i);
    // Every THEN is a bind parameter, so without this cast Postgres types the CASE as `text` and the
    // statement will not plan. See job-queue-health.explain.test.ts, which is what actually proves it.
    expect(statement.match(/THEN \$\d+::timestamptz/g)).toHaveLength(
      Object.keys(JOB_QUEUE_OVERDUE_MINUTES).length
    );
    // The grouped scan itself must stay unfiltered: a WHERE here would hide every lane that is merely
    // waiting, which is most of them, and the panel would read as "nothing queued".
    expect(statement).not.toMatch(/from "JobQueue" where/i);
    expect(statement).toMatch(/group by "type", "entityType"/i);
  });

  it('binds one cutoff per job type, each derived from the shared overdue table', async () => {
    await getJobQueueHealth();

    // Interleaved `type, cutoff` pairs, in the table's own order — so a hardcoded literal or a dropped
    // type fails here rather than silently under-reporting one lane forever.
    expect(h.params[0]).toEqual(
      Object.entries(JOB_QUEUE_OVERDUE_MINUTES).flatMap(([type, minutes]) => [
        type,
        new Date(NOW.getTime() - minutes * 60_000),
      ])
    );
  });

  it('orders lanes by overdue first, then by depth', async () => {
    h.rows.push(
      lane({ type: 'CleanIfEmpty', entityType: 'Post', depth: '6860', overdue: '0' }),
      lane({ type: 'ImageScan', entityType: 'Image', depth: '10', overdue: '4' }),
      lane({ type: 'UpdateNsfwLevel', entityType: 'Image', depth: '90', overdue: '0' }),
      lane({ type: 'ModerationRequest', entityType: 'User', depth: '3', overdue: '9' })
    );

    const health = await getJobQueueHealth();

    expect(health.lanes.map((l) => `${l.type}:${l.overdue}:${l.depth}`)).toEqual([
      'ModerationRequest:9:3',
      'ImageScan:4:10',
      'CleanIfEmpty:0:6860',
      'UpdateNsfwLevel:0:90',
    ]);
  });

  it('totals depth and overdue separately, so a deep healthy lane never raises the alarm', async () => {
    h.rows.push(
      lane({ type: 'BlockedImageDelete', depth: '63315', overdue: '0' }),
      lane({ type: 'ImageScan', depth: '345', overdue: '2' })
    );

    const health = await getJobQueueHealth();

    expect(health.depth).toBe(63660);
    expect(health.overdue).toBe(2);
  });

  it('reports the oldest row per lane, and null for a lane with none', async () => {
    const oldest = new Date('2026-09-08T17:01:00.000Z');
    h.rows.push(lane({ depth: '1', oldest }), lane({ type: 'CleanUp', depth: '1', oldest: null }));

    const health = await getJobQueueHealth();

    expect(health.lanes.map((l) => l.oldestAt)).toEqual([oldest, null]);
  });
});

describe('JOB_QUEUE_UNCONSUMED_TYPES', () => {
  it('names exactly the types whose overdue figure is zero', () => {
    const zeroed = Object.entries(JOB_QUEUE_OVERDUE_MINUTES)
      .filter(([, minutes]) => minutes === 0)
      .map(([type]) => type);

    expect([...JOB_QUEUE_UNCONSUMED_TYPES].sort()).toEqual(zeroed.sort());
    // A type nothing drains strands every row it receives, so the panel flags it on the first row
    // rather than after a window that will never elapse. Losing this leaves it silently indistinct
    // from a healthy lane.
    expect(JOB_QUEUE_UNCONSUMED_TYPES.length).toBeGreaterThan(0);
  });
});
