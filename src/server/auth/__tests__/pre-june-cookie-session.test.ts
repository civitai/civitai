import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { hkdfSync } from 'node:crypto';
import { EncryptJWT } from 'jose';
import type * as CivitaiAuth from '@civitai/auth';
import { legacySessionCookieName, sessionCookieName } from '@civitai/auth';
import { setEnv } from '~/__tests__/mocks/env.mock';

// getServerAuthSession with the real verifier and the real preview decoder. Only the user lookup (shared cache
// / hub) is stubbed: a user is returned for whatever id a credential resolves to, so a null session means the
// credential itself was refused.

const SECRET = 'pre-june-secret-0123456789';
const USER = 7;

const h = await vi.hoisted(async () => {
  // The package env (memoized on first read) holds the same secret the app env does, as in a deployment.
  process.env.NEXTAUTH_SECRET = 'pre-june-secret-0123456789';
  const { generateKeyPairSync } = await import('node:crypto');
  const kp = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    kp,
    verifier: undefined as undefined | CivitaiAuth.AuthVerifier,
    getSessionUserById: undefined as unknown as Mock<(id: number) => Promise<unknown>>,
  };
});

vi.mock('@civitai/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof CivitaiAuth>();
  return {
    ...actual,
    createSessionClient: () => ({
      async getSessionUser(token: string) {
        const claims = await h.verifier!.verifyToken(token);
        return claims ? { id: Number(claims.sub), username: 'seven' } : null;
      },
      getSessionUserById: (id: number) => h.getSessionUserById(id),
    }),
  };
});

const { createAuthVerifier, createSessionSigner } = await import('@civitai/auth');
const { getServerAuthSession } = await import('~/server/auth/get-server-auth-session');

async function preJuneCookie(
  payload: Record<string, unknown> = { sub: String(USER), user: { id: USER, username: 'seven' } }
) {
  const key = new Uint8Array(
    hkdfSync('sha256', SECRET, '', 'NextAuth.js Generated Encryption Key', 32)
  );
  return new EncryptJWT({ ...payload, id: 'jti-7' })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setJti('jti-7')
    .setIssuedAt()
    .setExpirationTime('1h')
    .encrypt(key);
}

let es256: string;
beforeAll(async () => {
  h.verifier = createAuthVerifier({
    issuer: 'https://auth.test',
    publicKeyPem: h.kp.publicKey,
  });
  const signer = createSessionSigner({
    privateKeyPem: h.kp.privateKey,
    publicKeyPem: h.kp.publicKey,
    kid: 'k1',
    issuer: 'https://auth.test',
    maxAge: 3600,
  });
  es256 = await signer.mintSessionToken(
    { sub: String(USER), signedAt: Date.now(), iat0: Date.now() },
    { jti: 'j-7' }
  );
});

beforeEach(() => {
  h.getSessionUserById = vi.fn(async (id: number) => ({ id, username: 'seven' }));
  setEnv({ NEXTAUTH_SECRET: SECRET });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const read = (cookies: Record<string, string>) =>
  getServerAuthSession({
    req: { headers: { host: 'civitai.com' }, cookies, url: '/' } as never,
    res: { setHeader: () => undefined, getHeader: () => undefined } as never,
  });

describe('getServerAuthSession and the pre-June cookie format', () => {
  it.each([[undefined], ['false']])(
    'refuses the old session cookie when IS_PREVIEW is %s',
    async (value) => {
      vi.stubEnv('IS_PREVIEW', value);
      vi.stubEnv('DATABASE_ENVIRONMENT', 'non-production');
      expect(await read({ [legacySessionCookieName()]: await preJuneCookie() })).toBeNull();
      expect(h.getSessionUserById).not.toHaveBeenCalled();
    }
  );

  it('refuses the same JWE presented as the hub session cookie', async () => {
    expect(await read({ [sessionCookieName()]: await preJuneCookie() })).toBeNull();
  });

  it('still resolves an ES256 hub session', async () => {
    const session = await read({ [sessionCookieName()]: es256 });
    expect(session?.user).toMatchObject({ id: USER });
  });

  it.each([[undefined], ['production']])(
    'refuses the old session cookie on a preview when DATABASE_ENVIRONMENT is %s',
    async (value) => {
      vi.stubEnv('IS_PREVIEW', 'true');
      vi.stubEnv('DATABASE_ENVIRONMENT', value);
      expect(await read({ [legacySessionCookieName()]: await preJuneCookie() })).toBeNull();
      expect(h.getSessionUserById).not.toHaveBeenCalled();
    }
  );

  describe('on a preview with a scratch database', () => {
    beforeEach(() => {
      vi.stubEnv('IS_PREVIEW', 'true');
      vi.stubEnv('DATABASE_ENVIRONMENT', 'non-production');
    });

    it('keeps the test sign-in as the user embedded in the cookie, without asking the hub', async () => {
      const session = await read({ [legacySessionCookieName()]: await preJuneCookie() });
      expect(session?.user).toEqual({ id: USER, username: 'seven' });
      expect(h.getSessionUserById).not.toHaveBeenCalled();
    });

    it('never resolves a `sub` from the hub: no embedded user means no session', async () => {
      const PROD_USER = 4242;
      const cookie = await preJuneCookie({ sub: String(PROD_USER) });
      expect(await read({ [legacySessionCookieName()]: cookie })).toBeNull();
      expect(h.getSessionUserById).not.toHaveBeenCalled();
    });

    it('a `sub` naming another user does not change whose session it is', async () => {
      const PROD_USER = 4242;
      const cookie = await preJuneCookie({ sub: String(PROD_USER), user: { id: USER } });
      const session = await read({ [legacySessionCookieName()]: cookie });
      expect(session?.user).toEqual({ id: USER });
      expect(h.getSessionUserById).not.toHaveBeenCalled();
    });
  });
});
