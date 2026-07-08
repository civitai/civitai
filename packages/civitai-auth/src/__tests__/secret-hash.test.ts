import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';

// generateSecretHash salts with NEXTAUTH_SECRET via loadAuthEnv (lazy, read at call time), so set it
// before the first call. The whole point of the move is that the hub and main app derive the SAME hash —
// this asserts the formula is exactly `SHA512(key + NEXTAUTH_SECRET)` so neither side can drift.
const SECRET = 'test-nextauth-secret';
process.env.NEXTAUTH_SECRET = SECRET;

import { generateKey, generateSecretHash } from '../secret-hash';

describe('generateSecretHash', () => {
  it('is SHA-512 of `${key}${NEXTAUTH_SECRET}` and deterministic', () => {
    const key = 'abc123';
    const expected = createHash('sha512').update(`${key}${SECRET}`).digest('hex');
    expect(generateSecretHash(key)).toBe(expected);
    expect(generateSecretHash(key)).toBe(generateSecretHash(key));
  });

  it('different keys produce different hashes', () => {
    expect(generateSecretHash('a')).not.toBe(generateSecretHash('b'));
  });
});

describe('generateKey', () => {
  it('returns `length` hex chars (default 32; randomBytes(length/2))', () => {
    expect(generateKey()).toMatch(/^[0-9a-f]{32}$/);
    expect(generateKey(16)).toMatch(/^[0-9a-f]{16}$/);
    expect(generateKey()).not.toBe(generateKey()); // random
  });
});
