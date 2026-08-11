import { describe, expect, it } from 'vitest';
import { fliptCacheKey, TtlCache } from '../cache';
import { parseLocalOverrides } from '../env';

describe('TtlCache', () => {
  it('expires entries after the TTL', () => {
    const cache = new TtlCache<boolean>(100, 10);
    cache.set('k', true, 1_000);
    expect(cache.get('k', 1_050)).toEqual({ hit: true, value: true });
    expect(cache.get('k', 1_101)).toEqual({ hit: false });
  });

  it('keeps hot keys alive across a generation rotation', () => {
    const cache = new TtlCache<boolean>(10_000, 2);
    cache.set('hot', true, 0);
    cache.set('a', false, 0);
    // Overflow: 'hot' and 'a' rotate into the previous generation.
    cache.set('b', false, 0);
    // Reading 'hot' promotes it back into the current generation...
    expect(cache.get('hot', 0).hit).toBe(true);
    // ...so the next rotation drops 'a' rather than 'hot'.
    cache.set('c', false, 0);
    cache.set('d', false, 0);
    expect(cache.get('hot', 0).hit).toBe(true);
    expect(cache.get('a', 0).hit).toBe(false);
  });

  it('stores nothing when the TTL is 0', () => {
    const cache = new TtlCache<boolean>(0, 10);
    cache.set('k', true, 0);
    expect(cache.get('k', 0).hit).toBe(false);
  });
});

describe('fliptCacheKey', () => {
  it('is order-independent in context', () => {
    expect(fliptCacheKey('f', 'e', { a: '1', b: '2' })).toBe(
      fliptCacheKey('f', 'e', { b: '2', a: '1' })
    );
  });

  it('does not alias across separator characters in values', () => {
    expect(fliptCacheKey('f', 'a|b', {})).not.toBe(fliptCacheKey('f', 'a', { b: '' }));
    expect(fliptCacheKey('f', 'e', { a: '1&b=2' })).not.toBe(
      fliptCacheKey('f', 'e', { a: '1', b: '2' })
    );
  });
});

describe('parseLocalOverrides', () => {
  it('parses comma-separated pairs and ignores malformed ones', () => {
    expect(parseLocalOverrides('a=on, b=primary ,junk,=x,c=')).toEqual({
      a: 'on',
      b: 'primary',
    });
  });

  it('returns an empty map when unset', () => {
    expect(parseLocalOverrides(undefined)).toEqual({});
  });
});
