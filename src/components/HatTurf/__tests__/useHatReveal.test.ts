import { describe, expect, test } from 'vitest';
import { HAT_REVEAL_MAX_MS, hatRevealDelays } from '~/components/HatTurf/useHatReveal';

const WEEK = 7 * 24 * 60 * 60 * 1000;

describe('hatRevealDelays', () => {
  test('a week of placements still plays inside the cap, oldest first', () => {
    const t0 = Date.parse('2026-11-01T00:00:00Z');
    const delays = hatRevealDelays([
      { id: 'c', createdAt: new Date(t0 + WEEK) },
      { id: 'b', createdAt: new Date(t0 + 60_000) },
      { id: 'a', createdAt: new Date(t0) },
    ]);
    expect(delays.get('a')).toBe(0);
    expect(delays.get('b')!).toBeGreaterThan(0);
    expect(delays.get('c')).toBeLessThanOrEqual(HAT_REVEAL_MAX_MS);
    expect(delays.get('c')! - delays.get('b')!).toBeGreaterThan(delays.get('b')!);
  });

  // A live push carries no placement time.
  test('hats with no time keep the list order, newest first, so the last listed comes first', () => {
    const delays = hatRevealDelays([{ id: 3 }, { id: 2 }, { id: 1 }]);
    expect(delays.get('1')).toBe(0);
    expect(delays.get('2')!).toBeGreaterThan(0);
    expect(delays.get('3')!).toBeGreaterThan(delays.get('2')!);
  });

  test('a hat with no time reveals after every timed hat', () => {
    const t0 = Date.parse('2026-11-01T00:00:00Z');
    const delays = hatRevealDelays([
      { id: 'untimed' },
      { id: 'unreadable', createdAt: 'not a date' },
      { id: 'b', createdAt: new Date(t0 + 60_000) },
      { id: 'a', createdAt: new Date(t0) },
    ]);
    expect([...delays].sort((x, y) => x[1] - y[1]).map(([id]) => id)).toEqual([
      'a',
      'b',
      'unreadable',
      'untimed',
    ]);
  });
});
