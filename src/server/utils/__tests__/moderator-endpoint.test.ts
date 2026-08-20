import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as z from 'zod';
import { redisMock } from '~/__tests__/mocks';
import { REDIS_SYS_KEYS } from '~/server/redis/client';

// Minimal NextApiRequest/Response stand-in (avoids a node-mocks-http dependency).
function createMocks({
  method = 'POST',
  headers = {},
  body = {},
  query = {},
}: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string>;
}) {
  const req = { method, headers, body, query } as unknown as Record<string, unknown>;
  let statusCode = 200;
  let payload: unknown = undefined;
  const responseHeaders: Record<string, string> = {};
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: unknown) {
      payload = body;
      return res;
    },
    setHeader(key: string, value: string) {
      responseHeaders[key] = value;
    },
    end() {
      return res;
    },
    _getStatusCode: () => statusCode,
    _getJSONData: () => payload,
    _getHeaders: () => responseHeaders,
  };
  return { req, res };
}

const { mockGetSession, mockServerSession, mockAudit } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockServerSession: vi.fn(),
  mockAudit: vi.fn(),
}));

// `sysRedis` comes from the canonical redis mock, registered globally in
// src/__tests__/setup.ts — see docs/testing/shared-module-mocks.md. Only the two commands this
// endpoint uses are stubbed, in `beforeEach`; `REDIS_SYS_KEYS` stays the REAL table, so the
// rate-limit key this test exercises is the one production builds, and it cannot go stale.
const mockMultiIncr = { value: 1 };
// The chain is captured because the reply alone proves nothing: `exec` returns a number this file
// chose, so a 429 test asserts on its own fixture. What the endpoint actually decides is the KEY and
// the TTL it passes to `set`, and those are only visible here.
let lastMulti: { set: ReturnType<typeof vi.fn>; incr: ReturnType<typeof vi.fn> };
const multiFactory = () => {
  lastMulti = {
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
  };
  return {
    ...lastMulti,
    exec: vi.fn().mockImplementation(async () => ['OK', mockMultiIncr.value]),
  };
};

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: mockGetSession }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: mockServerSession,
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = mockAudit;
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
// Short-circuits the endpoint-helpers import chain so this unit test does not pull the full
// Prisma + axiom + auth tree.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: (
    res: { status: (n: number) => { json: (b: unknown) => unknown } },
    e: unknown
  ) =>
    res.status(500).json({ error: 'An unexpected error occurred', message: (e as Error).message }),
}));

import {
  defineModeratorEndpoint,
  moderatorBoolean,
  specToDoc,
} from '~/server/utils/moderator-endpoint';

const MOD = { id: 7, isModerator: true, permissions: [] as string[], bannedAt: null };

function build(handlerSpy = vi.fn().mockResolvedValue({ ok: true }), privileged?: string) {
  return {
    handler: defineModeratorEndpoint('test.ping', {
      summary: 'Ping.',
      privileged,
      input: z.object({ value: z.coerce.number().int() }),
      rateLimit: { max: 5, windowSeconds: 60 },
      async handler(input, ctx) {
        return handlerSpy(input, ctx);
      },
    }),
    handlerSpy,
  };
}

const signedOut = () => mockServerSession.mockResolvedValue(null);
const signedInAs = (user: Partial<typeof MOD>) =>
  mockServerSession.mockResolvedValue({ user: { ...MOD, ...user } });

beforeEach(() => {
  vi.clearAllMocks();
  mockMultiIncr.value = 1;
  redisMock.sysRedis.multi.mockImplementation(multiFactory);
  redisMock.sysRedis.ttl.mockResolvedValue(60);
  signedInAs({});
});

