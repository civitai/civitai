import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as KeyGenerator from '~/server/utils/key-generator';
import { BANNED_ACCOUNT_MESSAGE } from '~/server/utils/errorHandling';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';

/**
 * The ban gate for API routes, run through the real `getServerAuthSession` and the real bearer-token
 * resolver. Only the layer below them is faked: `session-client` (the cookie session) and the API-key row.
 *
 * Two modes:
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

const {
  getHubSession,
  getSessionUserById,
  getMultipartPutUrl,
  getAllHiddenForUser,
  storage,
  createImageIngestionRequest,
  createFreshdeskToken,
} = vi.hoisted(() => ({
  getHubSession: vi.fn(),
  getSessionUserById: vi.fn(),
  getMultipartPutUrl: vi.fn(async () => ({ urls: [], uploadId: 'u' })),
  getAllHiddenForUser: vi.fn(async () => ({})),
  storage: {
    abortMultipartUpload: vi.fn(async () => ({})),
    completeMultipartUpload: vi.fn(async () => ({})),
    getUploadPartUrl: vi.fn(async () => ({ url: 'signed' })),
  },
  createImageIngestionRequest: vi.fn(async () => ({ data: {}, status: 200 })),
  createFreshdeskToken: vi.fn(async () => 'jwt'),
}));
vi.mock('~/server/auth/session-client', () => ({
  getHubSession,
  maybeRollHubCookie: vi.fn(),
  sessionClient: { getSessionUserById },
}));
vi.mock('~/utils/s3-utils', () => ({
  ...storage,
  getMultipartPutUrl,
  getUploadS3Client: vi.fn(),
  getUploadBucket: vi.fn(() => 'uploads'),
  getUploadChunkSize: vi.fn(() => 1),
  getS3Client: vi.fn(() => ({})),
  getB2ImageS3Client: vi.fn(),
  classifyS3MultipartError: vi.fn(() => 'unknown'),
  headObject: vi.fn(async () => ({ status: 'unknown' })),
  objectExists: vi.fn(async () => null),
}));
vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  createImageIngestionRequest,
}));
vi.mock('~/server/integrations/freshdesk', () => ({ createFreshdeskToken }));
vi.mock('~/server/services/user-preferences.service', () => ({ getAllHiddenForUser }));
const { MixedAuthEndpoint } = await import('~/server/utils/endpoint-helpers');
const { default: uploadRoute } = await import('~/pages/api/upload/index');
const { default: hiddenPreferencesRoute } = await import('~/pages/api/user/getHiddenPreferences');
const { default: uploadAbortRoute } = await import('~/pages/api/upload/abort');
const { default: uploadCompleteRoute } = await import('~/pages/api/upload/complete');
const { default: uploadSignPartRoute } = await import('~/pages/api/upload/sign-part');
const { default: mediaIngestRoute } = await import('~/pages/api/media/ingest/[mediaId]');
const { default: freshdeskRoute } = await import('~/pages/api/auth/freshdesk');

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
    query = {},
  }: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    url?: string;
    query?: Record<string, string>;
  } = {}
) {
  const result = { status: 200, body: undefined as unknown, redirect: undefined as unknown };
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
    redirect(location: unknown) {
      result.status = 302;
      result.redirect = location;
      return res;
    },
    setHeader: () => res,
    getHeader: () => undefined,
    end: () => res,
    once: () => res,
    on: () => res,
  };
  const req = { method, headers, query, url, cookies: {}, body };
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
    expect(result).toMatchObject({ status: 200, body: { userId: USER_ID } });
  });

  it('refuses a banned cookie session with 403 and never runs the handler', async () => {
    getHubSession.mockResolvedValue({ user: bannedUser });
    const result = await call(route, { headers: { cookie: 'x' } });
    expect(result).toMatchObject({ status: 403, body: { error: BANNED_ACCOUNT_MESSAGE } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('serves an active API key as that user', async () => {
    getSessionUserById.mockResolvedValue(activeUser);
    const result = await call(route, { headers: { authorization: 'Bearer k' } });
    expect(result).toMatchObject({ status: 200, body: { userId: USER_ID } });
  });

  it('serves a banned API key as anonymous, not 403: the gate leaves the key path alone', async () => {
    getSessionUserById.mockResolvedValue(bannedUser);
    const result = await call(route, { headers: { authorization: 'Bearer k' } });
    expect(result).toMatchObject({ status: 200, body: { userId: null } });
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
    expect(result).toMatchObject({ status: 403, body: { error: BANNED_ACCOUNT_MESSAGE } });
    expect(getMultipartPutUrl).not.toHaveBeenCalled();
  });
});

describe('the other routes that act as the user refuse a banned cookie session', () => {
  const key = `default/${USER_ID}/a.safetensors`;
  const uploadBody = { bucket: 'uploads', key, uploadId: 'u', partNumber: 1, parts: [] };
  const cases = [
    ['upload/abort', uploadAbortRoute, storage.abortMultipartUpload],
    ['upload/complete', uploadCompleteRoute, storage.completeMultipartUpload],
    ['upload/sign-part', uploadSignPartRoute, storage.getUploadPartUrl],
  ] as const;

  it.each(cases)('%s reaches storage for an active session', async (_name, route, store) => {
    getHubSession.mockResolvedValue({ user: activeUser });
    await call(route, { method: 'POST', body: uploadBody });
    expect(store).toHaveBeenCalled();
  });

  it.each(cases)('%s answers 403 and never reaches storage', async (_name, route, store) => {
    getHubSession.mockResolvedValue({ user: bannedUser });
    const result = await call(route, { method: 'POST', body: uploadBody });
    expect(result).toMatchObject({ status: 403, body: { error: BANNED_ACCOUNT_MESSAGE } });
    expect(store).not.toHaveBeenCalled();
  });

  describe('media/ingest', () => {
    const query = { mediaId: '1' };
    beforeEach(() => {
      dbMock.dbRead.image.findUnique.mockResolvedValue({ id: 1, url: 'u', type: 'image' } as never);
    });

    it('starts an ingestion for an active moderator', async () => {
      getHubSession.mockResolvedValue({ user: { ...activeUser, isModerator: true } });
      await call(mediaIngestRoute, { query });
      expect(createImageIngestionRequest).toHaveBeenCalled();
    });

    it('answers 403 for a banned moderator and never starts an ingestion', async () => {
      getHubSession.mockResolvedValue({ user: { ...bannedUser, isModerator: true } });
      const result = await call(mediaIngestRoute, { query });
      expect(result).toMatchObject({ status: 403, body: { error: BANNED_ACCOUNT_MESSAGE } });
      expect(createImageIngestionRequest).not.toHaveBeenCalled();
    });
  });
});

// Keep allowBanned on auth/freshdesk: a banned account must still reach the support portal, which
// is where it appeals. Removing it turns this test red, as it should.
describe('support portal sign-in keeps the banned session', () => {
  it('signs a banned cookie session into the support portal', async () => {
    setEnv({ FRESHDESK_JWT_SECRET: 'secret', FRESHDESK_JWT_URL: 'https://support.test/login' });
    getHubSession.mockResolvedValue({ user: { ...bannedUser, email: 'b@test.dev' } });
    const result = await call(freshdeskRoute, { query: { nonce: 'n', state: 's' } });
    expect(createFreshdeskToken).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER_ID }),
      'n'
    );
    expect(result).toMatchObject({ status: 302 });
    expect(String(result.redirect)).toMatch(/^https:\/\/support\.test\/login\?id_token=jwt/);
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
