import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as KeyGenerator from '~/server/utils/key-generator';
import { BANNED_ACCOUNT_MESSAGE } from '~/server/utils/errorHandling';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * The ban gate for API routes, run through the real `getServerAuthSession` and the real bearer-token
 * resolver. Only the layer below them is faked: `session-client` (the cookie session) and the API-key row.
 *
 * Two modes, both decided by the Moderation Lead:
 *  - routes that act as the user (AuthedEndpoint, MixedAuthEndpoint, uploads) answer a banned cookie
 *    session with 403;
 *  - public routes that only personalize their answer treat it as no session at all ("a ban means you
 *    have no session"), exactly as a banned API key already resolves.
 */

vi.mock('@civitai/next-axiom', () => ({
  withAxiom:
    (handler: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      handler(...args),
}));
vi.mock('~/server/db/db-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkNotUpToDate: vi.fn(async () => false),
}));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/utils/key-generator', async (importOriginal) => ({
  ...(await importOriginal<typeof KeyGenerator>()),
  generateSecretHash: (key: string) => key,
}));

const { getHubSession, getSessionUserById, getMultipartPutUrl, getAllHiddenForUser } = vi.hoisted(
  () => ({
    getHubSession: vi.fn(),
    getSessionUserById: vi.fn(),
    getMultipartPutUrl: vi.fn(async () => ({ urls: [], uploadId: 'u' })),
    getAllHiddenForUser: vi.fn(async () => ({})),
  })
);
vi.mock('~/server/auth/session-client', () => ({
  getHubSession,
  maybeRollHubCookie: vi.fn(),
  maybeUpgradeLegacySession: vi.fn(),
  sessionClient: { getSessionUserById },
}));
vi.mock('~/utils/s3-utils', () => ({
  getMultipartPutUrl,
  getUploadS3Client: vi.fn(),
  getUploadBucket: vi.fn(),
  getUploadChunkSize: vi.fn(() => 1),
}));
vi.mock('~/server/services/user-preferences.service', () => ({ getAllHiddenForUser }));
const { MixedAuthEndpoint } = await import('~/server/utils/endpoint-helpers');
const { default: uploadRoute } = await import('~/pages/api/upload/index');
const { default: hiddenPreferencesRoute } = await import('~/pages/api/user/getHiddenPreferences');

const USER_ID = 5;
const bannedUser = { id: USER_ID, username: 'banned', bannedAt: new Date() };
const activeUser = { id: USER_ID, username: 'active', bannedAt: undefined };

function call(
  handler: (req: never, res: never) => unknown,
  {
    method = 'GET',
    headers = {},
    body = {},
    url = '/api/test',
  }: { method?: string; headers?: Record<string, string>; body?: unknown; url?: string } = {}
) {
  const result = { status: 200, body: undefined as unknown };
  const res = {
    status(code: number) {
      result.status = code;
      return res;
    },
    json(payload: unknown) {
      result.body = payload;
      return res;
    },
    send(payload: unknown) {
      result.body = payload;
      return res;
    },
    setHeader: () => res,
    getHeader: () => undefined,
    end: () => res,
    once: () => res,
    on: () => res,
  };
  const req = { method, headers, query: {}, url, cookies: {}, body };
  return Promise.resolve(handler(req as never, res as never)).then(() => result);
}

beforeEach(() => {
  vi.clearAllMocks();
  getHubSession.mockResolvedValue(null);
  dbMock.dbWrite.apiKey.findFirst.mockResolvedValue({
    id: 77,
    userId: USER_ID,
    tokenScope: 1,
    lastUsedAt: new Date(),
    buzzLimit: null,
    clientId: null,
    type: 'User',
  } as never);
});

describe('MixedAuthEndpoint', () => {
  const handler = vi.fn(async (_req: unknown, res: { status: (n: number) => unknown }, user) => {
    (res.status(200) as { json: (b: unknown) => unknown }).json({ userId: user?.id ?? null });
  });
  const route = MixedAuthEndpoint(handler as never);

  it('serves an active cookie session as that user', async () => {
    getHubSession.mockResolvedValue({ user: activeUser });
    const result = await call(route, { headers: { cookie: 'x' } });
    expect(result).toEqual({ status: 200, body: { userId: USER_ID } });
  });

  it('refuses a banned cookie session with 403 and never runs the handler', async () => {
    getHubSession.mockResolvedValue({ user: bannedUser });
    const result = await call(route, { headers: { cookie: 'x' } });
    expect(result).toEqual({ status: 403, body: { error: BANNED_ACCOUNT_MESSAGE } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('serves a banned API key as anonymous, not 403: the gate leaves the key path alone', async () => {
    getSessionUserById.mockResolvedValue(bannedUser);
    const result = await call(route, { headers: { authorization: 'Bearer k' } });
    expect(result).toEqual({ status: 200, body: { userId: null } });
  });
});

describe('a route that acts as the user (upload)', () => {
  const body = { filename: 'a.safetensors', type: 'default', size: 1 };

  it('starts an upload for an active cookie session', async () => {
    getHubSession.mockResolvedValue({ user: activeUser });
    await call(uploadRoute, { method: 'POST', body });
    expect(getMultipartPutUrl).toHaveBeenCalled();
  });

  it('refuses a banned cookie session with 403 before touching storage', async () => {
    getHubSession.mockResolvedValue({ user: bannedUser });
    const result = await call(uploadRoute, { method: 'POST', body });
    expect(result).toEqual({ status: 403, body: { error: BANNED_ACCOUNT_MESSAGE } });
    expect(getMultipartPutUrl).not.toHaveBeenCalled();
  });
});

describe('a public route that only personalizes (hidden preferences)', () => {
  it('personalizes for an active cookie session', async () => {
    getHubSession.mockResolvedValue({ user: activeUser });
    await call(hiddenPreferencesRoute);
    expect(getAllHiddenForUser).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID }));
  });

  it('answers a banned cookie session as anonymous, not with that user’s data', async () => {
    getHubSession.mockResolvedValue({ user: bannedUser });
    const result = await call(hiddenPreferencesRoute);
    expect(result.status).toBe(200);
    expect(getAllHiddenForUser).toHaveBeenCalledWith(expect.objectContaining({ userId: -1 }));
  });
});
