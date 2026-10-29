import { describe, expect, it } from 'vitest';
import { count, formatDate, formatWait } from './format';

describe('formatWait', () => {
  it.each([
    [0, '0s'],
    [-5, '0s'],
    [44.2, '45s'],
    [185, '3m 05s'],
    [3720, '1h 02m'],
  ])('%s seconds reads %s', (seconds, text) => {
    expect(formatWait(seconds)).toBe(text);
  });
});

describe('count and formatDate', () => {
  it('groups thousands the same everywhere', () => {
    expect(count(12345)).toBe('12,345');
  });

  it('reads a timestamp as its UTC calendar date', () => {
    expect(formatDate('2026-12-15T23:30:00Z')).toBe('Dec 15, 2026');
  });
});
