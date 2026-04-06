import { describe, it, expect } from 'vitest';
import { filterRecentWinners } from '../winner-cooldown';

describe('filterRecentWinners', () => {
  const entries = [
    { userId: 1, imageId: 100 },
    { userId: 2, imageId: 200 },
    { userId: 3, imageId: 300 },
    { userId: 4, imageId: 400 },
    { userId: 5, imageId: 500 },
  ];

  it('removes recent winners from candidates', () => {
    const recentWinners = new Set([2, 4]);
    const result = filterRecentWinners(entries, recentWinners);

    expect(result).toHaveLength(3);
    expect(result.map((e) => e.userId)).toEqual([1, 3, 5]);
  });

  it('returns all entries when no recent winners', () => {
    const result = filterRecentWinners(entries, new Set());
    expect(result).toHaveLength(5);
  });

  it('falls back to full pool when ALL candidates are recent winners', () => {
    const allWinners = new Set([1, 2, 3, 4, 5]);
    const result = filterRecentWinners(entries, allWinners);

    // Fallback: returns original entries rather than empty
    expect(result).toHaveLength(5);
    expect(result).toEqual(entries);
  });

  it('returns empty array when entries is empty', () => {
    const result = filterRecentWinners([], new Set([1, 2]));
    expect(result).toHaveLength(0);
  });

  it('handles single eligible candidate', () => {
    const recentWinners = new Set([1, 2, 3, 4]);
    const result = filterRecentWinners(entries, recentWinners);

    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe(5);
  });

  it('preserves entry order', () => {
    const recentWinners = new Set([3]);
    const result = filterRecentWinners(entries, recentWinners);

    expect(result.map((e) => e.userId)).toEqual([1, 2, 4, 5]);
  });
});
