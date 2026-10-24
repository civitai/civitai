import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLatestApprovedImageAppeals,
  holdSameReasonRemovals,
  isSameRemovalReason,
  overturnedRemovalLabel,
} from './image-removal-confirmation.db';
import { compileHarness } from './test/harness';

const KNOWN = new Set(['animatedMinorNsfw', 'schoolNsfw', 'gore']);

describe('isSameRemovalReason', () => {
  it('holds the same known reason and lets a different one through', () => {
    expect(isSameRemovalReason('gore', 'gore', KNOWN)).toBe(true);
    expect(isSameRemovalReason('gore', 'schoolNsfw', KNOWN)).toBe(false);
  });

  it('counts a reason it cannot compare as the same', () => {
    expect(isSameRemovalReason(null, 'gore', KNOWN)).toBe(true);
    expect(isSameRemovalReason('manual', 'gore', KNOWN)).toBe(true);
    expect(isSameRemovalReason('gore', undefined, KNOWN)).toBe(true);
    expect(isSameRemovalReason('gore', 'other', KNOWN)).toBe(true);
  });
});

describe('overturnedRemovalLabel', () => {
  const approvedAt = new Date('2026-10-14T16:59:45Z');

  it('takes the last removal at or before the approval, ignoring later ones', () => {
    const events = [
      { imageId: 1, time: '2026-09-20 17:30:11', label: 'schoolNsfw' },
      { imageId: 1, time: '2026-10-01 10:00:00', label: 'gore' },
      { imageId: 1, time: '2026-10-14 18:59:16', label: 'animatedMinorNsfw' },
    ];
    expect(overturnedRemovalLabel(events, approvedAt)).toBe('gore');
  });

  it('reads ClickHouse times as UTC', () => {
    // One second after the approval in UTC; read as local time it would land on the wrong side in
    // any zone east of UTC.
    const events = [{ imageId: 1, time: '2026-10-14 16:59:46', label: 'gore' }];
    expect(overturnedRemovalLabel(events, approvedAt)).toBeUndefined();
  });

  it('tells a removal with no label apart from no removal at all', () => {
    const events = [{ imageId: 1, time: '2026-09-20 17:30:11', label: '' }];
    expect(overturnedRemovalLabel(events, approvedAt)).toBeNull();
    expect(overturnedRemovalLabel([], approvedAt)).toBeUndefined();
  });
});

const harness = compileHarness();
beforeEach(() => {
  harness.queries.length = 0;
});

describe('getLatestApprovedImageAppeals', () => {
  it('reads one latest Approved image appeal per image, with UTC approval time and the label', async () => {
    await getLatestApprovedImageAppeals(harness.db, [5, 6]);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toContain('select distinct on ("a"."entityId")');
    expect(sql).toContain(`coalesce(a."resolvedAt", a."updatedAt") AT TIME ZONE 'UTC'`);
    expect(sql).toContain('"d"."removalLabel"');
    expect(sql).toContain(
      'where "a"."entityType" = $1 and "a"."entityId" in ($2, $3) and "a"."status" = $4'
    );
    expect(sql).toMatch(/order by "a"\."entityId", coalesce\(.*\) desc, "a"\."id" desc$/);
    expect(parameters).toEqual(['Image', 5, 6, 'Approved']);
  });

  it('runs nothing for no ids', async () => {
    await getLatestApprovedImageAppeals(harness.db, []);
    expect(harness.queries).toHaveLength(0);
  });
});

describe('holdSameReasonRemovals', () => {
  // The DummyDriver returns no rows, so no image has an approved appeal: everything proceeds and the
  // only query is the appeal read.
  it('applies every removal when no image has an approved appeal', async () => {
    const clickhouse = vi.fn();
    const result = await holdSameReasonRemovals({
      db: harness.db,
      requests: [{ imageId: 5, violationType: 'gore' }, { imageId: 6 }],
      requestedById: 9,
      source: 'test',
      knownReasons: KNOWN,
      clickhouse,
    });
    expect(result).toEqual({ held: [], proceed: [5, 6] });
    expect(harness.queries).toHaveLength(1);
    expect(clickhouse).not.toHaveBeenCalled();
  });
});
