import { describe, it, expect } from 'vitest';
import { hkdfSync } from 'node:crypto';
import { EncryptJWT } from 'jose';
import { decodeLegacySessionCookie } from '../legacy-cookie';

// Mints a next-auth-v4-shaped JWE (dir / A256GCM, HKDF key) using the SAME derivation the decoder uses, so this
// validates the decoder is self-consistent with the format. (Validating against a REAL next-auth cookie needs a
// captured fixture + secret — out of scope for a unit test; the HKDF params mirror next-auth v4's source.)
const SECRET = 'test-secret-0123456789';
const ENC_INFO = 'NextAuth.js Generated Encryption Key';
const key = () => new Uint8Array(hkdfSync('sha256', SECRET, '', ENC_INFO, 32));

async function mintLegacy(payload: Record<string, unknown>, expSecondsFromNow = 3600) {
  return new EncryptJWT(payload)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expSecondsFromNow)
    .encrypt(key());
}

describe('decodeLegacySessionCookie', () => {
  it('round-trips a next-auth-style JWE (dir/A256GCM, hkdf-derived key)', async () => {
    const token = await mintLegacy({ sub: '7', user: { id: 7, username: 'bob' } });
    expect(await decodeLegacySessionCookie(token, SECRET)).toMatchObject({
      sub: '7',
      user: { id: 7, username: 'bob' },
    });
  });

  it('returns null on a wrong secret', async () => {
    const token = await mintLegacy({ sub: '7' });
    expect(await decodeLegacySessionCookie(token, 'a-different-secret-9876')).toBeNull();
  });

  it('returns null on a garbage token', async () => {
    expect(await decodeLegacySessionCookie('not.a.jwe', SECRET)).toBeNull();
  });

  it('returns null on an expired token', async () => {
    const token = await mintLegacy({ sub: '7' }, -3600);
    expect(await decodeLegacySessionCookie(token, SECRET)).toBeNull();
  });
});
