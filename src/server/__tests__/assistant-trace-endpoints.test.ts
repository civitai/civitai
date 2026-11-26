import type * as CivitaiAuth from '@civitai/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as ClickhouseModule from '~/server/clickhouse/client';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

/**
 * The moderator trace API, `/api/mod/apps/assistant-trace/*`, through the REAL front door
 * (`defineModeratorEndpoint`) and the REAL bearer-key path: a caller presents an API key, the key
 * row is read through the canonical db mock, and the user it names comes from the auth hub, which is
 * the one thing stubbed here (`@civitai/auth`'s session client: a network boundary). The trace reads
 * themselves run for real over the canonical db mock.
 *
 * Pinned: every route refuses an unknown key, a non-moderator and a banned moderator BEFORE it reads
 * any trace (a transcript is the user's own chat), and refuses a POST; a moderator's key is answered.
 */

// TEST-ONLY salt for API-key hashing, set before the auth package first reads its env.
vi.hoisted(() => vi.stubEnv('NEXTAUTH_SECRET', 'test-only-salt-for-key-hashing'));

const h = vi.hoisted(() => ({
  user: null as null | Record<string, unknown>,
  audit: vi.fn(),
}));

vi.mock('@civitai/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof CivitaiAuth>();
  return {
    ...actual,
    // The auth hub: the user an API key's row names.
    createSessionClient: () =>
      new Proxy(
        { getSessionUserById: async () => h.user },
        {
          get: (target, key) =>
            key in target ? target[key as 'getSessionUserById'] : vi.fn(async () => null),
        }
      ),
  };
});
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseModule>()),
  Tracker: class {
    retoolAudit = h.audit;
  },
}));

const routes = {
  request: (await import('~/server/api-routes/mod/apps/assistant-trace/request')).default,
  app: (await import('~/server/api-routes/mod/apps/assistant-trace/app')).default,
  transcript: (await import('~/server/api-routes/mod/apps/assistant-trace/transcript')).default,
  signals: (await import('~/server/api-routes/mod/apps/assistant-trace/signals')).default,
};
type Route = keyof typeof routes;

const VALID: Record<Route, Record<string, string>> = {
  request: { publishRequestId: 'pubreq_a' },
  app: { slug: 'some-app' },
  transcript: { publishRequestId: 'pubreq_a', conversationId: 'conv-a' },
  signals: {},
};

const KEY = 'test-only-moderator-key';

function call(
  route: Route,
  query: Record<string, string>,
  method = 'GET',
  key: string | null = KEY
) {
  const req = {
    method,
    query,
    headers: key ? { authorization: `Bearer ${key}` } : {},
    body: {},
    cookies: {},
  };
  let statusCode = 200;
  let payload: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: unknown) {
      payload = data;
      return res;
    },
    setHeader: vi.fn(),
    getHeader: vi.fn(),
    end: () => res,
  };
  return Promise.resolve(routes[route](req as never, res as never)).then(() => ({
    status: statusCode,
    body: payload as Record<string, unknown>,
  }));
}

const MOD = { id: 4207, isModerator: true, bannedAt: null, permissions: [] };

/** Every trace read the routes can make. */
const traceReads = () =>
  [
    dbMock.dbRead.appBlockPublishRequest.findUnique,
    dbMock.dbRead.appBlockPublishRequest.findMany,
    dbMock.dbRead.appPublishRequestTrace.findUnique,
    dbMock.dbRead.appAssistantSessionLink.findMany,
    dbMock.dbRead.$queryRaw,
  ].reduce((n, fn) => n + fn.mock.calls.length, 0);

