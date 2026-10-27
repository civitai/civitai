import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';
import { legacySessionCookieName } from '@civitai/auth';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as KeyGenerator from '~/server/utils/key-generator';

/**
 * The shared Civitai Moderation account is sent as server-side and never signs in: a hub token, an
 * API key or a legacy cookie that resolves to it yields no session. Each case has a control showing
 * the same credential for another user still works.
 */

const MODERATION = 900;
const SOMEONE = 5;

const h = vi.hoisted(() => ({
  getSessionUserById: vi.fn(async (id: number) => ({ id, bannedAt: null })),
  decodeLegacySessionCookie: vi.fn(),
}));

vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  createAuthVerifier: () => ({}),
  decodeLegacySessionCookie: h.decodeLegacySessionCookie,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: h.getSessionUserById },
  getHubSession: async () => null,
  maybeRollHubCookie: async () => undefined,
  maybeUpgradeLegacySession: async () => undefined,
}));
vi.mock('~/server/utils/key-generator', async (importOriginal) => ({
  ...(await importOriginal<typeof KeyGenerator>()),
  generateSecretHash: (key: string) => key,
}));

const { isRevoked } = await import('~/server/auth/session-verifier');
const { getSessionFromBearerToken } = await import('~/server/auth/bearer-token');
const { getServerAuthSession } = await import('~/server/auth/get-server-auth-session');

const refusalLogged = () =>
  expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'moderation-account-session-refused', type: 'error' }),
    'auth'
  );

beforeEach(() => {
  vi.clearAllMocks();
  setEnv({ CIVITAI_MODERATION_USER_ID: MODERATION, NEXTAUTH_SECRET: 'secret' });
});

describe('a hub session token', () => {
  it('is treated as revoked for the moderation account', async () => {
    expect(await isRevoked({ sub: String(MODERATION), jti: 't1' })).toBe(true);
    refusalLogged();
  });

  it('is unaffected for anyone else, or when the feature is off', async () => {
    expect(await isRevoked({ sub: String(SOMEONE), jti: 't1' })).toBe(false);
    setEnv({ CIVITAI_MODERATION_USER_ID: '' });
    expect(await isRevoked({ sub: String(MODERATION), jti: 't1' })).toBe(false);
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'moderation-account-session-refused' }),
      'auth'
    );
  });
});

describe('an API key', () => {
  const key = (userId: number) => ({
    id: 77,
    userId,
    tokenScope: 1,
    lastUsedAt: new Date(),
    buzzLimit: null,
    clientId: null,
    type: 'User',
  });

  it('resolves to no session for the moderation account', async () => {
    dbMock.dbWrite.apiKey.findFirst.mockResolvedValue(key(MODERATION) as never);
    expect(await getSessionFromBearerToken('k')).toBeNull();
    refusalLogged();
  });

  it('still resolves for anyone else', async () => {
    dbMock.dbWrite.apiKey.findFirst.mockResolvedValue(key(SOMEONE) as never);
    expect((await getSessionFromBearerToken('k'))?.user).toEqual(
      expect.objectContaining({ id: SOMEONE })
    );
  });
});

describe('a legacy session cookie', () => {
  const request = () => ({
    headers: { host: 'civitai.com' },
    cookies: { [legacySessionCookieName()]: 'x' },
    url: '/',
  });

  it('resolves to no session for the moderation account', async () => {
    h.decodeLegacySessionCookie.mockResolvedValue({ sub: String(MODERATION) });
    expect(await getServerAuthSession({ req: request() as never, res: {} as never })).toBeNull();
    expect(h.getSessionUserById).not.toHaveBeenCalled();
    refusalLogged();
  });

  it('still resolves for anyone else', async () => {
    h.decodeLegacySessionCookie.mockResolvedValue({ sub: String(SOMEONE) });
    expect(
      (await getServerAuthSession({ req: request() as never, res: {} as never }))?.user
    ).toEqual(expect.objectContaining({ id: SOMEONE }));
  });
});
