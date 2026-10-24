import { describe, it, expect } from 'vitest';
import { toClickhouseInt64 } from '../int64';

// ClickUp 868kta7p0 — the helper the blocked-hash writers use. A JS number holds 53 bits,
// so anything past that has to move as text in both directions.
describe('toClickhouseInt64', () => {
  it.each([
    ['-4276845791567733103'],
    ['9223372036854775783'],
    ['-9223372036854775783'],
    ['9007199254740993'], // 2^53 + 1: the first integer a double cannot hold
  ])('round-trips %s exactly', (decimal) => {
    expect(toClickhouseInt64(BigInt(decimal))).toBe(decimal);
    expect(toClickhouseInt64(decimal)).toBe(decimal);
  });

  it('refuses a value that is not an integer rather than storing something else', () => {
    expect(() => toClickhouseInt64('4276845791567733103.5')).toThrow();
  });
});
