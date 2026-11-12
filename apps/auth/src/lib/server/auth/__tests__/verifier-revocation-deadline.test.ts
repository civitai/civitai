import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionClaims } from '@civitai/auth';

// The hub's revocation read fails open, and is bounded by a deadline: a hung session store must neither
// log everyone out nor hold every hub request for as long as the store stays hung.

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
  return { kp, isRevoked: (async () => false) as (claims: unknown) => Promise<boolean> };
});

vi.mock('$lib/server/auth/registry', () => ({
  sessions: { isRevoked: (claims: unknown) => h.isRevoked(claims) },
}));

import { createSessionSigner } from '@civitai/auth';
import {
  createHubRevocationCheck,
  DEFAULT_REVOCATION_READ_TIMEOUT_MS,
  revocationReadTimeoutMs,
  verifier,
} from '../verifier';

const never = () => new Promise<boolean>(() => undefined);
const claims = { sub: '7', jti: 'jti-7', user: { id: 7 } } as unknown as SessionClaims;

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
  h.isRevoked = async () => false;
});

describe('hub verifier revocation deadline', () => {
  it('a hung revocation read fails open within the deadline: the session is accepted', async () => {
    process.env.REDIS_SYS_READ_TIMEOUT_MS = '40';
    h.isRevoked = never;
    const started = Date.now();
    await expect(verifier.verifyToken(token)).resolves.toMatchObject({ jti: 'jti-7' });
    expect(Date.now() - started).toBeLessThan(1000);
  }, 10_000);

  it('a revoked session is still refused when the read answers (positive control)', async () => {
    process.env.REDIS_SYS_READ_TIMEOUT_MS = '1000';
    h.isRevoked = async () => true;
    await expect(verifier.verifyToken(token)).resolves.toBeNull();
  });
});

describe('createHubRevocationCheck', () => {
  it('releases a hung read at the deadline, answers not-revoked and reports a timeout', async () => {
    const onFailOpen = vi.fn();
    const check = createHubRevocationCheck(never, () => 30, onFailOpen);
    const started = Date.now();
    await expect(check(claims)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(onFailOpen).toHaveBeenCalledWith('timeout');
  });

  it('a read error fails open and reports an error', async () => {
    const onFailOpen = vi.fn();
    const check = createHubRevocationCheck(
      () => Promise.reject(new Error('ECONNRESET')),
      () => 1000,
      onFailOpen
    );
    await expect(check(claims)).resolves.toBe(false);
    expect(onFailOpen).toHaveBeenCalledWith('error');
  });

  it('passes a revoked answer through and reports nothing', async () => {
    const onFailOpen = vi.fn();
    const check = createHubRevocationCheck(
      async () => true,
      () => 1000,
      onFailOpen
    );
    await expect(check(claims)).resolves.toBe(true);
    expect(onFailOpen).not.toHaveBeenCalled();
  });

  it('a deadline of 0 turns the bound off: a slow read still answers', async () => {
    const slow = () => new Promise<boolean>((r) => setTimeout(() => r(true), 40));
    const check = createHubRevocationCheck(slow, () => 0, vi.fn());
    await expect(check(claims)).resolves.toBe(true);
  });

  it('does not emit an unhandledRejection when the abandoned read rejects after the deadline', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      const late = () =>
        new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error('late')), 40));
      const check = createHubRevocationCheck(late, () => 10, vi.fn());
      await expect(check(claims)).resolves.toBe(false);
      await new Promise((r) => setTimeout(r, 70));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('revocationReadTimeoutMs', () => {
  it('reads REDIS_SYS_READ_TIMEOUT_MS, falling back to the default when unset or not a number', () => {
    expect(revocationReadTimeoutMs()).toBe(DEFAULT_REVOCATION_READ_TIMEOUT_MS);
    process.env.REDIS_SYS_READ_TIMEOUT_MS = '250';
    expect(revocationReadTimeoutMs()).toBe(250);
    process.env.REDIS_SYS_READ_TIMEOUT_MS = '0';
    expect(revocationReadTimeoutMs()).toBe(0);
    process.env.REDIS_SYS_READ_TIMEOUT_MS = 'soon';
    expect(revocationReadTimeoutMs()).toBe(DEFAULT_REVOCATION_READ_TIMEOUT_MS);
    process.env.REDIS_SYS_READ_TIMEOUT_MS = '';
    expect(revocationReadTimeoutMs()).toBe(DEFAULT_REVOCATION_READ_TIMEOUT_MS);
  });
});
