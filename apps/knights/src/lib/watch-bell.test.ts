import { describe, expect, it } from 'vitest';
import { watchBell } from './watch-bell';

const MAX = 20;
const at = (value: number, watch = '2026-11-18') => ({ value, max: MAX, watch });

function rings(start: ReturnType<typeof at>, steps: ReturnType<typeof at>[]) {
  const bell = watchBell(start);
  return steps.filter((step) => bell(step)).length;
}

describe('watchBell', () => {
  it('rings once for a Watch even when a refused vote un-counts the completing vote', () => {
    expect(rings(at(MAX - 2), [at(MAX - 1), at(MAX), at(MAX - 1), at(MAX), at(MAX + 1)])).toBe(1);
  });

  it('does not ring for a Watch already complete when the page opened', () => {
    expect(rings(at(MAX), [at(MAX), at(MAX - 1), at(MAX)])).toBe(0);
  });

  it('rings again for the next day’s Watch', () => {
    expect(
      rings(at(MAX - 1), [
        at(MAX),
        at(0, '2026-11-19'),
        at(MAX - 1, '2026-11-19'),
        at(MAX, '2026-11-19'),
      ])
    ).toBe(2);
  });

  it('does not ring for a new Watch that arrives already complete', () => {
    expect(rings(at(MAX - 1), [at(MAX, '2026-11-19'), at(MAX + 1, '2026-11-19')])).toBe(0);
  });
});