describe('defineModeratorEndpoint', () => {
  it('returns 405 for non-POST methods', async () => {
    const { handler } = build();
    const { req, res } = createMocks({ method: 'GET' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(405);
    expect(res._getHeaders().Allow).toBe('POST'); // POST is the default
  });

  it('serves a GET endpoint and refuses POST to it', async () => {
    const handler = defineModeratorEndpoint('test.read', {
      method: 'GET',
      summary: 'Read.',
      async handler() {
        return { ok: true };
      },
    });
    const get = createMocks({ method: 'GET' });
    await handler(get.req as never, get.res as never);
    expect(get.res._getStatusCode()).toBe(200);

    const post = createMocks({});
    await handler(post.req as never, post.res as never);
    expect(post.res._getStatusCode()).toBe(405);
    expect(post.res._getHeaders().Allow).toBe('GET');
  });

  it('returns 401 when there is no session and no credentials', async () => {
    signedOut();
    const { handler } = build();
    const { req, res } = createMocks({ body: { value: 1 } });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(401);
  });

  it('returns 401 when a bearer token does not resolve to a session', async () => {
    mockGetSession.mockResolvedValue(null);
    const { handler } = build();
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer nope' },
      body: { value: 1 },
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(401);
    // A bad key is a refusal, not an invitation to try the cookie instead.
    expect(mockServerSession).not.toHaveBeenCalled();
  });

  it('accepts a moderator session cookie', async () => {
    const { handler, handlerSpy } = build();
    const { req, res } = createMocks({ body: { value: 3 } });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(handlerSpy.mock.calls[0][0]).toEqual({ value: 3 });
    expect(handlerSpy.mock.calls[0][1].actor.id).toBe(7);
  });

  it('accepts a moderator API key', async () => {
    mockGetSession.mockResolvedValue({ user: { ...MOD, id: 9 } });
    const { handler, handlerSpy } = build();
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer good' },
      body: { value: 1 },
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(handlerSpy.mock.calls[0][1].actor.id).toBe(9);
  });

  it('returns 403 when the user is not a moderator', async () => {
    signedInAs({ isModerator: false });
    const { handler } = build();
    const { req, res } = createMocks({ body: { value: 1 } });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
  });

  it('returns 403 when the moderator is banned', async () => {
    signedInAs({ bannedAt: new Date() as never });
    const { handler } = build();
    const { req, res } = createMocks({ body: { value: 1 } });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
  });

  it('returns 400 with field issues when the payload fails the schema', async () => {
    const { handler } = build();
    const { req, res } = createMocks({ body: { value: 'not-a-number' } });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(400);
    expect((res._getJSONData() as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
  });

  it('rejects a privileged action when the actor lacks the permission', async () => {
    const { handler, handlerSpy } = build(vi.fn(), 'testPermission');
    const { req, res } = createMocks({ body: { value: 1 } });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it('rejects a privileged action when the actor has no permissions array', async () => {
    signedInAs({ permissions: undefined as never });
    const { handler } = build(vi.fn(), 'testPermission');
    const { req, res } = createMocks({ body: { value: 1 } });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
  });

  it('allows a privileged action when the actor holds the permission, and audits it', async () => {
    signedInAs({ permissions: ['testPermission'] });
    const { handler } = build(vi.fn().mockResolvedValue({ ok: true }), 'testPermission');
    const { req, res } = createMocks({ body: { value: 1 } });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'test.ping', privileged: true, outcome: 'ok' })
    );
  });

  it('returns 429 when the per-actor rate limit is exceeded', async () => {
    mockMultiIncr.value = 6; // limit is 5
    const { handler, handlerSpy } = build();
    const { req, res } = createMocks({ body: { value: 1 } });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(429);
    expect(res._getHeaders()['Retry-After']).toBe('60');
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  // 🔴 These five exist because the suite passed green against five mutations of the builder: a
  // rate-limit key with the actor dropped, a `set` with no NX/EX, `privileged` hardcoded true, a
  // handler invoked twice, and reversed body/query precedence.
  it('keys the rate limit per endpoint AND per actor, with the TTL in the same command', async () => {
    const { handler } = build();
    const { req, res } = createMocks({ body: { value: 1 } });
    await handler(req as never, res as never);
    expect(lastMulti.set).toHaveBeenCalledWith(
      `${REDIS_SYS_KEYS.RETOOL_ENDPOINT.RATE_LIMIT}:test.ping:7`,
      '0',
      // NX so an in-flight window is not reset to 0 on every call; EX so a crash between SET and
      // INCR cannot strand a TTL-less counter and lock the actor out permanently.
      { NX: true, EX: 60 }
    );
  });

  it('gives two actors two counters — a shared key would lock out every other moderator', async () => {
    const { handler } = build();
    await handler(...(Object.values(createMocks({ body: { value: 1 } })) as [never, never]));
    const firstKey = lastMulti.set.mock.calls[0][0];

    signedInAs({ id: 99 });
    await handler(...(Object.values(createMocks({ body: { value: 1 } })) as [never, never]));
    const secondKey = lastMulti.set.mock.calls[0][0];

    expect(firstKey).not.toBe(secondKey);
    expect(secondKey).toContain(':99');
  });

  it('runs the handler and writes the audit row exactly once', async () => {
    const { handler, handlerSpy } = build();
    const { req, res } = createMocks({ body: { value: 1 } });
    await handler(req as never, res as never);
    // A doubled call here is a doubled MODERATION EFFECT — a second strike, a second grant — and a
    // second audit row saying so.
    expect(handlerSpy).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledTimes(1);
  });

  it('reports a non-privileged action as non-privileged on the audit row', async () => {
    const { handler } = build();
    const { req, res } = createMocks({ body: { value: 1 } });
    await handler(req as never, res as never);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ privileged: false }));
  });

  it('lets the query string win over a disagreeing body', async () => {
    const { handler, handlerSpy } = build();
    const { req, res } = createMocks({ body: { value: 1 }, query: { value: '2' } });
    await handler(req as never, res as never);
    expect(handlerSpy).toHaveBeenCalledWith({ value: 2 }, expect.anything());
  });

  it('splits `affected` out of the response and onto the audit row', async () => {
    const { handler } = build(vi.fn().mockResolvedValue({ id: 1, affected: { userIds: [2] } }));
    const { req, res } = createMocks({ body: { value: 1 } });
    await handler(req as never, res as never);
    expect(res._getJSONData()).toEqual({ id: 1 });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ affected: { userIds: [2] } }));
  });

  it('emits an error audit row when the handler throws', async () => {
    const { handler } = build(vi.fn().mockRejectedValue(new Error('boom')));
    const { req, res } = createMocks({ body: { value: 1 } });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(500);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', errorMsg: 'boom' })
    );
  });
});

