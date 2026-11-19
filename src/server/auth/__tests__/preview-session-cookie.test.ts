import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { hkdfSync } from 'node:crypto';
import { EncryptJWT } from 'jose';
import { decodePreviewSessionCookie } from '../preview-session-cookie';

// Mints the cookie the preview pipeline sets (next-auth v4 shape: dir / A256GCM, HKDF key from the secret).
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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('decodePreviewSessionCookie outside a preview on a scratch database', () => {
  it.each([[undefined], ['false'], ['TRUE'], ['1'], ['']])(
    'returns null when IS_PREVIEW is %s',
    async (value) => {
      vi.stubEnv('IS_PREVIEW', value);
      vi.stubEnv('DATABASE_ENVIRONMENT', 'non-production');
      const token = await mintLegacy({ sub: '7', user: { id: 7 } });
      expect(await decodePreviewSessionCookie(token, SECRET)).toBeNull();
    }
  );

  it.each([[undefined], ['production'], [''], ['NON-PRODUCTION'], [' non-production ']])(
    'returns null on a preview when DATABASE_ENVIRONMENT is %s',
    async (value) => {
      vi.stubEnv('IS_PREVIEW', 'true');
      vi.stubEnv('DATABASE_ENVIRONMENT', value);
      const token = await mintLegacy({ sub: '7', user: { id: 7 } });
      expect(await decodePreviewSessionCookie(token, SECRET)).toBeNull();
    }
  );
});

describe('decodePreviewSessionCookie on a preview', () => {
  beforeEach(() => {
    vi.stubEnv('IS_PREVIEW', 'true');
    vi.stubEnv('DATABASE_ENVIRONMENT', 'non-production');
  });

  it('round-trips a next-auth-style JWE (dir/A256GCM, hkdf-derived key)', async () => {
    const token = await mintLegacy({ sub: '7', user: { id: 7, username: 'bob' } });
    expect(await decodePreviewSessionCookie(token, SECRET)).toMatchObject({
      sub: '7',
      user: { id: 7, username: 'bob' },
    });
  });

  it('returns null on a wrong secret', async () => {
    const token = await mintLegacy({ sub: '7' });
    expect(await decodePreviewSessionCookie(token, 'a-different-secret-9876')).toBeNull();
  });

  it('returns null on a garbage token', async () => {
    expect(await decodePreviewSessionCookie('not.a.jwe', SECRET)).toBeNull();
  });

  it('returns null for a token without an expiry', async () => {
    const token = await new EncryptJWT({ sub: '7' })
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .encrypt(key());
    expect(await decodePreviewSessionCookie(token, SECRET)).toBeNull();
  });

  it.each([
    ['impersonatedBy', 100],
    ['impExp', Date.now() + 60_000],
  ])('returns null for a token carrying %s', async (claim, value) => {
    const token = await mintLegacy({ sub: '7', [claim]: value });
    expect(await decodePreviewSessionCookie(token, SECRET)).toBeNull();
  });

  it('returns null on an expired token', async () => {
    const token = await mintLegacy({ sub: '7' }, -3600);
    expect(await decodePreviewSessionCookie(token, SECRET)).toBeNull();
  });
});
