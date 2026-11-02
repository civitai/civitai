import type { PGlite } from '@electric-sql/pglite';
import type { AbuseReportInput } from '@civitai/moderation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshDb, pgliteKysely } from './abuse-detection-pglite.harness';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../moderator-db', () => ({
  getModeratorDb: () => {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return Object.assign(dbHandle.current as object, { withTables: () => dbHandle.current });
  },
}));

const service = await import('../abuse-detection.service');

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
  dbHandle.current = pgliteKysely(db);
});

afterEach(async () => {
  vi.restoreAllMocks();
  dbHandle.current = null;
  await db.close();
});

const report = (requireGroupKey?: boolean): AbuseReportInput => ({
  detector: 'grouped-producer',
  startedAt: '2026-10-30T13:00:00Z',
  finishedAt: '2026-10-30T13:05:00Z',
  counters: { groups: 1 },
  findings: [11, 12].map((userId) => ({
    userId,
    confidence: 0.6,
    reason: 'seeded',
    actioned: false,
    groupKey: '1',
  })),
  requireGroupKey,
});

const countRows = async (table: string) =>
  Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);

describe('requireGroupKey', () => {
  it('stores the group when the column exists', async () => {
    await service.recordAbuseRun(report(true));
    const { rows } = await db.query<{ group_key: string }>(
      'SELECT group_key FROM abuse_detection_finding ORDER BY user_id'
    );
    expect(rows.map((r) => r.group_key)).toEqual(['1', '1']);
  });

  describe('on a table without group_key', () => {
    beforeEach(async () => {
      await db.exec('ALTER TABLE abuse_detection_finding DROP COLUMN group_key;');
    });

    it('refuses the whole report instead of storing loose rows', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await expect(service.recordAbuseRun(report(true))).rejects.toThrow(/group_key/);
      expect(await countRows('abuse_detection_run')).toBe(0);
      expect(await countRows('abuse_detection_finding')).toBe(0);
    });

    it('still stores ungrouped for a producer that does not require it', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await service.recordAbuseRun(report());
      expect(await countRows('abuse_detection_finding')).toBe(2);
    });
  });
});
