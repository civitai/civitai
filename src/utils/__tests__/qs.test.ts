import { describe, expect, it } from 'vitest';
import { QS } from '~/utils/qs';

// Pins the QS wrapper defaults so a query-string major bump (7 -> 9) can't silently change them.
describe('QS.parse', () => {
  it('parses booleans and numbers by default', () => {
    expect({ ...QS.parse('a=1&b=true&c=x&f=007&g=1.5') }).toEqual({
      a: 1,
      b: true,
      c: 'x',
      f: 7,
      g: 1.5,
    });
  });

  it('parses repeated keys into arrays', () => {
    expect(QS.parse('d=1&d=2').d).toEqual([1, 2]);
  });

  it('keeps the options override', () => {
    expect(QS.parse('a=1&b=true', { parseNumbers: false, parseBooleans: false })).toEqual({
      a: '1',
      b: 'true',
    });
  });

  it('leaves malformed percent-encoding literal instead of throwing', () => {
    expect(QS.parse('e=%E0%A4%A').e).toBe('%E0%A4%A');
  });
});

describe('QS.stringify', () => {
  it('skips null and empty strings and encodes spaces as %20', () => {
    expect(QS.stringify({ a: 1, c: '', d: null, e: 'x y' })).toBe('a=1&e=x%20y');
  });

  it('keeps key order (sort: false)', () => {
    expect(QS.stringify({ z: 1, a: 2, m: 3 })).toBe('z=1&a=2&m=3');
  });

  it('repeats the key for arrays', () => {
    expect(QS.stringify({ b: [1, 2] })).toBe('b=1&b=2');
  });
});

describe('QS.stringifyUrl', () => {
  it('appends to a url that already has a query, skipping null and empty values', () => {
    expect(QS.stringifyUrl({ url: '/p?z=1', query: { a: [1, 2], b: true, c: null, d: '' } })).toBe(
      '/p?z=1&a=1&a=2&b=true'
    );
  });
});