describe('specToDoc', () => {
  // `getServerSideProps` refuses to serialise `undefined`, and one endpoint without a `privileged`
  // key took the whole docs page down with a 500. Absence must mean the key is missing.
  it('omits optional fields rather than setting them undefined', () => {
    const doc = specToDoc({
      summary: 'x',
      rateLimit: { max: 1, windowSeconds: 1 },
      input: z.object({ a: z.string() }),
    });
    expect('privileged' in doc).toBe(false);
    expect('returns' in doc).toBe(false);
    expect('notes' in doc).toBe(false);
    expect('description' in doc.params[0]).toBe(false);
  });

  // Zod's projection THROWS on a Date by default, and the catalog builds all 26 docs in one pass —
  // so one `z.coerce.date()` param took the whole reference page down with a 500.
  it('projects a date param instead of throwing', () => {
    const doc = specToDoc({
      summary: 'x',
      rateLimit: { max: 1, windowSeconds: 1 },
      input: z.object({ cursor: z.coerce.date().optional().describe('a date') }),
    });
    expect(doc.params).toEqual([
      { name: 'cursor', type: 'unknown', required: false, description: 'a date' },
    ]);
  });

  it('derives params from the schema that validates the request', () => {
    const doc = specToDoc({
      summary: 'x',
      rateLimit: { max: 1, windowSeconds: 1 },
      input: z.object({
        required: z.string().describe('needed'),
        optional: z.string().optional(),
      }),
    });
    expect(doc.params).toEqual([
      { name: 'required', type: 'string', required: true, description: 'needed' },
      { name: 'optional', type: 'string', required: false },
    ]);
  });
});

describe('moderatorBoolean', () => {
  // It is bound to `isModerator` on user/toggle-moderator, so the failure this prevents is a request
  // saying "false" granting the role. `z.coerce.boolean()` is JS `Boolean()`, under which every
  // non-empty string — "false" included — is true.
  it.each([
    ['false', false],
    ['0', false],
    [0, false],
    ['true', true],
    ['1', true],
    [1, true],
    [true, true],
    [false, false],
  ])('reads %o as %o', (input, expected) => {
    expect(moderatorBoolean.parse(input)).toBe(expected);
  });

  it.each(['yes', 'no', '', 'TRUE', 2, null])('refuses %o rather than guessing', (input) => {
    expect(moderatorBoolean.safeParse(input).success).toBe(false);
  });
});
