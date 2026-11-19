import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Until the session store has been ready once, the hub waits for it inside the revocation read deadline rather
// than allowing every session unread; once it has been ready, an outage allows at once. A session allowed
// without a read is marked so that nothing lasting is minted from it.

const h = await vi.hoisted(async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const kp = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  process.env.AUTH_JWT_PUBLIC_KEY = kp.publicKey;
  process.env.AUTH_JWT_ISSUER = 'https://auth.test';
  // A sys client that rejects commands until ready, like the real one, and holds a revocation for jti-7.
  const client = {
    isReady: false,
    revokedJti: 'jti-7',
    async hGet(_key: string, field: string) {
      if (!client.isReady) throw new Error('The client is closed');
      return field === client.revokedJti ? 'invalid' : null;
    },
    async get() {
      if (!client.isReady) throw new Error('The client is closed');
      return null;
    },
  };
  return { kp, client };
});

vi.mock('$lib/server/redis', () => ({ getSysRedis: () => h.client, getRedis: () => null }));
vi.mock('$lib/server/metrics', () => ({
  hubRevocationFailOpenTotal: { inc: () => undefined },
  hubRevocationDeniedCachedTotal: { inc: () => undefined },
}));

import { createSessionSigner } from '@civitai/auth';

let revoked: string;
let live: string;
beforeAll(async () => {
  const signer = createSessionSigner({
    privateKeyPem: h.kp.privateKey,
    publicKeyPem: h.kp.publicKey,
    kid: 'k1',
    issuer: 'https://auth.test',
    maxAge: 3600,
  });
  revoked = await signer.mintSessionToken({ sub: '7', signedAt: Date.now() }, { jti: 'jti-7' });
  live = await signer.mintSessionToken({ sub: '8', signedAt: Date.now() }, { jti: 'jti-8' });
});

// The "has been ready" state lives in the verifier module, so each test loads a fresh one.
async function load() {
  vi.resetModules();
  const { verifier } = await import('../verifier');
  const { isUnconfirmedSession } = await import('../unconfirmed-session');
  return { verifier, isUnconfirmedSession };
}

beforeEach(() => {
  h.client.isReady = false;
  process.env.REDIS_SYS_READ_TIMEOUT_MS = '1000';
});
afterEach(() => {
  delete process.env.REDIS_SYS_READ_TIMEOUT_MS;
});

describe('hub verifier at cold start', () => {
  it('reads the revocation once the store is ready within the deadline', async () => {
    const { verifier } = await load();
    setTimeout(() => (h.client.isReady = true), 50);
    expect(await verifier.verifyToken(revoked)).toBeNull();
  });

  it('allows an unrevoked session read once the store is ready, unmarked', async () => {
    const { verifier, isUnconfirmedSession } = await load();
    setTimeout(() => (h.client.isReady = true), 50);
    const claims = await verifier.verifyToken(live);
    expect(claims?.sub).toBe('8');
    expect(isUnconfirmedSession(claims!)).toBe(false);
  });

  it('spends one deadline on the wait and the read, then allows the session marked', async () => {
    process.env.REDIS_SYS_READ_TIMEOUT_MS = '80';
    const { verifier, isUnconfirmedSession } = await load();
    const started = Date.now();
    const claims = await verifier.verifyToken(revoked);
    const took = Date.now() - started;
    expect(claims?.sub).toBe('7');
    expect(isUnconfirmedSession(claims!)).toBe(true);
    expect(took).toBeGreaterThanOrEqual(70);
    expect(took).toBeLessThan(150);
  });
});

describe('hub verifier starting during a store outage', () => {
  it('waits one read deadline in all, then allows at once until the store is up', async () => {
    process.env.REDIS_SYS_READ_TIMEOUT_MS = '80';
    const { verifier, isUnconfirmedSession } = await load();
    const first = Date.now();
    await verifier.verifyToken(live);
    expect(Date.now() - first).toBeGreaterThanOrEqual(70);
    const second = Date.now();
    const claims = await verifier.verifyToken(live);
    expect(Date.now() - second).toBeLessThan(30);
    expect(claims?.sub).toBe('8');
    expect(isUnconfirmedSession(claims!)).toBe(true);
  });
});

describe('hub verifier after the store has been ready', () => {
  it('does not wait during a later outage, and marks the session it allows', async () => {
    const { verifier, isUnconfirmedSession } = await load();
    h.client.isReady = true;
    expect(await verifier.verifyToken(live)).not.toBeNull();
    h.client.isReady = false;
    setTimeout(() => (h.client.isReady = true), 50);
    const started = Date.now();
    const claims = await verifier.verifyToken(revoked);
    expect(Date.now() - started).toBeLessThan(40);
    expect(claims?.sub).toBe('7');
    expect(isUnconfirmedSession(claims!)).toBe(true);
  });
});
