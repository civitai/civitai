import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { SESSION_LINEAGE_MAX_AGE_MS } from '../family';
import { createSessionSigner, type SessionSigner } from '../sign';
import type { SessionClaims } from '../types';
import { createAuthVerifier, createVerifiedTokenCache } from '../verify';

// `verifiedTokenCache` skips the ES256 verify for a token already verified within its TTL. jose's
// exports are frozen, so the real jwtVerify is wrapped to count calls (and fail one on demand).
const jose = vi.hoisted(() => ({ calls: 0, failNext: false }));
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    jwtVerify: (...args: Parameters<typeof actual.jwtVerify>) => {
      jose.calls++;
      if (jose.failNext) {
        jose.failNext = false;
        return Promise.reject(new Error('transient verify failure'));
      }
      return actual.jwtVerify(...args);
    },
  };
});

const issuer = 'https://auth.test';
const audience = 'spokes';
let signer: SessionSigner;
let publicKeyPem: string;

beforeAll(() => {
  const kp = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  publicKeyPem = kp.publicKey;
  signer = createSessionSigner({
    privateKeyPem: kp.privateKey,
    publicKeyPem: kp.publicKey,
    kid: 'cache-1',
    issuer,
    audience,
    maxAge: 3600,
  });
});

afterEach(() => {
  vi.useRealTimers();
  jose.calls = 0;
  jose.failNext = false;
});

const mint = (userId: number, jti: string, opts: { expiresIn?: number; iat0?: number } = {}) =>
  signer.mintSessionToken(
    { sub: String(userId), user: { id: userId }, ...(opts.iat0 ? { iat0: opts.iat0 } : {}) },
    { jti, expiresIn: opts.expiresIn }
  );

const verifier = (extra: Parameters<typeof createAuthVerifier>[0] = {}) =>
  createAuthVerifier({
    issuer,
    audience,
    publicKeyPem,
    verifiedTokenCache: { maxEntries: 100, maxTtlMs: 60_000 },
    ...extra,
  });

describe('verifiedTokenCache', () => {
  it('verifies a repeated token once, and every call without the option', async () => {
    const token = await mint(101, 'jti-a');
    const cached = verifier();
    expect((await cached.verifyToken(token))?.jti).toBe('jti-a');
    expect((await cached.verifyToken(token))?.jti).toBe('jti-a');
    expect(jose.calls).toBe(1);

    jose.calls = 0;
    const uncached = createAuthVerifier({ issuer, audience, publicKeyPem });
    await uncached.verifyToken(token);
    await uncached.verifyToken(token);
    expect(jose.calls).toBe(2);
  });

  it('never answers one token with another token’s claims', async () => {
    const a = await mint(101, 'jti-a');
    const b = await mint(202, 'jti-b');
    const v = verifier();
    const seen: string[] = [];
    for (const token of [a, b, a, b, a]) {
      const claims = await v.verifyToken(token);
      seen.push(`${claims?.sub}/${claims?.jti}`);
    }
    expect(seen).toEqual(['101/jti-a', '202/jti-b', '101/jti-a', '202/jti-b', '101/jti-a']);
    expect(jose.calls).toBe(2);
  });

  it('checks revocation on every call, cached or not', async () => {
    const a = await mint(101, 'jti-a');
    const b = await mint(202, 'jti-b');
    const revoked = new Set<string>();
    const isRevoked = vi.fn((claims: SessionClaims) => revoked.has(claims.jti ?? ''));
    const v = verifier({ isRevoked });

    expect((await v.verifyToken(a))?.jti).toBe('jti-a');
    revoked.add('jti-a');
    expect(await v.verifyToken(a)).toBeNull();
    expect((await v.verifyToken(b))?.jti).toBe('jti-b');
    revoked.delete('jti-a');
    expect((await v.verifyToken(a))?.jti).toBe('jti-a');

    expect(isRevoked).toHaveBeenCalledTimes(4);
    expect(jose.calls).toBe(2);
  });

  it('applies the lineage limit on a cached token', async () => {
    const now = Date.now();
    let clock = now;
    const token = await mint(303, 'jti-c', { iat0: now });
    const v = verifier({ clock: () => clock });
    expect((await v.verifyToken(token))?.jti).toBe('jti-c');
    clock = now + SESSION_LINEAGE_MAX_AGE_MS + 1;
    expect(await v.verifyToken(token)).toBeNull();
    expect(jose.calls).toBe(1);
  });

  it('re-verifies once maxTtlMs has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-01T00:00:00Z') });
    const token = await mint(404, 'jti-d', { expiresIn: 3600 });
    const v = verifier();
    await v.verifyToken(token);
    vi.setSystemTime(Date.now() + 59_000);
    expect((await v.verifyToken(token))?.jti).toBe('jti-d');
    expect(jose.calls).toBe(1);
    vi.setSystemTime(Date.now() + 2_000);
    expect((await v.verifyToken(token))?.jti).toBe('jti-d');
    expect(jose.calls).toBe(2);
  });

  it('never serves a token past its own exp, however long maxTtlMs is', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-01T00:00:00Z') });
    const token = await mint(505, 'jti-e', { expiresIn: 30 });
    const v = verifier({ verifiedTokenCache: { maxEntries: 100, maxTtlMs: 3_600_000 } });
    expect((await v.verifyToken(token))?.jti).toBe('jti-e');
    vi.setSystemTime(Date.now() + 29_000);
    expect((await v.verifyToken(token))?.jti).toBe('jti-e');
    expect(jose.calls).toBe(1);
    vi.setSystemTime(Date.now() + 2_000);
    expect(await v.verifyToken(token)).toBeNull();
    expect(jose.calls).toBe(2);
  });

  it('does not cache a failed verification', async () => {
    const token = await mint(606, 'jti-f');
    const v = verifier();
    jose.failNext = true;
    expect(await v.verifyToken(token)).toBeNull();
    expect((await v.verifyToken(token))?.jti).toBe('jti-f');
    expect(jose.calls).toBe(2);

    const expired = await mint(707, 'jti-g', { expiresIn: -10 });
    expect(await v.verifyToken(expired)).toBeNull();
    expect(await v.verifyToken(expired)).toBeNull();
    expect(jose.calls).toBe(4);
  });

  it('hands every caller its own copy of the claims', async () => {
    const token = await mint(808, 'jti-h');
    const v = verifier();
    const first = await v.verifyToken(token);
    (first!.user as { id: number }).id = 999;
    first!.sub = 'tampered';
    const second = await v.verifyToken(token);
    expect(second?.sub).toBe('808');
    expect(second?.user).toEqual({ id: 808 });
  });

  it('evicts beyond maxEntries, so an evicted token is verified again', async () => {
    const tokens = await Promise.all([1, 2, 3, 4].map((n) => mint(910 + n, `jti-${n}`)));
    const v = verifier({ verifiedTokenCache: { maxEntries: 3, maxTtlMs: 60_000 } });
    for (const t of tokens) await v.verifyToken(t);
    expect(jose.calls).toBe(4);
    expect((await v.verifyToken(tokens[3]))?.jti).toBe('jti-4');
    expect(jose.calls).toBe(4);
    expect((await v.verifyToken(tokens[0]))?.jti).toBe('jti-1');
    expect(jose.calls).toBe(5);
  });
});

