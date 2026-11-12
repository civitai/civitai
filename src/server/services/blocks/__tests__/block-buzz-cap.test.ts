import { describe, expect, it } from 'vitest';
import { secondsToUtcReset } from '~/server/services/blocks/block-buzz-cap';

/**
 * The refusal record's TTL runs to the next UTC midnight: the same reset the paused notice shows
 * (`resetAt`). Literal instants, so a TTL computed some other way shows.
 */
describe('secondsToUtcReset', () => {
  it.each([
    ['2026-11-09T21:00:00.000Z', 10_800],
    ['2026-11-10T00:00:00.000Z', 86_400],
    ['2026-11-09T23:59:59.500Z', 1],
    ['2026-12-31T23:00:00.000Z', 3_600],
  ])('at %s: %d seconds', (at, seconds) => {
    expect(secondsToUtcReset(Date.parse(at))).toBe(seconds);
  });
});
