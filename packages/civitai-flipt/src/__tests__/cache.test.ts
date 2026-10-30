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

describe('TtlCache.stats', () => {
  it('counts hits and misses', () => {
    const cache = new TtlCache<boolean>(100, 10);
    cache.set('k', true, 0);
    cache.get('k', 0); // hit
    cache.get('k', 0); // hit
    cache.get('absent', 0); // miss
    const s = cache.stats();
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(1);
  });

  // 🔴 The discriminator this struct exists for. A COLD miss and an EXPIRED miss
  // have opposite remedies, so conflating them would make the metric useless while
  // still looking healthy. An implementation that bumped `expiredMisses` on every
  // miss passes a naive hit/miss test and fails this one.
  it('counts an EXPIRED miss but not a COLD miss as expired', () => {
    const cache = new TtlCache<boolean>(100, 10);

    cache.get('never-seen', 0); // cold miss: key absent from both generations
    expect(cache.stats()).toMatchObject({ misses: 1, expiredMisses: 0 });

    cache.set('k', true, 0);
    cache.get('k', 5_000); // present, but its TTL lapsed
    expect(cache.stats()).toMatchObject({ misses: 2, expiredMisses: 1 });
  });

  // Guards the capacity-bound signal. `rotations` must track maxEntries overflow,
  // NOT the number of inserts — an implementation incrementing on every `set`
  // would report a permanently capacity-bound cache and send the reader to the
  // wrong knob.
  it('counts a rotation only when maxEntries overflows', () => {
    const cache = new TtlCache<boolean>(10_000, 2);
    cache.set('a', true, 0);
    cache.set('b', true, 0);
    expect(cache.stats().rotations).toBe(0); // at capacity, not yet over it

    cache.set('c', true, 0); // overflow -> rotate
    expect(cache.stats().rotations).toBe(1);

    cache.set('d', true, 0); // current gen now holds c,d -> still no rotation
    expect(cache.stats().rotations).toBe(1);
  });

  it('counts a promoted read from the previous generation as a hit', () => {
    const cache = new TtlCache<boolean>(10_000, 1);
    cache.set('hot', true, 0);
    cache.set('other', true, 0); // rotates 'hot' into the previous generation
    expect(cache.get('hot', 0)).toEqual({ hit: true, value: true });
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().misses).toBe(0);
  });

  it('reports live size across both generations, and stays 0 when the TTL is 0', () => {
    const cache = new TtlCache<boolean>(10_000, 2);
    cache.set('a', true, 0);
    cache.set('b', true, 0);
    cache.set('c', true, 0); // a,b -> previous; c -> current
    expect(cache.stats().size).toBe(3);

    const disabled = new TtlCache<boolean>(0, 10);
    disabled.set('k', true, 0);
    expect(disabled.stats().size).toBe(0);
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
