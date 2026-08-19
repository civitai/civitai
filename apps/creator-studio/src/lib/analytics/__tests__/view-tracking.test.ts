import { describe, expect, it } from 'vitest';
import { viewTrackingSql } from '../view-tracking';
import { rollupThrough } from '../../date-range';

describe('viewTrackingSql', () => {
  // The bug this replaced asked an all-time question and used the answer to gate range-scoped numbers, so the
  // range predicate is the entire point of the query. Asserted as two separate substrings rather than one whole
  // string so a formatting change doesn't fail this, but dropping a bound does.
  it('bounds the probe to the range it is asked about', () => {
    const sql = viewTrackingSql('ComicProject', '2026-07-01', '2026-07-31');
    expect(sql).toContain(`createdDate >= toDate('2026-07-01')`);
    expect(sql).toContain(`createdDate <= toDate('2026-07-31')`);
  });

  it('keeps the entityType filter and the short-circuit', () => {
    const sql = viewTrackingSql('Model3D', '2026-07-01', '2026-07-31');
    expect(sql).toContain(`entityType = 'Model3D'`);
    expect(sql).toContain('LIMIT 1');
  });

  // A guard scoped to last month must be able to answer false for it while today has rows — that asymmetry is
  // what the all-time version could not express, and it is what makes the Comics/3D fallback reachable.
  it('produces different probes for a past month and for today', () => {
    expect(viewTrackingSql('ComicProject', '2026-07-01', '2026-07-31')).not.toEqual(
      viewTrackingSql('ComicProject', '2026-08-19', '2026-08-19')
    );
  });
});

describe('rollupThrough', () => {
  const today = new Date('2026-08-19T12:00:00Z');

  // The current month is the case that was broken: `through` is today, the rollup has no row for today, and the
  // gap-fill turns that into a real zero at the right-hand edge.
  it('pulls the current month back to yesterday', () => {
    expect(rollupThrough('2026-08-19', today)).toBe('2026-08-18');
  });

  // A completed month is entirely sealed, so clamping it would drop a day that genuinely has data.
  it('leaves a past month alone', () => {
    expect(rollupThrough('2026-07-31', today)).toBe('2026-07-31');
  });

  it('does not push a range end past its own month', () => {
    expect(rollupThrough('2026-08-18', today)).toBe('2026-08-18');
  });
});
