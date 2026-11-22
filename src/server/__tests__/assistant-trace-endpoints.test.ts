import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as ClickhouseModule from '~/server/clickhouse/client';

/**
 * The moderator trace API, `/api/mod/apps/assistant-trace/*`, through the real
 * `defineModeratorEndpoint` front door: every route refuses anyone who is not a signed-in,
 * unbanned moderator BEFORE reading anything (a transcript is the user's own chat), and each one
 * answers from the trace service it names. The service reads are spies.
 */

const { session, mockAudit, svc } = vi.hoisted(() => ({
  session: { current: null as null | { user: Record<string, unknown> } },
  mockAudit: vi.fn(),
  svc: {
    getRequestTrace: vi.fn(),
    getAppTraces: vi.fn(),
    readSnapshotTranscript: vi.fn(),
    aggregateSignals: vi.fn(),
  },
}));

vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: vi.fn(async () => null),
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => session.current),
}));
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseModule>()),
  Tracker: class {
    retoolAudit = mockAudit;
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/app-assistant/submission-trace.service', () => svc);

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

function call(route: Route, query: Record<string, string>, method = 'GET', headers = {}) {
  const req = { method, query, headers, body: {} };
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
    end: () => res,
  };
  return Promise.resolve(routes[route](req as never, res as never)).then(() => ({
    status: statusCode,
    body: payload as Record<string, unknown>,
  }));
}

const MOD = 990000412;
const serviceCalls = () => Object.values(svc).reduce((n, fn) => n + fn.mock.calls.length, 0);

beforeEach(() => {
  vi.clearAllMocks();
  session.current = { user: { id: MOD, isModerator: true, bannedAt: null, permissions: [] } };
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('/api/mod/apps/assistant-trace/* — moderators only', () => {
  const ROUTES = Object.keys(routes) as Route[];

  it.each(ROUTES)('%s refuses a signed-out caller, reading nothing', async (route) => {
    session.current = null;
    expect((await call(route, VALID[route])).status).toBe(401);
    expect(serviceCalls()).toBe(0);
  });

  it.each(
    ROUTES.flatMap((route) => [
      [route, 'a signed-in non-moderator', { isModerator: false, bannedAt: null }] as const,
      [route, 'a banned moderator', { isModerator: true, bannedAt: new Date() }] as const,
    ])
  )('%s refuses %s, reading nothing', async (route, _label, user) => {
    session.current = { user: { id: 5, permissions: [], ...user } };
    const { status, body } = await call(route, VALID[route]);
    expect(status).toBe(403);
    expect(body.error).toBe('Moderator role required');
    expect(serviceCalls()).toBe(0);
  });

  it.each(ROUTES)('%s refuses a POST: reads only', async (route) => {
    expect((await call(route, VALID[route], 'POST')).status).toBe(405);
    expect(serviceCalls()).toBe(0);
  });

  it.each(ROUTES)(
    '%s refuses an API key that is not a full-access moderator key',
    async (route) => {
      // The bearer resolves to no session: the key is refused before the role is even read.
      expect(
        (await call(route, VALID[route], 'GET', { authorization: 'Bearer not-a-key' })).status
      ).toBe(401);
      expect(serviceCalls()).toBe(0);
    }
  );
});

describe('/api/mod/apps/assistant-trace/* — answers', () => {
  it('request: the trace the service found; 404 when there is no such request', async () => {
    svc.getRequestTrace.mockResolvedValueOnce({
      request: { id: 'pubreq_a' },
      trace: null,
      links: [],
    });
    expect(await call('request', VALID.request)).toEqual({
      status: 200,
      body: { request: { id: 'pubreq_a' }, trace: null, links: [] },
    });
    expect(svc.getRequestTrace).toHaveBeenCalledWith('pubreq_a');
    svc.getRequestTrace.mockResolvedValueOnce(null);
    expect((await call('request', VALID.request)).status).toBe(404);
  });

  it('app: pages with limit and cursor', async () => {
    svc.getAppTraces.mockResolvedValueOnce({ requests: [], nextCursor: null, links: [] });
    await call('app', { slug: 'some-app', limit: '7', cursor: 'pubreq_z' });
    expect(svc.getAppTraces).toHaveBeenCalledWith('some-app', { limit: 7, cursor: 'pubreq_z' });
    expect((await call('app', { slug: 'some-app', limit: '500' })).status).toBe(400);
  });

  it('transcript: the frozen chat, its tool outputs cut as asked; each refusal reason is its own answer', async () => {
    svc.readSnapshotTranscript.mockResolvedValueOnce({
      ok: true,
      capturedAt: '2026-11-21T00:00:00.000Z',
      transcript: { conversationId: 'conv-a', turns: [] },
    });
    expect(await call('transcript', { ...VALID.transcript, toolOutputChars: '300' })).toEqual({
      status: 200,
      body: {
        publishRequestId: 'pubreq_a',
        capturedAt: '2026-11-21T00:00:00.000Z',
        transcript: { conversationId: 'conv-a', turns: [] },
      },
    });
    expect(svc.readSnapshotTranscript).toHaveBeenCalledWith('pubreq_a', 'conv-a', {
      toolOutputChars: 300,
    });
    svc.readSnapshotTranscript.mockResolvedValueOnce({ ok: false, reason: 'not-in-trace' });
    expect((await call('transcript', VALID.transcript)).status).toBe(404);
    svc.readSnapshotTranscript.mockResolvedValueOnce({ ok: false, reason: 'unreadable' });
    expect((await call('transcript', VALID.transcript)).status).toBe(503);
  });

  it('signals: the window defaults to 90 days and is bounded', async () => {
    svc.aggregateSignals.mockResolvedValue({ weeks: [], docsTopics: [] });
    await call('signals', { to: '2026-11-21T00:00:00.000Z' });
    expect(svc.aggregateSignals).toHaveBeenCalledWith({
      from: new Date('2026-08-23T00:00:00.000Z'),
      to: new Date('2026-11-21T00:00:00.000Z'),
    });
    expect(
      (await call('signals', { from: '2025-01-01T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z' }))
        .status
    ).toBe(400);
    expect(
      (await call('signals', { from: '2026-11-22T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z' }))
        .status
    ).toBe(400);
  });

  it('a transcript read is audited, naming the request and the chat', async () => {
    svc.readSnapshotTranscript.mockResolvedValueOnce({
      ok: true,
      capturedAt: null,
      transcript: {},
    });
    await call('transcript', VALID.transcript);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'apps.assistantTrace.transcript',
        outcome: 'ok',
        payload: expect.objectContaining({
          publishRequestId: 'pubreq_a',
          conversationId: 'conv-a',
        }),
      })
    );
  });
});
