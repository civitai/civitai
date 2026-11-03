import { describe, expect, it } from 'vitest';
import {
  buildReadout,
  formatReadout,
  METRICS,
  toExposedUsers,
  type ExposedUser,
  type ExposureRow,
  type MetricKey,
} from '../readout';

const zero = Object.fromEntries(Object.keys(METRICS).map((k) => [k, 0])) as Record<
  MetricKey,
  number
>;
let nextId = 1;
function users(variant: string, n: number, successes: Partial<Record<MetricKey, number>> = {}) {
  return Array.from({ length: n }, (_, i): ExposedUser => {
    const outcomes = { ...zero };
    for (const [k, count] of Object.entries(successes)) {
      if (i < (count ?? 0)) outcomes[k as MetricKey] = 1;
    }
    return { userId: nextId++, variant, nVariants: 1, outcomes };
  });
}
const BEFORE_READ = new Date('2026-11-10T00:00:00Z');
const AFTER_READ = new Date('2026-11-25T00:00:00Z');

describe('buildReadout', () => {
  it('reports the primary metric per arm and the treatment effect against control', () => {
    const r = buildReadout(
      'hatTurfFeedCard',
      [
        ...users('control', 1000, { placedFromFeed: 100 }),
        ...users('badge-popover', 1000, { placedFromFeed: 150 }),
      ],
      AFTER_READ
    );
    expect(r.arms.map((a) => [a.variant, a.users])).toEqual([
      ['control', 1000],
      ['badge-popover', 1000],
    ]);
    const primary = r.comparisons.find((c) => c.role === 'primary')!;
    expect(primary.metric).toBe('placedFromFeed');
    expect(primary.result!.diff).toBeCloseTo(0.05, 10);
    expect(primary.result!.p).toBeLessThan(0.01);
    expect(primary.alpha).toBe(0.05);
    expect(r.srm.mismatch).toBe(false);
    expect(r.interim).toBe(false);
  });

  it('splits α across secondary metrics', () => {
    const r = buildReadout('hatTurfFeedCard', [
      ...users('control', 10),
      ...users('badge-popover', 10),
    ]);
    const secondary = r.comparisons.filter((c) => c.role === 'secondary');
    expect(secondary).toHaveLength(4);
    for (const c of secondary) expect(c.alpha).toBeCloseTo(0.05 / 4, 10);
  });

  it('POSITIVE CONTROL: flags a sample-ratio mismatch and says not to read', () => {
    const r = buildReadout(
      'hatTurfImageDetail',
      [...users('control', 5000), ...users('invite-inline', 5400)],
      AFTER_READ
    );
    expect(r.srm.mismatch).toBe(true);
    expect(formatReadout(r)).toContain('SRM: do not read results');
  });

  it('excludes users seen in more than one arm and counts them', () => {
    const mixed = users('control', 3).map((u) => ({ ...u, nVariants: 2 }));
    const r = buildReadout('hatTurfImageDetail', [
      ...mixed,
      ...users('control', 10),
      ...users('invite-inline', 10),
    ]);
    expect(r.contaminatedUsers).toBe(3);
    expect(r.arms.find((a) => a.variant === 'control')!.users).toBe(10);
  });

  it('marks a read before the pre-registered date as interim', () => {
    const r = buildReadout('hatTurfImageDetail', users('control', 2), BEFORE_READ);
    expect(r.interim).toBe(true);
    expect(formatReadout(r)).toContain('INTERIM');
  });
});

describe('toExposedUsers', () => {
  const firstSeen = Date.UTC(2026, 10, 10, 23, 0, 0) / 1000;
  const row: ExposureRow = {
    userId: 9,
    variant: 'badge-popover',
    firstSeen,
    nVariants: 1,
    joined: 1,
    inviteDismissed: 0,
    feedSaved: 0,
    hatCountOpened: 0,
    hidAllHats: 0,
  };
  const at = (secondsFromFirstSeen: number, source: string | null = null) => ({
    atMs: (firstSeen + secondsFromFirstSeen) * 1000,
    source,
  });

  it('counts placements from just before exposure (tracker lag) but not earlier ones', () => {
    const [u] = toExposedUsers([row], new Map([[9, [at(-3600), at(-30), at(10)]]]));
    expect(u.outcomes.placements).toBe(2);
  });

  it('counts feed placements by their source, and return days by UTC date', () => {
    const [u] = toExposedUsers([row], new Map([[9, [at(10, 'feed'), at(3700, 'image-detail')]]]));
    expect(u.outcomes.placedFromFeed).toBe(1);
    // 23:00:10 and 00:01:40 the next day, in UTC.
    expect(u.outcomes.returned2Days).toBe(1);
  });

  it('gives an exposed user with no placements zeroes, not a missing row', () => {
    const [u] = toExposedUsers([row], new Map());
    expect(u.outcomes).toMatchObject({ placements: 0, placedAny: 0, joined: 1 });
  });
});

describe('an arm with no users', () => {
  it('reports the empty arm instead of a verdict', () => {
    const r = buildReadout('hatTurfFeedCard', users('control', 50));
    expect(r.comparisons.every((c) => c.result === null)).toBe(true);
    expect(formatReadout(r)).toContain('an arm has no users');
  });
});
