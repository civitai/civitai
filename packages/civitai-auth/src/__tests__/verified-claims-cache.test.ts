import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSessionSigner } from '../sign';
import { createAuthVerifier, type AuthVerifierConfig } from '../verify';
import { createSessionClient } from '../session-client';
import type { SessionClaims } from '../types';

// The switched verification cache (verified-claims-cache.ts) over the REAL verifier and REAL jose. Only the
// key pair, the env, the shared user cache and a call counter on jose's `jwtVerify` are fakes, so each test
// observes whether the signature check actually ran.
const ISSUER = 'https://auth.test';
const keys = await vi.hoisted(async () => {
  const { generateKeyPairSync } = await import('crypto');
  return generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
});
const jose = vi.hoisted(() => ({ jwtVerify: undefined as unknown as ReturnType<typeof vi.fn> }));
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof Jose>();
  jose.jwtVerify = vi.fn(actual.jwtVerify);
  return { ...actual, jwtVerify: jose.jwtVerify };
});
vi.mock('../env', async (importOriginal) => {
  const actual = await importOriginal<typeof Env>();
  return {
    ...actual,
    loadAuthEnv: () => ({
      ...actual.loadAuthEnv(),
      AUTH_JWT_ISSUER: 'https://auth.test',
      AUTH_JWT_PUBLIC_KEY: keys.publicKey,
    }),
  };
});
vi.mock('../redis', async (importOriginal) => ({
  ...(await importOriginal<typeof Redis>()),
  getCacheRedis: () => ({
    packed: { get: async (key: string) => ({ id: Number(key.split(':').pop()), username: 'u' }) },
  }),
}));
import type * as Jose from 'jose';
import type * as Env from '../env';
import type * as Redis from '../redis';

const signer = createSessionSigner({
  privateKeyPem: keys.privateKey,
  publicKeyPem: keys.publicKey,
  kid: 'k1',
  issuer: ISSUER,
  maxAge: 3600,
});
const mint = (userId: number, jti: string) =>
  signer.mintSessionToken({ sub: String(userId), user: { id: userId }, signedAt: 1 }, { jti });

const verifyCalls = () => jose.jwtVerify.mock.calls.length;
const on = { enabled: () => true, ttlMs: 24 * 60 * 60 * 1000 }; // TTL past the token's life: exp binds
const verifier = (extra: Partial<AuthVerifierConfig> = {}) =>
  createAuthVerifier({ issuer: ISSUER, publicKeyPem: keys.publicKey, ...extra });

// Replace one character in the middle of a token segment with a different base64url character.
function flipChar(token: string, segment: 0 | 1 | 2): string {
  const parts = token.split('.');
  const s = parts[segment];
  const i = Math.floor(s.length / 2);
  parts[segment] = s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
  return parts.join('.');
}

