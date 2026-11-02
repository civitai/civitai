import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSessionSigner } from '../sign';
import { createAuthVerifier, type AuthVerifierConfig } from '../verify';
import { createSessionClient } from '../session-client';
import { createVerifiedClaimsCache } from '../verified-claims-cache';
import { SignJWT, importPKCS8 } from 'jose';
import { generateKeyPairSync } from 'crypto';
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
  vi.unstubAllGlobals();
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
    const isRevoked = vi.fn(async (_claims: SessionClaims) => revoked);
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
    const isRevoked = vi.fn(async (_claims: SessionClaims) => revoked);
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

describe('verified claims cache — the key set is re-checked on every hit', () => {
  // A second, unrelated key pair: the key set the hub would publish after removing k1.
  const other = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const otherSigner = createSessionSigner({
    privateKeyPem: other.privateKey,
    publicKeyPem: other.publicKey,
    kid: 'k2',
    issuer: ISSUER,
    maxAge: 3600,
  });
  // Spoke-style verifiers: keys come from a remote JWKS (the env's local key is overridden with '').
  const jwksCfg = { publicKeyPem: '', jwksUri: 'https://auth.test/jwks' };
  // jose's remote set reloads on the first lookup after cacheMaxAge (600 000 ms by default).
  const PAST_JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1000 + 1000;

  async function serveJwks(initial: { keys: Record<string, unknown>[] }) {
    const state = { served: initial };
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(state.served), {
          headers: { 'content-type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetch);
    return { state, fetch };
  }

  it('a kid removed from the key set refuses the cached token at the next reload, as the uncached path does', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const { state, fetch } = await serveJwks(await signer.publicJwks());
    const cached = verifier({ ...jwksCfg, claimsCache: on });
    const uncached = verifier(jwksCfg);
    const token = await mint(7, 'a');

    expect((await cached.verifyToken(token))?.jti).toBe('a');
    expect((await uncached.verifyToken(token))?.jti).toBe('a');
    expect((await cached.verifyToken(token))?.jti).toBe('a'); // a hit
    expect(verifyCalls()).toBe(2);

    state.served = await otherSigner.publicJwks(); // k1 is gone
    vi.setSystemTime(Date.now() + PAST_JWKS_CACHE_MAX_AGE_MS);
    expect(await uncached.verifyToken(token)).toBeNull();
    expect(await cached.verifyToken(token)).toBeNull();
    // One initial fetch and one reload per verifier: the hit path fetched no more than the uncached one.
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('a reload that keeps the key re-verifies the cached token in full, and keeps it signed in', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const { fetch } = await serveJwks(await signer.publicJwks());
    const v = verifier({ ...jwksCfg, claimsCache: on });
    const token = await mint(7, 'a');
    await v.verifyToken(token);
    await v.verifyToken(token);
    expect(verifyCalls()).toBe(1);

    vi.setSystemTime(Date.now() + PAST_JWKS_CACHE_MAX_AGE_MS);
    expect((await v.verifyToken(token))?.jti).toBe('a');
    expect(verifyCalls()).toBe(2); // a new key object after the reload: not served from the cache
    expect((await v.verifyToken(token))?.jti).toBe('a');
    expect(verifyCalls()).toBe(2); // cached again against the reloaded key
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a key-set reload that times out on a hit answers null with ONE fetch and ONE timeout sample', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const { fetch } = await serveJwks(await signer.publicJwks());
    const onJwksLeg = vi.fn<(outcome: 'hit' | 'timeout', seconds: number) => void>();
    const v = verifier({ ...jwksCfg, claimsCache: on, onJwksLeg });
    const token = await mint(7, 'a');
    expect((await v.verifyToken(token))?.jti).toBe('a'); // cached (one fetch, one `hit` sample)

    // The next lookup reloads; make that reload time out the way AbortSignal.timeout does.
    vi.setSystemTime(Date.now() + PAST_JWKS_CACHE_MAX_AGE_MS);
    fetch.mockImplementation(async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    });
    fetch.mockClear();
    onJwksLeg.mockClear();

    expect(await v.verifyToken(token)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1); // not re-verified, which would fetch again
    expect(onJwksLeg.mock.calls.filter(([outcome]) => outcome === 'timeout')).toHaveLength(1);
    expect(onJwksLeg).toHaveBeenCalledTimes(1);
  });
});

describe('verified claims cache — a token without a usable exp is never stored', () => {
  it('through the verifier: a validly signed token with no exp is checked on every presentation', async () => {
    const privateKey = await importPKCS8(keys.privateKey, 'ES256');
    const token = await new SignJWT({ sub: '7', user: { id: 7 } })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setJti('no-exp')
      .sign(privateKey);
    const v = verifier({ claimsCache: on });
    expect((await v.verifyToken(token))?.jti).toBe('no-exp');
    expect((await v.verifyToken(token))?.jti).toBe('no-exp');
    expect(verifyCalls()).toBe(2);
  });

  it('directly: a missing or NaN exp is refused, a future exp is kept (control)', () => {
    const c = createVerifiedClaimsCache({ clock: () => 1_000, ttlMs: 60_000 });
    const entry = (exp: number | undefined) => ({
      payload: exp === undefined ? { sub: '7' } : { sub: '7', exp },
      protectedHeader: { alg: 'ES256' },
      signingKey: {},
    });
    c.set('missing', entry(undefined));
    c.set('nan', entry(NaN));
    c.set('future', entry(30)); // 30 s = 30 000 ms > the clock's 1 000 ms
    expect(c.get('missing')).toBeUndefined();
    expect(c.get('nan')).toBeUndefined();
    expect(c.get('future')?.payload.exp).toBe(30);
  });
});
