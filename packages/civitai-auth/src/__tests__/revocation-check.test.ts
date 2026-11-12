import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { createSessionSigner, type SessionSigner } from '../sign';
import { createAuthVerifier } from '../verify';
import {
  createRevocationCheck,
  DEFAULT_REVOCATION_READ_TIMEOUT_MS,
  revocationReadTimeoutMs,
} from '../revocation-check';
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

describe('createRevocationCheck deadline and reporting', () => {
  const claims = { jti: 'j1', sub: '7', user: { id: 7 } } as never;
  const hang = { hGet: () => new Promise(() => {}), get: () => new Promise(() => {}) };
  const hung = () => hang as unknown as SessionRegistryRedis;
  afterEach(() => {
    delete process.env.REDIS_SYS_READ_TIMEOUT_MS;
  });

  it('defaults to 1000ms from REDIS_SYS_READ_TIMEOUT_MS, read per call, falling back when unset or invalid', () => {
    expect(DEFAULT_REVOCATION_READ_TIMEOUT_MS).toBe(1000);
    expect(revocationReadTimeoutMs()).toBe(1000);
    process.env.REDIS_SYS_READ_TIMEOUT_MS = '250';
    expect(revocationReadTimeoutMs()).toBe(250);
    process.env.REDIS_SYS_READ_TIMEOUT_MS = '0';
    expect(revocationReadTimeoutMs()).toBe(0);
    process.env.REDIS_SYS_READ_TIMEOUT_MS = 'soon';
    expect(revocationReadTimeoutMs()).toBe(1000);
    process.env.REDIS_SYS_READ_TIMEOUT_MS = ' ';
    expect(revocationReadTimeoutMs()).toBe(1000);
  });

  it('with no timeoutMs, a hung read is released at REDIS_SYS_READ_TIMEOUT_MS and reported as a timeout', async () => {
    process.env.REDIS_SYS_READ_TIMEOUT_MS = '30';
    const onError = vi.fn();
    const onOutcome = vi.fn();
    const check = createRevocationCheck({ redis: hung, onError, onOutcome });
    const started = Date.now();
    expect(await check(claims)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'timeout', claims);
    expect(onOutcome).toHaveBeenCalledWith('timeout', expect.any(Number));
  });

  it('reads a timeoutMs getter on every check', async () => {
    let ms = 5000;
    const check = createRevocationCheck({ redis: hung, timeoutMs: () => ms });
    ms = 25;
    const started = Date.now();
    expect(await check(claims)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('a store error is reported as an error; an answered read as a hit', async () => {
    const onError = vi.fn();
    const onOutcome = vi.fn();
    const failing = createRevocationCheck({
      redis: () =>
        ({
          hGet: () => Promise.reject(new Error('down')),
          get: () => Promise.resolve(null),
        } as never),
      onError,
      onOutcome,
    });
    expect(await failing(claims)).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'error', claims);
    expect(onOutcome).toHaveBeenLastCalledWith('error', expect.any(Number));

    const healthy = createRevocationCheck({ redis: () => store(), onError, onOutcome });
    expect(await healthy(claims)).toBe(false);
    expect(onOutcome).toHaveBeenLastCalledWith('hit', expect.any(Number));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a bound hook replaces the built-in race; its timeout-tagged rejection is a timeout', async () => {
    const onError = vi.fn();
    const bound = vi.fn((_read: Promise<boolean>, _ms: number) =>
      Promise.reject(Object.assign(new Error('skipped'), { reason: 'timeout' }))
    );
    const check = createRevocationCheck({ redis: hung, timeoutMs: 1234, bound, onError });
    expect(await check(claims)).toBe(false);
    expect(bound).toHaveBeenCalledWith(expect.any(Promise), 1234);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'timeout', claims);
  });

  it('a throwing observer never turns a fail-open into a throw', async () => {
    const check = createRevocationCheck({
      redis: hung,
      timeoutMs: 10,
      onError: () => {
        throw new Error('observer');
      },
      onOutcome: () => {
        throw new Error('observer');
      },
    });
    expect(await check(claims)).toBe(false);
  });
});
