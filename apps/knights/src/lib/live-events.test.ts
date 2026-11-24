import { describe, expect, it } from 'vitest';
import { acceptsStats, dropsForPlayer, readQueueDrops } from './live-events';

describe('dropsForPlayer', () => {
  it('drops an item no longer served, or moved to a stage the player does not judge', () => {
    expect(dropsForPlayer({ k: 'a', to: null }, ['Knight'])).toBe(true);
    expect(dropsForPlayer({ k: 'a', to: 'Templar' }, ['Knight'])).toBe(true);
  });

  it('keeps an item moved to a stage the player also judges', () => {
    expect(dropsForPlayer({ k: 'a', to: 'Templar' }, ['Knight', 'Templar'])).toBe(false);
  });
});

describe('readQueueDrops', () => {
  it('keeps only well-formed drops', () => {
    expect(
      readQueueDrops({
        drops: [{ k: 'a', to: null }, { k: 1, to: null }, { k: 'b', to: 'Paladin' }, null],
      })
    ).toEqual([
      { k: 'a', to: null },
      { k: 'b', to: 'Paladin' },
    ]);
    expect(readQueueDrops(null)).toEqual([]);
    expect(readQueueDrops({ drops: 'x' })).toEqual([]);
  });
});

describe('acceptsStats', () => {
  const signal = { at: 200, daily: { votes: 5 } };

  it('takes a newer signal that counts every vote shown, once nothing is in flight', () => {
    expect(acceptsStats(signal, { at: 100, votes: 5, inFlight: 0 })).toBe(true);
  });

  it('refuses one while a vote is in flight, one older than what is shown, and one that would move the Watch back', () => {
    expect(acceptsStats(signal, { at: 100, votes: 5, inFlight: 1 })).toBe(false);
    expect(acceptsStats(signal, { at: 200, votes: 5, inFlight: 0 })).toBe(false);
    expect(acceptsStats(signal, { at: 100, votes: 6, inFlight: 0 })).toBe(false);
  });
});
