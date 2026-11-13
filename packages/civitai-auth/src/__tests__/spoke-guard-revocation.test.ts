import { describe, it, expect, vi } from 'vitest';
import { createSessionSigner } from '../sign';
import { createSpokeGuard } from '../spoke-guard';
import { createRevocationCheck } from '../revocation-check';
import { SESSION_REGISTRY_KEYS } from '../session-registry-keys';
import type { SessionRegistryRedis } from '../session-registry';

// The guard over the REAL session client and verifier: only the key pair, the env and the shared cache are fakes,
// so a revocation check that never reaches the verifier shows up here.
const ISSUER = 'https://auth.test';
const keys = await vi.hoisted(async () => {
  const { generateKeyPairSync } = await import('crypto');
  return generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
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
  getCacheRedis: () => ({ packed: { get: async () => ({ id: 7, username: 'seven' }) } }),
}));
import type * as Env from '../env';
import type * as Redis from '../redis';

const signer = createSessionSigner({
  privateKeyPem: keys.privateKey,
  publicKeyPem: keys.publicKey,
  kid: 'k1',
  issuer: ISSUER,
  maxAge: 3600,
});

const store = (hashes: Record<string, Record<string, string>> = {}) =>
  ({
    hGet: async (key: string, field: string) => hashes[key]?.[field] ?? null,
    get: async () => null,
  } as unknown as SessionRegistryRedis);

async function checkWith(redis: SessionRegistryRedis) {
  const token = await signer.mintSessionToken(
    { sub: '7', user: { id: 7 }, signedAt: Date.now(), sid: 'root' },
    { jti: 'child' }
  );
  const guard = createSpokeGuard({ isRevoked: createRevocationCheck({ redis: () => redis }) });
  return guard.check(`civ-token=${token}`, 'http://localhost:3100/x');
}

describe('createSpokeGuard with the real session client', () => {
  it('signs in a live token', async () => {
    expect(await checkWith(store())).toMatchObject({ status: 'ok', user: { id: 7 } });
  });

  it('sends a token whose family was signed out to login', async () => {
    const redis = store({ [SESSION_REGISTRY_KEYS.familyState]: { root: 'invalid' } });
    expect((await checkWith(redis)).status).toBe('login');
  });
});
