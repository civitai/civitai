import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';

// `verifiedTokenCache` passed to createSessionClient must reach its internal verifier: two reads of the
// same valid token do ONE real ES256 verify. jose's exports are frozen, so jwtVerify is wrapped to count.
// Only the env and the shared redis cache are stubbed; the verifier and signer are real.
const h = vi.hoisted(() => ({
  jwtVerifyCalls: 0,
  env: {} as Record<string, unknown>,
}));
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    jwtVerify: (...args: Parameters<typeof actual.jwtVerify>) => {
      h.jwtVerifyCalls++;
      return actual.jwtVerify(...args);
    },
  };
});
vi.mock('../env', () => ({ loadAuthEnv: () => h.env }));
vi.mock('../redis', () => ({
  getCacheRedis: () => ({
    packed: { get: async () => ({ id: 42, username: 'cached' }), set: async () => {} },
  }),
  sessionCacheKey: (id: number) => `session:data2:${id}`,
}));

import { createSessionSigner } from '../sign';
import { createSessionClient } from '../session-client';

const issuer = 'https://auth.test';
let token: string;

beforeAll(async () => {
  const kp = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  h.env = { AUTH_JWT_ISSUER: issuer, AUTH_JWT_PUBLIC_KEY: kp.publicKey, AUTH_REQUIRE_IAT0: false };
  // Session tokens carry no `aud` (the verifier rejects one when no audience is configured).
  const signer = createSessionSigner({
    privateKeyPem: kp.privateKey,
    publicKeyPem: kp.publicKey,
    kid: 'sc-cache-1',
    issuer,
    maxAge: 3600,
  });
  token = await signer.mintSessionToken({ sub: '42', user: { id: 42 } }, { jti: 'jti-sc' });
});

beforeEach(() => {
  h.jwtVerifyCalls = 0;
});

describe('createSessionClient — verifiedTokenCache', () => {
  it('verifies a repeated token once when the option is set', async () => {
    const client = createSessionClient({
      verifiedTokenCache: { maxEntries: 100, maxTtlMs: 60_000 },
    });
    const first = await client.getSessionUser(token);
    const second = await client.getSessionUser(token);
    expect(first?.id).toBe(42);
    expect(second?.id).toBe(42);
    expect(h.jwtVerifyCalls).toBe(1);
  });

  it('verifies on every read without the option', async () => {
    const client = createSessionClient();
    expect((await client.getSessionUser(token))?.id).toBe(42);
    expect((await client.getSessionUser(token))?.id).toBe(42);
    expect(h.jwtVerifyCalls).toBe(2);
  });
});
