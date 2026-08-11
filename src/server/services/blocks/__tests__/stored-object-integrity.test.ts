import { describe, expect, it } from 'vitest';

import {
  STORED_OBJECT_ETAG_META_KEY,
  classifyStoredObjectIntegrity,
  normalizeEtag,
  readRecordedEtag,
  storedObjectEtagMetadata,
} from '~/server/services/blocks/stored-object-integrity';
import type { StoredImageHead } from '~/server/utils/stored-image-probe';

/**
 * The pure rule behind the listing-media integrity re-check.
 *
 * The property under test is asymmetric and easy to get subtly wrong in the
 * permissive direction: exactly ONE combination may say "this changed", and every
 * other combination must say "I could not tell" — never "this is fine" and never
 * "this changed". So the cases below enumerate the whole cross-product of
 * (recorded tag present/absent) × (head present/absent/unknown) × (current tag
 * present/absent) rather than sampling the interesting ones.
 */

const present = (etag: string | null): StoredImageHead => ({ status: 'present', etag });

describe('normalizeEtag', () => {
  it('strips one layer of surrounding quotes so the two wire forms compare equal', () => {
    expect(normalizeEtag('"abc123"')).toBe('abc123');
    expect(normalizeEtag('abc123')).toBe('abc123');
    // POSITIVE CONTROL for the stripping step: it must actually change something,
    // or an assertion that quoted and bare forms agree would hold vacuously.
    expect(normalizeEtag('"abc123"')).not.toBe('"abc123"');
  });

  it('trims surrounding whitespace, inside and outside the quotes', () => {
    expect(normalizeEtag('  "abc123"  ')).toBe('abc123');
    expect(normalizeEtag('" abc123 "')).toBe('abc123');
  });

  it('does NOT strip a second layer of quotes (the tag is opaque, not parsed)', () => {
    expect(normalizeEtag('""abc123""')).toBe('"abc123"');
  });

  it('returns null for every shape that is not a usable tag', () => {
    for (const bad of [null, undefined, 42, {}, [], true, '', '   ', '""', '"   "']) {
      expect(normalizeEtag(bad)).toBeNull();
    }
  });

  it('rejects a WEAK validator — a weak tag cannot certify byte identity', () => {
    expect(normalizeEtag('W/"abc123"')).toBeNull();
  });
});

describe('readRecordedEtag', () => {
  it('reads the tag out of an Image.metadata blob', () => {
    expect(readRecordedEtag({ size: 10, [STORED_OBJECT_ETAG_META_KEY]: '"abc"' })).toBe('abc');
  });

  it('returns null for a metadata blob that does not carry one', () => {
    for (const meta of [null, undefined, {}, { size: 10 }, 'nope', 7, []]) {
      expect(readRecordedEtag(meta)).toBeNull();
    }
  });

  it('returns null when the key holds a non-string (an untyped JSON column)', () => {
    expect(readRecordedEtag({ [STORED_OBJECT_ETAG_META_KEY]: 12345 })).toBeNull();
    expect(readRecordedEtag({ [STORED_OBJECT_ETAG_META_KEY]: { v: 'abc' } })).toBeNull();
    expect(readRecordedEtag({ [STORED_OBJECT_ETAG_META_KEY]: '' })).toBeNull();
  });
});

describe('storedObjectEtagMetadata', () => {
  it('contributes the tag under the shared key when there is one', () => {
    expect(storedObjectEtagMetadata('"abc"')).toEqual({ [STORED_OBJECT_ETAG_META_KEY]: 'abc' });
  });

  it('contributes NOTHING when there is no usable tag — never a null entry', () => {
    for (const bad of [null, '', '   ', 'W/"abc"']) {
      expect(storedObjectEtagMetadata(bad)).toEqual({});
    }
  });

  /**
   * The round trip the two services actually depend on: what persist merges into
   * `Image.metadata` is what the attach gate reads back out. A drift in the key
   * name would leave both halves individually correct and the pair inert.
   */
  it('round-trips through readRecordedEtag', () => {
    expect(readRecordedEtag({ size: 1, ...storedObjectEtagMetadata('"round-trip"') })).toBe(
      'round-trip'
    );
    expect(readRecordedEtag({ size: 1, ...storedObjectEtagMetadata(null) })).toBeNull();
  });
});

describe('classifyStoredObjectIntegrity', () => {
  it('MATCH: the live object carries the tag that was recorded', () => {
    expect(classifyStoredObjectIntegrity('"abc"', present('"abc"'))).toEqual({ status: 'match' });
  });

  it('MATCH across the quoted/bare wire forms', () => {
    expect(classifyStoredObjectIntegrity('abc', present('"abc"'))).toEqual({ status: 'match' });
    expect(classifyStoredObjectIntegrity('"abc"', present('abc'))).toEqual({ status: 'match' });
  });

  it('MISMATCH: the live object carries a DIFFERENT tag — the only asserting verdict', () => {
    expect(classifyStoredObjectIntegrity('"abc"', present('"def"'))).toEqual({
      status: 'mismatch',
    });
  });

  it('UNVERIFIABLE (no-recorded-etag): a row written before the tag was recorded', () => {
    expect(classifyStoredObjectIntegrity(null, present('"def"'))).toEqual({
      status: 'unverifiable',
      reason: 'no-recorded-etag',
    });
  });

  it('UNVERIFIABLE (object-absent): the store says the key is gone', () => {
    expect(classifyStoredObjectIntegrity('"abc"', { status: 'absent' })).toEqual({
      status: 'unverifiable',
      reason: 'object-absent',
    });
  });

  it('UNVERIFIABLE (store-unreachable): the store could not be consulted', () => {
    expect(classifyStoredObjectIntegrity('"abc"', { status: 'unknown' })).toEqual({
      status: 'unverifiable',
      reason: 'store-unreachable',
    });
  });

  it('UNVERIFIABLE (no-current-etag): the object is there but the store returned no tag', () => {
    expect(classifyStoredObjectIntegrity('"abc"', present(null))).toEqual({
      status: 'unverifiable',
      reason: 'no-current-etag',
    });
    expect(classifyStoredObjectIntegrity('"abc"', present('  '))).toEqual({
      status: 'unverifiable',
      reason: 'no-current-etag',
    });
  });

  /**
   * 🔴 The failure that would make the guard worse than useless: two ABSENT tags
   * comparing equal and reading as agreement. `null === null` is true, so this is a
   * one-character mistake away at all times.
   */
  it('never reports MATCH when either side has no tag', () => {
    expect(classifyStoredObjectIntegrity(null, present(null)).status).toBe('unverifiable');
    expect(classifyStoredObjectIntegrity('', present('')).status).toBe('unverifiable');
  });

  it('never reports MISMATCH from an absence — that would reject healthy images', () => {
    const absences: [string | null, StoredImageHead][] = [
      [null, present('"def"')],
      ['"abc"', present(null)],
      ['"abc"', { status: 'absent' }],
      ['"abc"', { status: 'unknown' }],
      [null, { status: 'absent' }],
      [null, { status: 'unknown' }],
      [null, present(null)],
    ];
    for (const [recorded, head] of absences) {
      expect(classifyStoredObjectIntegrity(recorded, head).status).toBe('unverifiable');
    }
  });
});
