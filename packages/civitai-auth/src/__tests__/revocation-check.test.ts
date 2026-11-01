import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { createSessionSigner, type SessionSigner } from '../sign';
import { createAuthVerifier } from '../verify';
import { createRevocationCheck } from '../revocation-check';
import { SESSION_REGISTRY_KEYS } from '../session-registry-keys';
import type { SessionRegistryRedis } from '../session-registry';

const issuer = 'https://auth.test';
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
    publicKeyPem,
    kid: 'k1',
    issuer,
    maxAge: 3600,
  });
});

function store(hashes: Record<string, Record<string, string>> = {}) {
  return {
    hGet: async (key: string, field: string) => hashes[key]?.[field] ?? null,
    get: async () => null,
  } as unknown as SessionRegistryRedis;
}

const verifierWith = (redis: SessionRegistryRedis) =>
  createAuthVerifier({
    issuer,
    publicKeyPem,
    isRevoked: createRevocationCheck({ redis: () => redis }),
  });

describe('createRevocationCheck', () => {
  it('ends a token whose family was signed out, though its own jti was never marked', async () => {
    const token = await signer.mintSessionToken(
      { user: { id: 7 }, signedAt: Date.now(), sid: 'root' },
      { jti: 'child' }
    );
    const redis = store({ [SESSION_REGISTRY_KEYS.familyState]: { root: 'invalid' } });
    expect(await verifierWith(redis).verifyToken(token)).toBeNull();
  });

  it('keeps a token whose family is live', async () => {
    const token = await signer.mintSessionToken(
      { user: { id: 7 }, signedAt: Date.now(), sid: 'root' },
      { jti: 'child' }
    );
    expect(await verifierWith(store()).verifyToken(token)).toMatchObject({ jti: 'child' });
  });

  it('ends a token marked invalid by jti', async () => {
    const token = await signer.mintSessionToken(
      { user: { id: 7 }, signedAt: Date.now() },
      { jti: 'j1' }
    );
    const redis = store({ [SESSION_REGISTRY_KEYS.tokenState]: { j1: 'invalid' } });
    expect(await verifierWith(redis).verifyToken(token)).toBeNull();
  });

  it('fails open when the store errors', async () => {
    const errors: unknown[] = [];
    const check = createRevocationCheck({
      redis: () => {
        throw new Error('down');
      },
      onError: (e) => errors.push(e),
    });
    expect(await check({ jti: 'j1', sub: '7' } as never)).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it('fails open when the store hangs past the deadline', async () => {
    const hang = { hGet: () => new Promise(() => {}), get: () => new Promise(() => {}) };
    const check = createRevocationCheck({
      redis: () => hang as unknown as SessionRegistryRedis,
      timeoutMs: 20,
    });
    expect(await check({ jti: 'j1', sub: '7' } as never)).toBe(false);
  });
});