// Braced: an arrow returning mockClear()'s result (the mock itself) would be run by vitest as a teardown.
beforeEach(() => {
  jose.jwtVerify.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('verified claims cache — hit and miss', () => {
  it('miss: the first presentation runs the signature check and returns the claims', async () => {
    const v = verifier({ claimsCache: on });
    const claims = await v.verifyToken(await mint(7, 'a'));
    expect(claims?.jti).toBe('a');
    expect(claims?.user).toMatchObject({ id: 7 });
    expect(verifyCalls()).toBe(1);
  });

  it('hit: the same token again returns the same claims without running the signature check', async () => {
    const v = verifier({ claimsCache: on });
    const token = await mint(7, 'a');
    const first = await v.verifyToken(token);
    const second = await v.verifyToken(token);
    expect(second).toEqual(first);
    expect(second?.jti).toBe('a');
    expect(verifyCalls()).toBe(1);
  });

  it('serves a copy: mutating returned claims (miss or hit) never changes what a later hit returns', async () => {
    const v = verifier({ claimsCache: on });
    const token = await mint(7, 'a');
    const miss = (await v.verifyToken(token)) as SessionClaims & { user: { id: number } };
    miss.user.id = 999;
    const hit = (await v.verifyToken(token)) as SessionClaims & { user: { id: number } };
    expect(hit.user.id).toBe(7);
    hit.user.id = 998;
    expect(((await v.verifyToken(token)) as typeof hit).user.id).toBe(7);
    expect(verifyCalls()).toBe(1);
  });
});

describe('verified claims cache — expiry', () => {
  it('a hit still enforces exp: served 1 ms before exp, refused at exp', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const v = verifier({ claimsCache: on });
    const token = await mint(7, 'a');
    const claims = await v.verifyToken(token);
    const expMs = (claims?.exp as number) * 1000;
    expect(verifyCalls()).toBe(1);

    vi.setSystemTime(expMs - 1);
    expect((await v.verifyToken(token))?.jti).toBe('a');
    expect(verifyCalls()).toBe(1); // still a hit

    vi.setSystemTime(expMs);
    expect(await v.verifyToken(token)).toBeNull();
  });

  it('an entry is served for at most ttlMs, then the signature is checked again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const v = verifier({ claimsCache: { enabled: () => true, ttlMs: 1000 } });
    const token = await mint(7, 'a');
    await v.verifyToken(token);
    vi.setSystemTime(Date.now() + 999);
    await v.verifyToken(token);
    expect(verifyCalls()).toBe(1);
    vi.setSystemTime(Date.now() + 1);
    expect((await v.verifyToken(token))?.jti).toBe('a');
    expect(verifyCalls()).toBe(2);
  });
});

describe('verified claims cache — revocation is still checked on every call', () => {
  it('a token revoked after it was cached is refused on the cache hit', async () => {
    let revoked = false;
    const isRevoked = vi.fn(async () => revoked);
    const v = verifier({ claimsCache: on, isRevoked });
    const token = await mint(7, 'a');

    expect((await v.verifyToken(token))?.jti).toBe('a');
    revoked = true;
    expect(await v.verifyToken(token)).toBeNull();

    expect(verifyCalls()).toBe(1); // the second call WAS a hit
    expect(isRevoked).toHaveBeenCalledTimes(2);
    expect(isRevoked.mock.calls[1][0]).toMatchObject({ jti: 'a', sub: '7' });
  });

  it('through createSessionClient (the getSessionUser read path): a hit still runs isRevoked', async () => {
    let revoked = false;
    const isRevoked = vi.fn(async () => revoked);
    const client = createSessionClient({ isRevoked, claimsCache: { enabled: () => true } });
    const token = await mint(7, 'a');

    expect(await client.getSessionUser(token)).toMatchObject({ id: 7 });
    revoked = true;
    expect(await client.getSessionUser(token)).toBeNull();

    expect(verifyCalls()).toBe(1); // claimsCache reached the verifier: the second read was a hit
    expect(isRevoked).toHaveBeenCalledTimes(2);
  });
});

describe('verified claims cache — one token never answers for another', () => {
  it('two valid tokens for different users each get their own claims', async () => {
    const v = verifier({ claimsCache: on });
    const a = await mint(7, 'a');
    const b = await mint(8, 'b');
    expect((await v.verifyToken(a))?.user).toMatchObject({ id: 7 });
    expect(await v.verifyToken(b)).toMatchObject({ jti: 'b', sub: '8', user: { id: 8 } });
    expect(verifyCalls()).toBe(2);
  });

  it.each([
    ['payload', 1],
    ['signature', 2],
  ] as const)(
    'a token differing from a cached one in one %s character is verified on its own, and refused',
    async (_name, segment) => {
      const v = verifier({ claimsCache: on });
      const token = await mint(7, 'a');
      expect((await v.verifyToken(token))?.jti).toBe('a');
      const other = flipChar(token, segment);
      expect(other).not.toBe(token);
      expect(other.length).toBe(token.length);

      expect(await v.verifyToken(other)).toBeNull();
      expect(verifyCalls()).toBe(2);
    }
  );
});

