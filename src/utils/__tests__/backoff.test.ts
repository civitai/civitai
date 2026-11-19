import { afterEach, describe, expect, it, vi } from 'vitest';
import { backoffDelay } from '~/utils/backoff';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('backoffDelay', () => {
  it('doubles from baseMs and stops at maxMs', () => {
    const opts = { baseMs: 1000, maxMs: 5000 };
    expect([0, 1, 2, 3, 4].map((n) => backoffDelay(n, opts))).toEqual([
      1000, 2000, 4000, 5000, 5000,
    ]);
  });

  it('adds the jitter on top of the ceiling, not inside it', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(backoffDelay(10, { baseMs: 1000, maxMs: 5000, jitterMs: 1000 })).toBe(5500);
  });

  it('stays finite however many attempts a caller counts', () => {
    expect(Number.isFinite(backoffDelay(5000, { baseMs: 1000 }))).toBe(true);
  });
});
