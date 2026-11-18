import { describe, expect, it } from 'vitest';
import { updatedAgo } from './updated-ago';

describe('updatedAgo', () => {
  const built = Date.parse('2026-12-15T10:00:00Z');
  it.each([
    [0, 'Updated just now'],
    [59_000, 'Updated just now'],
    [60_000, 'Updated 1 min ago'],
    [150_000, 'Updated 2 min ago'],
    [-5_000, 'Updated just now'],
  ])('%i ms after the build reads %s', (ms, text) => {
    expect(updatedAgo(built, built + ms)).toBe(text);
  });
});
