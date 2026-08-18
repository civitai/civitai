import { describe, it, expect } from 'vitest';
import { fromClickhouseInt64, toClickhouseInt64 } from '../int64';

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

  it('accepts a number that is still exact', () => {
    expect(toClickhouseInt64(9007199254740991)).toBe('9007199254740991');
  });

  it('refuses a number that has already lost precision rather than storing it', () => {
    expect(() => toClickhouseInt64(Number(-4276845791567733103n))).toThrow(/lost precision/);
  });
});

describe('fromClickhouseInt64', () => {
  it('reads the text form back exactly', () => {
    expect(fromClickhouseInt64('-4276845791567733103')).toBe(-4276845791567733103n);
  });

  it('refuses a value that arrived as a rounded number', () => {
    expect(() => fromClickhouseInt64(Number(-4276845791567733103n))).toThrow(/toString/);
  });
});
