import { describe, expect, it } from 'vitest';
import { viewTrackingSql, ownerViewsDailySql } from '../analytics-sql';

describe('viewTrackingSql', () => {
  it('bounds the probe at the end of the period', () => {
    const sql = viewTrackingSql('ComicProject', '2026-07-31');
    expect(sql).toContain(`createdDate <= toDate('2026-07-31')`);
    expect(sql).toContain(`entityType = 'ComicProject'`);
  });

  // The bug this replaced asked an all-time question, so a period predating the emitter answered "live" and
  // the tab rendered zeros instead of its fallback. Two periods must not produce the same probe.
  it('asks a different question of a past period than of today', () => {
    expect(viewTrackingSql('ComicProject', '2026-07-31')).not.toEqual(
      viewTrackingSql('ComicProject', '2026-08-19')
    );
  });

  // `>= from` would answer false for a period where tracking was live and nobody happened to view anything,
  // which renders as "not collecting yet" over a real zero. The question is monotone; one bound answers it.
  it('does not bound the start of the period', () => {
    expect(viewTrackingSql('Model3D', '2026-07-31')).not.toContain('>=');
  });
});

describe('ownerViewsDailySql', () => {
  // The rollup's MV is REFRESH EVERY 1 DAY OFFSET 2 HOUR and appends yesterday only, so its most recent day or
  // two are absent — and WITH FILL cannot tell absent from zero. Filling to `to` invents a zero and the chart
  // dives at its right-hand edge, which is the defect this exists to prevent.
  it('gap-fills only as far as the rollup is sealed', () => {
    const sql = ownerViewsDailySql(1818607, '2026-08-01', '2026-08-31');
    expect(sql).toContain('WITH FILL');
    expect(sql).toMatch(
      /TO least\(toDate\('2026-08-31'\), assumeNotNull\(\(SELECT max\(createdDate\)/
    );
  });

  // Reading the seal from the table rather than deriving it from the clock is what keeps this correct through a
  // refresh-schedule change — so a clock-derived bound is a regression even if it happens to agree today.
  it('reads the seal from the table, not from the clock', () => {
    const sql = ownerViewsDailySql(1818607, '2026-08-01', '2026-08-31');
    expect(sql).toContain('SELECT max(createdDate) FROM image_views_daily_by_owner');
    expect(sql).not.toMatch(/today\(\)|now\(\)/);
  });

  it('still scopes the rows to one owner and the requested range', () => {
    const sql = ownerViewsDailySql(1818607, '2026-08-01', '2026-08-31');
    expect(sql).toContain('ownerId = 1818607');
    expect(sql).toContain(`createdDate >= toDate('2026-08-01')`);
    expect(sql).toContain(`createdDate <= toDate('2026-08-31')`);
  });
});
