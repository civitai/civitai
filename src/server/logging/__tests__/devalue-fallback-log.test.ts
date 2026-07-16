import { describe, expect, it } from 'vitest';

import { createFallbackDedup, fallbackDedupKeys } from '~/server/logging/devalue-fallback-log';

/**
 * FIX 1 (PR #3186 audit): the devalue-write-fallback logger deduped on the RAW,
 * client-controlled, comma-joined batch string from the serialize ALS ctx and
 * never evicted its Map. These tests pin the two fixes: normalize the key to the
 * individual PROCEDURE (so a re-framed offender can't flood Axiom) and BOUND the
 * tracking Map (so it can't grow unboundedly on a long-lived module).
 */

describe('fallbackDedupKeys (normalize the batch path to individual procedures)', () => {
  it('passes a single procedure through unchanged', () => {
    expect(fallbackDedupKeys('image.getInfinite')).toEqual(['image.getInfinite']);
  });

  it('splits a comma-joined batch into its individual procedures', () => {
    expect(fallbackDedupKeys('image.getInfinite,model.getById')).toEqual([
      'image.getInfinite',
      'model.getById',
    ]);
  });

  it("splits on '/' too (the array-join separator) and de-duplicates repeats", () => {
    expect(fallbackDedupKeys('a.x/b.y')).toEqual(['a.x', 'b.y']);
    expect(fallbackDedupKeys('a.x,a.x,b.y')).toEqual(['a.x', 'b.y']);
  });

  it('collapses empty / whitespace-only input to ["unknown"]', () => {
    expect(fallbackDedupKeys('')).toEqual(['unknown']);
    expect(fallbackDedupKeys('  ,  ')).toEqual(['unknown']);
    expect(fallbackDedupKeys('unknown')).toEqual(['unknown']);
  });

  it('keeps an SSR dehydrate marker intact (no comma/slash → single key)', () => {
    expect(fallbackDedupKeys('ssr:dehydrate:user.[username].models')).toEqual([
      'ssr:dehydrate:user.[username].models',
    ]);
  });
});

describe('createFallbackDedup — per-procedure window dedup', () => {
  it('logs a key once per window, then again after the window elapses', () => {
    const dedup = createFallbackDedup({ windowMs: 1000, maxSize: 100 });
    expect(dedup.shouldLog('image.getInfinite', 0)).toBe(true);
    expect(dedup.shouldLog('image.getInfinite', 500)).toBe(false); // within window
    expect(dedup.shouldLog('image.getInfinite', 1001)).toBe(true); // window elapsed
  });

  it('a re-framed offender across two batch framings logs ONCE (defeats the flood)', () => {
    // The audit's attack: hit offender.proc inside arbitrarily many batch
    // framings — each a distinct RAW path, but the SAME offending procedure.
    const dedup = createFallbackDedup({ windowMs: 30_000, maxSize: 100 });
    const framings = ['offender.proc,other.a', 'offender.proc,other.b', 'offender.proc/other.c'];
    const logged: string[] = [];
    const now = 1000;
    for (const raw of framings) {
      for (const key of fallbackDedupKeys(raw)) {
        if (dedup.shouldLog(key, now)) logged.push(key);
      }
    }
    // offender.proc appears in all three framings but logs exactly once; the
    // distinct neighbours each log once.
    expect(logged.filter((k) => k === 'offender.proc')).toHaveLength(1);
    expect(logged).toEqual(['offender.proc', 'other.a', 'other.b', 'other.c']);
  });
});

describe('createFallbackDedup — the Map is SIZE-BOUNDED (never grows past the cap)', () => {
  it('caps at maxSize with drop-oldest eviction across many distinct keys', () => {
    const maxSize = 1000;
    const dedup = createFallbackDedup({ windowMs: 30_000, maxSize });
    // 10x the cap of DISTINCT keys, all within one window (so nothing dedups by time).
    for (let i = 0; i < maxSize * 10; i++) {
      expect(dedup.shouldLog(`proc.${i}`, 1000)).toBe(true);
      expect(dedup.size()).toBeLessThanOrEqual(maxSize);
    }
    expect(dedup.size()).toBe(maxSize);
  });

  it('drops the OLDEST-logged key when at cap (recent keys stay deduped)', () => {
    const dedup = createFallbackDedup({ windowMs: 30_000, maxSize: 2 });
    expect(dedup.shouldLog('a', 0)).toBe(true); // {a}
    expect(dedup.shouldLog('b', 0)).toBe(true); // {a,b}
    expect(dedup.shouldLog('c', 0)).toBe(true); // at cap → evict oldest (a) → {b,c}
    expect(dedup.size()).toBe(2);
    // 'b' survived the eviction, so it is still deduped within the window…
    expect(dedup.shouldLog('b', 0)).toBe(false);
    // …while 'a' was evicted (its window state dropped), so it logs again.
    expect(dedup.shouldLog('a', 0)).toBe(true);
  });
});
