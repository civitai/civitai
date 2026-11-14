import { describe, expect, it } from 'vitest';
import { poolFor } from './pool';

const ids = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);

describe('poolFor', () => {
  it('is stable and exclusive per image', () => {
    for (const id of ids(1, 200)) expect(poolFor(id, 0.3)).toBe(poolFor(id, 0.3));
  });

  it('follows the share', () => {
    const hidden = ids(1, 4000).filter((id) => poolFor(id, 0.3) === 'hiddenCheck').length;
    expect(hidden / 4000).toBeGreaterThan(0.25);
    expect(hidden / 4000).toBeLessThan(0.35);
    expect(ids(1, 100).every((id) => poolFor(id, 0) === 'trials')).toBe(true);
    expect(ids(1, 100).every((id) => poolFor(id, 1) === 'hiddenCheck')).toBe(true);
  });
});
