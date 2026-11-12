import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { hkdfSync } from 'node:crypto';
import { EncryptJWT } from 'jose';
import { makeSysRedis, type SysRedisFake } from '../../../../test/sys-redis.fake';

// /api/auth/refresh and /api/auth/identity run on the hub's real verifier: a session is an ES256 token signed
// with the hub key, and a pre-June cookie (a JWE keyed from NEXTAUTH_SECRET) is not one.

const h = await vi.hoisted(async () => {
  // The package env is memoized on first read, so it must be set before the verifier module loads.
  const { generateKeyPairSync } = await import('node:crypto');
  const kp = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  process.env.AUTH_JWT_PUBLIC_KEY = kp.publicKey;
  process.env.AUTH_JWT_ISSUER = 'https://auth.test';
  process.env.NEXTAUTH_SECRET = 'pre-june-secret-0123456789';
  return {
    kp,
    sys: undefined as unknown as SysRedisFake,
    users: new Map<number, Record<string, unknown>>(),
  };
});

vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  isSecureCookie: () => false,
  maybeCreateSessionSigner: () => ({
    maxAge: 30 * 24 * 60 * 60,
    mintSessionToken: async () => 'fresh-token',
  }),
}));
vi.mock('$lib/server/redis', () => ({
  getSysRedis: () => h.sys,
  getRedis: () => null,
  evalSys: (script: string, keys: string[], args: string[]) =>
    h.sys.eval(script, { keys, arguments: args }),
}));
vi.mock('$lib/server/auth/registry', () => ({
  sessions: { isRevoked: async () => false, trackToken: async () => undefined },
}));
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: async (id: number) => h.users.get(id) ?? null,
}));

import type * as CivitaiAuth from '@civitai/auth';
import { createSessionSigner } from '@civitai/auth';
import { POST as REFRESH } from '../refresh/+server';
import { GET as IDENTITY } from '../identity/+server';

const USER = 7;

async function preJuneCookie() {
  const key = new Uint8Array(
    hkdfSync('sha256', process.env.NEXTAUTH_SECRET!, '', 'NextAuth.js Generated Encryption Key', 32)
  );
  return new EncryptJWT({ sub: String(USER), user: { id: USER }, id: 'jti-7' })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setJti('jti-7') // next-auth v4 set one, and refresh needs it
    .setIssuedAt()
    .setExpirationTime('1h')
    .encrypt(key);
}

let es256: string;
beforeAll(async () => {
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
  h.sys ??= makeSysRedis();
  h.sys.reset();
  h.users = new Map([[USER, { id: USER, username: 'seven' }]]);
});

const req = (path: string, token: string, method = 'GET') =>
  ({
    request: new Request(`https://auth.test${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
    }),
    url: new URL(`https://auth.test${path}`),
    cookies: { get: () => undefined },
  } as never);

async function statusOf(run: () => Response | Promise<Response>) {
  try {
    return (await run()).status;
  } catch (e) {
    return (e as { status: number }).status;
  }
}

describe('hub session routes and the pre-June cookie format', () => {
  it('POST /api/auth/refresh refuses a JWE encrypted with the configured NEXTAUTH_SECRET', async () => {
    const token = await preJuneCookie();
    expect(await statusOf(() => REFRESH(req('/api/auth/refresh', token, 'POST')))).toBe(401);
  });

  it('GET /api/auth/identity refuses a JWE encrypted with the configured NEXTAUTH_SECRET', async () => {
    const token = await preJuneCookie();
    expect(await statusOf(() => IDENTITY(req('/api/auth/identity', token)))).toBe(401);
  });

  it('POST /api/auth/refresh still rolls an ES256 session', async () => {
    const res = await REFRESH(req('/api/auth/refresh', es256, 'POST'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: 'fresh-token' });
  });

  it('GET /api/auth/identity still resolves an ES256 session', async () => {
    const res = await IDENTITY(req('/api/auth/identity', es256));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: USER });
  });
});
