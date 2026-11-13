import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The hub runs the shared revocation check (@civitai/auth createRevocationCheck): it fails open, and is bounded
// by REDIS_SYS_READ_TIMEOUT_MS, so a hung session store neither logs everyone out nor holds every hub request.

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
  // The session store the registry reads: `hGet`/`get`, swapped per test.
  const store = {
    hGet: (async () => null) as (key: string, field: string) => Promise<string | null>,
    get: (async () => null) as (key: string) => Promise<string | null>,
  };
  return { kp, store, failOpen: [] as string[], degraded: [] as string[] };
});

vi.mock('$lib/server/redis', () => ({
  getSysRedis: () => ({
    hGet: (k: string, f: string) => h.store.hGet(k, f),
    get: (k: string) => h.store.get(k),
  }),
  getRedis: () => null,
}));
vi.mock('$lib/server/metrics', () => ({
  hubRevocationFailOpenTotal: { inc: ({ reason }: { reason: string }) => h.failOpen.push(reason) },
  hubRevocationDegradedTotal: {
    inc: ({ verdict }: { verdict: string }) => h.degraded.push(verdict),
  },
}));

import { createSessionSigner, SESSION_REGISTRY_KEYS } from '@civitai/auth';
import { verifier } from '../verifier';

const never = () => new Promise<string | null>(() => undefined);

let token: string;
beforeAll(async () => {
  const signer = createSessionSigner({
    privateKeyPem: h.kp.privateKey,
    publicKeyPem: h.kp.publicKey,
    kid: 'k1',
    issuer: 'https://auth.test',
    maxAge: 3600,
  });
  token = await signer.mintSessionToken(
    { user: { id: 7 }, signedAt: Date.now() },
    { jti: 'jti-7' }
  );
});

afterEach(() => {
  delete process.env.REDIS_SYS_READ_TIMEOUT_MS;
  h.store.hGet = async () => null;
  h.store.get = async () => null;
  h.failOpen.length = 0;
  h.degraded.length = 0;
});

describe('hub verifier revocation check', () => {
  it('a hung revocation read fails open within REDIS_SYS_READ_TIMEOUT_MS and counts a timeout', async () => {
    process.env.REDIS_SYS_READ_TIMEOUT_MS = '40';
    h.store.hGet = never;
    h.store.get = never;
    const started = Date.now();
    await expect(verifier.verifyToken(token)).resolves.toMatchObject({ jti: 'jti-7' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(h.failOpen).toEqual(['timeout']);
    expect(h.degraded).toEqual(['allow_unknown']);
  }, 10_000);

  it('a store error fails open and counts an error', async () => {
    h.store.hGet = async () => {
      throw new Error('ECONNRESET');
    };
    await expect(verifier.verifyToken(token)).resolves.toMatchObject({ jti: 'jti-7' });
    expect(h.failOpen).toEqual(['error']);
  });

  it('a revoked session is still refused when the store answers (positive control)', async () => {
    h.store.hGet = async (key, field) =>
      key === SESSION_REGISTRY_KEYS.tokenState && field === 'jti-7' ? 'invalid' : null;
    await expect(verifier.verifyToken(token)).resolves.toBeNull();
    expect(h.failOpen).toEqual([]);
  });

  it('a session the hub has read as revoked stays refused when the store then fails', async () => {
    h.store.hGet = async (key, field) =>
      key === SESSION_REGISTRY_KEYS.tokenState && field === 'jti-7' ? 'invalid' : null;
    await expect(verifier.verifyToken(token)).resolves.toBeNull();

    h.store.hGet = async () => {
      throw new Error('ECONNRESET');
    };
    await expect(verifier.verifyToken(token)).resolves.toBeNull();
    expect(h.degraded).toEqual(['deny_cached']);
    // Refused, so not a fail-open.
    expect(h.failOpen).toEqual([]);

    // The store answers again and no longer has the marker: the record follows it.
    h.store.hGet = async () => null;
    await expect(verifier.verifyToken(token)).resolves.toMatchObject({ jti: 'jti-7' });
  });
});