describe('verified claims cache — a failed verification is never cached', () => {
  it('a token with a bad signature is refused on every presentation, each one checked', async () => {
    const v = verifier({ claimsCache: on });
    const bad = flipChar(await mint(7, 'a'), 2);
    expect(await v.verifyToken(bad)).toBeNull();
    expect(await v.verifyToken(bad)).toBeNull();
    expect(verifyCalls()).toBe(2);
  });

  it('a token the audience rule rejects (signature valid) is not stored, so it is refused again', async () => {
    const audienced = createSessionSigner({
      privateKeyPem: keys.privateKey,
      publicKeyPem: keys.publicKey,
      kid: 'k1',
      issuer: ISSUER,
      audience: 'some-other-app',
      maxAge: 3600,
    });
    const token = await audienced.mintSessionToken({ sub: '7', user: { id: 7 } }, { jti: 'aud' });
    const v = verifier({ claimsCache: on });
    expect(await v.verifyToken(token)).toBeNull();
    expect(await v.verifyToken(token)).toBeNull();
    expect(verifyCalls()).toBe(2);
  });
});

describe('verified claims cache — bounded LRU', () => {
  it('holds at most maxEntries, dropping the least recently USED', async () => {
    const v = verifier({ claimsCache: { ...on, maxEntries: 2 } });
    const [a, b, c] = await Promise.all([mint(1, 'a'), mint(2, 'b'), mint(3, 'c')]);
    await v.verifyToken(a);
    await v.verifyToken(b);
    await v.verifyToken(a); // hit: a is now more recent than b
    expect(verifyCalls()).toBe(2);
    await v.verifyToken(c); // evicts b
    expect(verifyCalls()).toBe(3);
    await v.verifyToken(a); // still held
    expect(verifyCalls()).toBe(3);
    expect((await v.verifyToken(b))?.jti).toBe('b'); // was evicted: checked again
    expect(verifyCalls()).toBe(4);
  });
});

describe('verified claims cache — the switch', () => {
  it('off: every call runs the signature check, and the results equal a verifier with no cache', async () => {
    let calls = 0;
    const off = verifier({ claimsCache: { enabled: () => (calls++, false) } });
    const plain = verifier();
    const token = await mint(7, 'a');
    const r1 = await off.verifyToken(token);
    const r2 = await off.verifyToken(token);
    expect(verifyCalls()).toBe(2);
    expect(calls).toBe(2); // read on every call
    expect(r1).toEqual(await plain.verifyToken(token));
    expect(r2).toEqual(r1);
  });

  it('turning it off empties the cache, so turning it back on starts cold', async () => {
    let enabled = true;
    const v = verifier({ claimsCache: { ...on, enabled: () => enabled } });
    const token = await mint(7, 'a');
    await v.verifyToken(token);
    await v.verifyToken(token);
    expect(verifyCalls()).toBe(1);
    enabled = false;
    await v.verifyToken(token);
    expect(verifyCalls()).toBe(2);
    enabled = true;
    await v.verifyToken(token);
    expect(verifyCalls()).toBe(3);
  });

  it('a switch that throws, rejects or answers non-true reads as off', async () => {
    const token = await mint(7, 'a');
    const switches: Array<() => boolean | Promise<boolean>> = [
      () => {
        throw new Error('flag store down');
      },
      () => Promise.reject(new Error('flag store down')),
      () => 'yes' as unknown as boolean,
    ];
    for (const enabled of switches) {
      const v = verifier({ claimsCache: { enabled } });
      jose.jwtVerify.mockClear();
      expect((await v.verifyToken(token))?.jti).toBe('a');
      expect((await v.verifyToken(token))?.jti).toBe('a');
      expect(verifyCalls()).toBe(2);
    }
  });
});
