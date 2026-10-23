import { describe, expect, it } from 'vitest';
import { lastActionedBadge } from '../queue-thresholds';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

describe('lastActionedBadge', () => {
  it('goes from green to red as the last action ages', () => {
    expect([0.5, 2, 12, 48, 100].map((h) => lastActionedBadge(ago(h), 3, NOW)?.class)).toEqual([
      'text-green-400',
      'text-lime-300',
      'text-yellow-300',
      'text-orange-400',
      'text-red-400',
    ]);
  });

  it('a queue with reports waiting and no recent action is red; an empty one has no badge', () => {
    const stale = lastActionedBadge(undefined, 4, NOW);
    expect(stale?.class).toBe('text-red-400');
    expect(stale?.at).toBeUndefined();
    expect(lastActionedBadge(undefined, 0, NOW)).toBeNull();
    expect(lastActionedBadge(undefined, null, NOW)).toBeNull();
  });

  it('a recently worked queue keeps its badge after it empties', () => {
    expect(lastActionedBadge(ago(0.1), 0, NOW)?.class).toBe('text-green-400');
  });
});