beforeEach(() => {
  vi.clearAllMocks();
  h.user = { ...MOD };
  // The API key's row: a full-access personal key, used recently (no last-used write).
  dbMock.dbWrite.apiKey.findFirst.mockResolvedValue({
    id: 31,
    userId: MOD.id,
    tokenScope: Number(TokenScope.Full),
    tokenScopeWide: null,
    lastUsedAt: new Date(),
    buzzLimit: null,
    clientId: null,
    type: ApiKeyType.User,
    expiresAt: null,
  });
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('/api/mod/apps/assistant-trace/* — moderators only', () => {
  const ROUTES = Object.keys(routes) as Route[];

  it.each(ROUTES)('%s refuses an unknown API key (401), reading no trace', async (route) => {
    dbMock.dbWrite.apiKey.findFirst.mockResolvedValue(null);
    expect((await call(route, VALID[route])).status).toBe(401);
    expect(traceReads()).toBe(0);
  });

  it.each(
    ROUTES.flatMap((route) => [
      [route, 'a non-moderator', { isModerator: false, bannedAt: null }] as const,
      [route, 'a banned moderator', { isModerator: true, bannedAt: new Date() }] as const,
    ])
  )('%s refuses %s, reading no trace', async (route, _label, user) => {
    h.user = { id: MOD.id, permissions: [], ...user };
    const { status } = await call(route, VALID[route]);
    // A banned user's key resolves to no session (401); a non-moderator's is refused the role (403).
    expect(user.bannedAt ? 401 : 403).toBe(status);
    expect(traceReads()).toBe(0);
  });

  it.each(ROUTES)('%s refuses a POST: reads only', async (route) => {
    expect((await call(route, VALID[route], 'POST')).status).toBe(405);
    expect(traceReads()).toBe(0);
  });

  it('CONTROL: the same key, held by a moderator, is answered', async () => {
    dbMock.dbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_a',
      slug: 'some-app',
      version: '0.1.0',
      status: 'pending',
      submittedAt: new Date('2026-11-21T00:00:00.000Z'),
      submittedByUserId: 5150,
    });
    const { status, body } = await call('request', VALID.request);
    expect(status).toBe(200);
    expect(body).toMatchObject({ request: { id: 'pubreq_a' }, trace: null, links: [] });
    // Links are read for the SUBMITTER only.
    expect(dbMock.dbRead.appAssistantSessionLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { appSlug: 'some-app', userId: 5150 } })
    );
  });
});

describe('/api/mod/apps/assistant-trace/* — answers', () => {
  it('request: 404 when there is no such request', async () => {
    dbMock.dbRead.appBlockPublishRequest.findUnique.mockResolvedValue(null);
    expect((await call('request', VALID.request)).status).toBe(404);
  });

  it('app: bounds its page size', async () => {
    expect((await call('app', { slug: 'some-app', limit: '500' })).status).toBe(400);
    expect((await call('app', { slug: 'some-app', limit: '7' })).status).toBe(200);
    expect(dbMock.dbRead.appBlockPublishRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'some-app' }, take: 8 })
    );
  });

  it('transcript: no trace is 404; a frozen chat the store cannot give back is 503', async () => {
    dbMock.dbRead.appPublishRequestTrace.findUnique.mockResolvedValueOnce(null);
    expect((await call('transcript', VALID.transcript)).status).toBe(404);
    dbMock.dbRead.appPublishRequestTrace.findUnique.mockResolvedValueOnce({
      snapshots: [{ conversationId: 'conv-other', key: 'k' }],
    });
    expect((await call('transcript', VALID.transcript)).status).toBe(404);
    dbMock.dbRead.appPublishRequestTrace.findUnique.mockResolvedValueOnce({
      snapshots: [{ conversationId: 'conv-a', error: 'not-found' }],
    });
    expect((await call('transcript', VALID.transcript)).status).toBe(404);
    // The bundle store is not configured here: the read fails, and that is a retryable 503.
    dbMock.dbRead.appPublishRequestTrace.findUnique.mockResolvedValueOnce({
      snapshots: [{ conversationId: 'conv-a', key: 'app-assistant-transcripts/x/y.json' }],
    });
    expect((await call('transcript', VALID.transcript)).status).toBe(503);
  });

  it('signals: the window is bounded', async () => {
    expect(
      (await call('signals', { from: '2025-01-01T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z' }))
        .status
    ).toBe(400);
    expect(
      (await call('signals', { from: '2026-11-22T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z' }))
        .status
    ).toBe(400);
    const ok = await call('signals', { to: '2026-11-21T00:00:00.000Z' });
    expect(ok).toMatchObject({
      status: 200,
      body: { from: '2026-08-23T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z', weeks: [] },
    });
  });

  it('a transcript read is audited, naming the request and the chat', async () => {
    dbMock.dbRead.appPublishRequestTrace.findUnique.mockResolvedValueOnce(null);
    await call('transcript', VALID.transcript);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'apps.assistantTrace.transcript',
        payload: expect.objectContaining({
          publishRequestId: 'pubreq_a',
          conversationId: 'conv-a',
        }),
      })
    );
  });
});
