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
  return { kp, store, degraded: [] as string[], sysRedis: true };
});

vi.mock('../../clients/redis', () => ({
  getSysRedis: () =>
    h.sysRedis
      ? {
          hGet: (k: string, f: string) => h.store.hGet(k, f),
          get: (k: string) => h.store.get(k),
        }
      : null,
}));
vi.mock('../../metrics', () => ({
  revocationDegradedTotal: { inc: ({ verdict }: { verdict: string }) => h.degraded.push(verdict) },
}));

import { createSessionSigner, SESSION_REGISTRY_KEYS } from '@civitai/auth';
import { verifier } from '../verifier';

const mint = (jti: string, extra: Record<string, unknown> = {}) =>
  createSessionSigner({
    privateKeyPem: h.kp.privateKey,
    publicKeyPem: h.kp.publicKey,
    kid: 'k1',
    issuer: 'https://auth.test',
    maxAge: 3600,
  }).mintSessionToken({ user: { id: 7 }, signedAt: Date.now(), ...extra }, { jti });

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
  h.sysRedis = true;
});

// A session token with no jti, signed with the same key: the registry answers it without a read.
const mintWithoutJti = async (extra: Record<string, unknown>) => {
  const { SignJWT, importPKCS8 } = await import('jose');
  return new SignJWT({ user: { id: 7 }, signedAt: Date.now(), ...extra })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .setIssuer('https://auth.test')
    .sign(await importPKCS8(h.kp.privateKey, 'ES256'));
};

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

  it('an impersonation session is refused when the revocation read fails', async () => {
    const impersonation = await mint('jti-imp', { impersonatedBy: 99, impExp: Date.now() + 600_000 });
    const plain = await mint('jti-plain');

    // The store answers: both are allowed.
    await expect(verifier.verifyToken(impersonation)).resolves.toMatchObject({ jti: 'jti-imp', impersonatedBy: 99 });
    await expect(verifier.verifyToken(plain)).resolves.toMatchObject({ jti: 'jti-plain' });

    h.store.hGet = async () => {
      throw new Error('ECONNRESET');
    };
    h.store.get = async () => {
      throw new Error('ECONNRESET');
    };
    // The read fails: the elevated session is refused, the ordinary one keeps the fail-open policy.
    await expect(verifier.verifyToken(impersonation)).resolves.toBeNull();
    await expect(verifier.verifyToken(plain)).resolves.toMatchObject({ jti: 'jti-plain' });
  });

  it('an impersonation session without a jti is refused (nothing confirms it)', async () => {
    const impersonation = await mintWithoutJti({ impersonatedBy: 99, impExp: Date.now() + 600_000 });
    const plain = await mintWithoutJti({});
    await expect(verifier.verifyToken(impersonation)).resolves.toBeNull();
    // Control: the same jti-less shape without impersonation is accepted.
    await expect(verifier.verifyToken(plain)).resolves.toMatchObject({ user: { id: 7 } });
  });

  it('with no sys redis configured, an impersonation session is refused and a plain one accepted', async () => {
    const impersonation = await mint('jti-imp-noredis', { impersonatedBy: 99, impExp: Date.now() + 600_000 });
    const plain = await mint('jti-plain-noredis');
    h.sysRedis = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(verifier.verifyToken(impersonation)).resolves.toBeNull();
    await expect(verifier.verifyToken(plain)).resolves.toMatchObject({ jti: 'jti-plain-noredis' });
    // Refused by the no-redis rule itself, not by a failed read: no revocation read was attempted at all,
    // so no degraded verdict was recorded, and the one-time warning names the cause.
    expect(h.degraded).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      '[orchestrator-gateway] no sys redis configured: impersonation sessions are refused'
    );
    warn.mockRestore();
  });
});
