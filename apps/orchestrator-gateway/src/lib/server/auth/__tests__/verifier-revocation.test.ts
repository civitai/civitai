import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The gateway runs the shared revocation check (@civitai/auth createRevocationCheck), so a revocation it has
// read still refuses the session when a later read fails, and a session with none known is allowed.

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
  const store = {
    hGet: (async () => null) as (key: string, field: string) => Promise<string | null>,
    get: (async () => null) as (key: string) => Promise<string | null>,
  };
  return { kp, store, degraded: [] as string[] };
});

vi.mock('../../clients/redis', () => ({
  getSysRedis: () => ({
    hGet: (k: string, f: string) => h.store.hGet(k, f),
    get: (k: string) => h.store.get(k),
  }),
}));
vi.mock('../../metrics', () => ({
  revocationDegradedTotal: { inc: ({ verdict }: { verdict: string }) => h.degraded.push(verdict) },
}));

import { createSessionSigner, SESSION_REGISTRY_KEYS } from '@civitai/auth';
import { verifier } from '../verifier';

const mint = (jti: string) =>
  createSessionSigner({
    privateKeyPem: h.kp.privateKey,
    publicKeyPem: h.kp.publicKey,
    kid: 'k1',
    issuer: 'https://auth.test',
    maxAge: 3600,
  }).mintSessionToken({ user: { id: 7 }, signedAt: Date.now() }, { jti });

let revoked: string;
let other: string;
beforeAll(async () => {
  revoked = await mint('jti-revoked');
  other = await mint('jti-other');
});

afterEach(() => {
  h.store.hGet = async () => null;
  h.store.get = async () => null;
  h.degraded.length = 0;
});

describe('gateway verifier revocation check', () => {
  it('a session it has read as revoked stays refused when the store then fails', async () => {
    h.store.hGet = async (key, field) =>
      key === SESSION_REGISTRY_KEYS.tokenState && field === 'jti-revoked' ? 'invalid' : null;
    await expect(verifier.verifyToken(revoked)).resolves.toBeNull();

    h.store.hGet = async () => {
      throw new Error('ECONNRESET');
    };
    await expect(verifier.verifyToken(revoked)).resolves.toBeNull();
    // A session never seen revoked is still allowed (the fail-open policy).
    await expect(verifier.verifyToken(other)).resolves.toMatchObject({ jti: 'jti-other' });
    expect(h.degraded).toEqual(['deny_cached', 'allow_unknown']);

    // The store answers again without the marker: the record follows it.
    h.store.hGet = async () => null;
    await expect(verifier.verifyToken(revoked)).resolves.toMatchObject({ jti: 'jti-revoked' });
  });
});
