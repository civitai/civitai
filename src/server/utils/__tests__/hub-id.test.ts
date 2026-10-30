import { describe, expect, it } from 'vitest';
import Sqids from 'sqids';
import { decodeHubId, encodeHubId, permuteAlphabet } from '~/server/utils/hub-id';

const ALPHABET = 'abcdefghijkmnopqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * The hub's public identifier. This is obfuscation, not authorisation — every read
 * still applies `hubViewerWhere` — so what these assert is the one property it buys:
 * you cannot walk hub ids by counting.
 *
 * `HUB_ID_SALT` is read at module load and is unset under test, so the codec here is
 * the empty-salt one. That is exactly why the golden vectors below are pinnable, and
 * why `permuteAlphabet` is exported and tested with the salt as an ARGUMENT: the
 * permutation is the half that only ever runs where nothing observes it.
 */
describe('hub id encoding', () => {
  it('emits these exact keys — every shared hub link depends on it', () => {
    // 🔴 Golden vectors, not decoration. If these change, that IS the change — it is
    // not a test to update. They catch a change to ALPHABET, to MIN_LENGTH, or to the
    // `sqids` version, each of which silently invalidates every hub URL anyone has
    // ever shared while the property tests below stay green.
    //
    // What they CANNOT catch: the permutation. `HUB_ID_SALT` is empty here, so
    // `permuteAlphabet` early-returns and never runs — flipping its comparator
    // changes every production URL and leaves these three bytes for byte. The salted
    // vectors below are that half; neither set replaces the other.
    expect(encodeHubId(1)).toBe('v87ycDn6');
    expect(encodeHubId(19)).toBe('F2H4AkZM');
    expect(encodeHubId(12345)).toBe('s88C6Fdz');
  });

  it('emits these exact keys once a salt is set — the half prod actually runs', () => {
    // 🔴 The same rule as above, for the configuration that ships. Reached through a
    // constructed codec rather than `encodeHubId`, because the module's own instance
    // is built at import with the empty salt and cannot be re-salted from a test.
    const salted = new Sqids({
      alphabet: permuteAlphabet(ALPHABET, 'test-salt'),
      minLength: 8,
    });

    expect(permuteAlphabet(ALPHABET, 'test-salt')).toBe(
      '2etESUusFfKV3JmpkoaPq9Dny45MAwH8gdrzjhGZ6xi7YbLvQRCTXcNW'
    );
    expect(salted.encode([1])).toBe('6FwNrAix');
    expect(salted.encode([19])).toBe('2t4jNyE9');
    expect(salted.encode([12345])).toBe('RMM5EQWU');
  });

  it('round-trips', () => {
    for (const id of [1, 2, 19, 1000, 123456, 2_147_483_647]) {
      expect(decodeHubId(encodeHubId(id))).toBe(id);
    }
  });

  it('refuses a bare integer, which is what the pre-encoding URLs carried', () => {
    for (const raw of ['1', '19', '1000', '0', '-1']) {
      expect(decodeHubId(raw)).toBeNull();
    }
  });

  it('refuses junk rather than throwing, so a bad URL is a 404 and not a 500', () => {
    for (const raw of ['', ' ', 'not-a-key', '!!!!', 'l1I0O', 'a'.repeat(200)]) {
      expect(decodeHubId(raw)).toBeNull();
    }
  });

  it('does not leak id order in EITHER direction', () => {
    // Sorting and asserting "not ascending" is not the property: a codec encoding
    // `MAX - id` produces keys whose order is reversed, which passes that check while
    // ordering is perfectly recoverable. Both monotone directions have to fail.
    const ids = Array.from({ length: 50 }, (_, i) => i + 1);
    const keys = ids.map(encodeHubId);

    const ascending = keys.every((key, i) => i === 0 || keys[i - 1] < key);
    const descending = keys.every((key, i) => i === 0 || keys[i - 1] > key);

    expect(ascending).toBe(false);
    expect(descending).toBe(false);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('pads short ids so hub 1 is not visibly hub 1', () => {
    expect(encodeHubId(1).length).toBeGreaterThanOrEqual(8);
  });

  it('never emits characters that get mangled when a link is read aloud or copied', () => {
    const keys = [1, 42, 999, 123456, 9_999_999].map(encodeHubId);
    for (const key of keys) expect(key).toMatch(/^[a-zA-Z2-9]+$/);
    for (const key of keys) expect(key).not.toMatch(/[lIO01B]/);
  });
});

describe('permuteAlphabet', () => {
  // The salt's only job. The first version folded it into a 32-bit seed and drove an
  // LCG, which capped the reachable alphabets at ~2^24 regardless of salt length —
  // enumerable in under a minute from the constant above, which is public. These
  // assert the properties that made that version wrong.

  it('is a PERMUTATION — same characters, no duplicates, nothing dropped', () => {
    // The one that catches a broken swap. Sqids validates alphabet uniqueness in its
    // constructor and the codec builds at MODULE LOAD, so a duplicate character does
    // not 404 a link — it throws on import of anything that reaches this file, which
    // is the app router. Under test the salt is empty and that path never runs, so
    // without this assertion the whole permutation is unobserved.
    for (const salt of ['a', 'test-salt', 'x'.repeat(64), 'ünïcode-salt']) {
      const result = permuteAlphabet(ALPHABET, salt);
      expect(result).toHaveLength(ALPHABET.length);
      expect(new Set(result).size).toBe(result.length);
      expect([...result].sort().join('')).toBe([...ALPHABET].sort().join(''));
    }
  });

  it('produces an alphabet Sqids will actually accept', () => {
    // The codec is constructed at MODULE LOAD, and Sqids rejects a duplicate character
    // in its constructor — so a bad permutation is not a broken link, it is an import
    // that throws inside the app router. Under test the salt is empty and that path
    // never runs, which is what makes this assertion the only place it is exercised.
    for (const salt of ['a', 'test-salt', 'x'.repeat(64)]) {
      expect(
        () => new Sqids({ alphabet: permuteAlphabet(ALPHABET, salt), minLength: 8 })
      ).not.toThrow();
    }
  });

  it('is stable for one salt — two pods must mint the same URL', () => {
    expect(permuteAlphabet(ALPHABET, 'test-salt')).toBe(permuteAlphabet(ALPHABET, 'test-salt'));
  });

  it('actually uses the salt, and uses ALL of it', () => {
    const base = permuteAlphabet(ALPHABET, 'test-salt');
    expect(permuteAlphabet(ALPHABET, 'other-salt')).not.toBe(base);
    // Two salts differing only in their tail. A fold that reads a prefix, or one that
    // collapses the salt into a small seed, is what this separates from a keyed hash.
    const long = 'x'.repeat(200);
    expect(permuteAlphabet(ALPHABET, `${long}a`)).not.toBe(permuteAlphabet(ALPHABET, `${long}b`));
  });

  it('leaves the alphabet alone for an empty salt, and only for an empty salt', () => {
    expect(permuteAlphabet(ALPHABET, '')).toBe(ALPHABET);
    // The negative control. Without it, deleting the permutation entirely and always
    // returning the alphabet passes every assertion above — which is precisely the
    // silently-decorative state this whole file exists to make impossible.
    expect(permuteAlphabet(ALPHABET, 'test-salt')).not.toBe(ALPHABET);
  });
});
