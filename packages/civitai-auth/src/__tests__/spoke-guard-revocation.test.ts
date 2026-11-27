import { beforeEach, describe, it, expect, vi } from 'vitest';
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
const cache = vi.hoisted(() => ({ user: {} as Record<string, unknown> }));
vi.mock('../redis', async (importOriginal) => ({
  ...(await importOriginal<typeof Redis>()),
  getCacheRedis: () => ({ packed: { get: async () => cache.user } }),
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

const mint = (claims: Record<string, unknown> = {}) =>
  signer.mintSessionToken(
    { sub: '7', user: { id: 7 }, signedAt: Date.now(), sid: 'root', ...claims },
    { jti: 'child' }
  );

async function checkWith(redis: SessionRegistryRedis) {
  const token = await mint();
  const guard = createSpokeGuard({ isRevoked: createRevocationCheck({ redis: () => redis }) });
  return guard.check(`civ-token=${token}`, 'http://localhost:3100/x');
}

beforeEach(() => {
  cache.user = { id: 7, username: 'seven' };
});

describe('createSpokeGuard with the real session client', () => {
  it('signs in a live token', async () => {
    expect(await checkWith(store())).toMatchObject({ status: 'ok', user: { id: 7 } });
  });

  it('sends a token whose family was signed out to login', async () => {
    const redis = store({ [SESSION_REGISTRY_KEYS.familyState]: { root: 'invalid' } });
    expect((await checkWith(redis)).status).toBe('login');
  });
});

// A store whose reads fail as `fail` says for the first `failing` rounds of the registry read, then answer.
// A round is one registry read; every hGet/get inside it fails alike.
function flakyStore(fail: 'hang' | 'error', failing: number) {
  let calls = 0;
  const failNow = () => calls <= failing;
  const answer = <T>(value: T): Promise<T> => {
    if (!failNow()) return Promise.resolve(value);
    return fail === 'hang'
      ? new Promise<T>(() => {})
      : Promise.reject(new Error('connection reset'));
  };
  const redis = {
    hGet: async (key: string) => {
      if (key === SESSION_REGISTRY_KEYS.tokenState) calls++;
      return answer(null);
    },
    get: async () => answer(null),
  } as unknown as SessionRegistryRedis;
  return { redis, rounds: () => calls };
}

// civitai/civitai#10695: when the revocation read fails, a moderator or impersonation request is
// refused (the session is kept), an ordinary one is allowed; one retry after a fast error, none after a timeout.
describe('a failed revocation read on an elevated session', () => {
  const guardOver = (redis: SessionRegistryRedis) =>
    createSpokeGuard({
      isRevoked: createRevocationCheck({
        redis: () => redis,
        timeoutMs: 20,
        retryDelayMs: () => 0,
      }),
    });
  const check = async (guard: ReturnType<typeof createSpokeGuard>, claims = {}) =>
    guard.check(`civ-token=${await mint(claims)}`, 'http://localhost:3100/x');

  it('refuses a moderator request whose read timed out, without a retry', async () => {
    cache.user = { id: 7, username: 'seven', isModerator: true };
    const store = flakyStore('hang', Infinity);
    expect(await check(guardOver(store.redis))).toEqual({ status: 'unavailable' });
    expect(store.rounds()).toBe(1);
  });

  it('allows an ordinary request whose read timed out', async () => {
    const store = flakyStore('hang', Infinity);
    expect(await check(guardOver(store.redis))).toMatchObject({ status: 'ok', user: { id: 7 } });
  });

  it('refuses an impersonation request whose read timed out', async () => {
    const store = flakyStore('hang', Infinity);
    const claims = { impersonatedBy: 99, impExp: Date.now() + 60_000 };
    expect(await check(guardOver(store.redis), claims)).toEqual({ status: 'unavailable' });
  });

  it('retries a fast error once and allows the moderator when the retry answers', async () => {
    cache.user = { id: 7, username: 'seven', isModerator: true };
    const store = flakyStore('error', 1);
    expect(await check(guardOver(store.redis))).toMatchObject({ status: 'ok' });
    expect(store.rounds()).toBe(2);
  });

  it('refuses the moderator when the retry fails too', async () => {
    cache.user = { id: 7, username: 'seven', isModerator: true };
    const store = flakyStore('error', Infinity);
    expect(await check(guardOver(store.redis))).toEqual({ status: 'unavailable' });
    expect(store.rounds()).toBe(2);
  });

  it('allows an ordinary request after two fast errors', async () => {
    const store = flakyStore('error', Infinity);
    expect(await check(guardOver(store.redis))).toMatchObject({ status: 'ok', user: { id: 7 } });
    expect(store.rounds()).toBe(2);
  });

  it('answers the same session normally once the store recovers', async () => {
    cache.user = { id: 7, username: 'seven', isModerator: true };
    const store = flakyStore('hang', 1);
    const guard = guardOver(store.redis);
    expect(await check(guard)).toEqual({ status: 'unavailable' });
    expect(await check(guard)).toMatchObject({ status: 'ok', user: { id: 7 } });
  });
});

// civitai/civitai#10695: a token without a jti is never revocation-read, so an elevated one is never confirmed.
describe('a session token without a jti', () => {
  const jtiLess = async (claims: Record<string, unknown> = {}) => {
    const { SignJWT, importPKCS8 } = await import('jose');
    return new SignJWT({ sub: '7', signedAt: Date.now(), ...claims })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .setIssuer(ISSUER)
      .sign(await importPKCS8(keys.privateKey, 'ES256'));
  };
  const guard = () =>
    createSpokeGuard({ isRevoked: createRevocationCheck({ redis: () => store() }) });

  it('is refused for a moderator, though the store answers', async () => {
    cache.user = { id: 7, username: 'seven', isModerator: true };
    const r = await guard().check(`civ-token=${await jtiLess()}`, 'http://localhost:3100/x');
    expect(r).toEqual({ status: 'unavailable' });
  });

  it('is allowed for an ordinary user', async () => {
    const r = await guard().check(`civ-token=${await jtiLess()}`, 'http://localhost:3100/x');
    expect(r).toMatchObject({ status: 'ok', user: { id: 7 } });
  });
});