describe('createVerifiedTokenCache', () => {
  it('keeps at most maxEntries, evicting the least recently used', () => {
    const cache = createVerifiedTokenCache({ maxEntries: 3, maxTtlMs: 60_000 });
    cache.set('k1', { jti: 'p1' });
    cache.set('k2', { jti: 'p2' });
    cache.set('k3', { jti: 'p3' });
    expect(cache.get('k1')?.jti).toBe('p1');
    cache.set('k4', { jti: 'p4' });
    cache.set('k5', { jti: 'p5' });
    expect(cache.size).toBe(3);
    expect(cache.get('k2')).toBeUndefined();
    expect(cache.get('k3')).toBeUndefined();
    expect(['k1', 'k4', 'k5'].map((k) => cache.get(k)?.jti)).toEqual(['p1', 'p4', 'p5']);
  });

  it('expires at the sooner of maxTtlMs and exp, and stores nothing already expired', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-01T00:00:00Z') });
    const nowSec = Math.floor(Date.now() / 1000);
    const cache = createVerifiedTokenCache({ maxEntries: 10, maxTtlMs: 45_000 });
    cache.set('long', { jti: 'long', exp: nowSec + 3600 });
    cache.set('short', { jti: 'short', exp: nowSec + 7 });
    cache.set('none', { jti: 'none' });
    cache.set('gone', { jti: 'gone', exp: nowSec - 1 });
    expect(cache.size).toBe(3);

    vi.setSystemTime(Date.now() + 6_500);
    expect(cache.get('short')?.jti).toBe('short');
    vi.setSystemTime(Date.now() + 1_000);
    expect(cache.get('short')).toBeUndefined();

    vi.setSystemTime(Date.now() + 37_000);
    expect(cache.get('long')?.jti).toBe('long');
    expect(cache.get('none')?.jti).toBe('none');
    vi.setSystemTime(Date.now() + 1_000);
    expect(cache.get('long')).toBeUndefined();
    expect(cache.get('none')).toBeUndefined();
  });
});
