import { describe, expect, it } from 'vitest';
import { formatVideoLength } from './formatVideoLength';

describe('formatVideoLength', () => {
  it.each([
    [7, '7s'],
    [59, '59s'],
    [62, '1m 2s'],
    [120, '2m'],
    [3599, '59m 59s'],
    [3600, '1h'],
    [3780, '1h 3m'],
    [3661, '1h 1m'],
  ])('%s seconds -> %s', (seconds, expected) => {
    expect(formatVideoLength(seconds)).toBe(expected);
  });

  it('rounds fractional seconds to the nearest second, carrying into the next unit', () => {
    expect(formatVideoLength(6.4)).toBe('6s');
    expect(formatVideoLength(6.6)).toBe('7s');
    expect(formatVideoLength(59.6)).toBe('1m');
    expect(formatVideoLength(3599.6)).toBe('1h');
  });

  it('keeps the existing 0:00 for a zero or missing duration', () => {
    expect(formatVideoLength(0)).toBe('0:00');
    expect(formatVideoLength(undefined as unknown as number)).toBe('0:00');
    expect(formatVideoLength(0.4)).toBe('0:00');
    expect(formatVideoLength(-5)).toBe('0:00');
  });
});
