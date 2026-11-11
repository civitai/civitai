import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as KeyGenerator from '~/server/utils/key-generator';
import type * as PrincipalCache from '~/server/auth/api-key-principal-cache';

// The orchestrator service token is not an API key: it resolves to no session, as any unknown key
// does, without the API-key cache read or the primary lookup.

const h = vi.hoisted(() => ({ readCachedApiKey: vi.fn() }));

vi.mock('~/server/utils/key-generator', async (importOriginal) => ({
  ...(await importOriginal<typeof KeyGenerator>()),
  generateSecretHash: (key: string) => key,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: vi.fn(async (id: number) => ({ id, bannedAt: null })) },
}));
vi.mock('~/server/auth/api-key-principal-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof PrincipalCache>()),
  readCachedApiKey: h.readCachedApiKey,
}));

const { getSessionFromBearerToken } = await import('~/server/auth/bearer-token');

const SERVICE_TOKEN = 'test-service-token-0123456789abcdef';
const USER_KEY = '0123456789abcdef0123456789abcdef';

beforeEach(() => {
  setEnv({ ORCHESTRATOR_SERVICE_TOKEN: SERVICE_TOKEN });
  h.readCachedApiKey.mockReset().mockResolvedValue({ apiKey: null, fill: false });
  dbMock.dbWrite.apiKey.findFirst.mockReset().mockResolvedValue({
    id: 77,
    userId: 5,
    tokenScope: 1,
    lastUsedAt: new Date(),
    buzzLimit: null,
    clientId: null,
    type: 'User',
  });
});

describe('the orchestrator service token as a bearer credential', () => {
  it('resolves no session and is never looked up', async () => {
    expect(await getSessionFromBearerToken(SERVICE_TOKEN)).toBeNull();
    expect(h.readCachedApiKey).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.apiKey.findFirst).not.toHaveBeenCalled();
  });

  it('skips the lookup for the token with surrounding whitespace, as the lookup trims it', async () => {
    expect(await getSessionFromBearerToken(` ${SERVICE_TOKEN} `)).toBeNull();
    expect(dbMock.dbWrite.apiKey.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ['one character off', `${SERVICE_TOKEN.slice(0, -1)}x`],
    ['with an extra character', `${SERVICE_TOKEN}x`],
    ['a user API key', USER_KEY],
  ])('control: %s still takes the lookup', async (_label, key) => {
    await getSessionFromBearerToken(key);
    expect(h.readCachedApiKey).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.apiKey.findFirst).toHaveBeenCalledTimes(1);
  });

  it('control: a user API key still resolves to its session', async () => {
    expect(await getSessionFromBearerToken(USER_KEY)).toMatchObject({ user: { id: 5 } });
  });

  it.each([
    ['unset', undefined, SERVICE_TOKEN],
    ['empty, against an empty key', '', ''],
    ['whitespace, against the same whitespace', ' \t', ' \t'],
  ])('is inert when the configured token is %s', async (_label, configured, key) => {
    setEnv({ ORCHESTRATOR_SERVICE_TOKEN: configured });
    await getSessionFromBearerToken(key);
    expect(dbMock.dbWrite.apiKey.findFirst).toHaveBeenCalledTimes(1);
  });
});
