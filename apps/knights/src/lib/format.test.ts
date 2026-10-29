import { describe, expect, it } from 'vitest';
import { formatWait } from './format';

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
