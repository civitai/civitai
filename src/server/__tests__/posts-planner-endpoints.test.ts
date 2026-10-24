import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import type * as PlannerEndpoint from '~/server/utils/planner-endpoint';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';

// Lives here, not beside the routes: a test under src/pages fails `next build`.
//
// The route delegates to the planner procedures through `createPlannerCaller`, so the guards are
// the procedures' own and are tested with them. What is this file's is the seam: the action table
// routing query and body into the right procedure, and the TRPCError → HTTP status mapping the
// spoke reads.

const { caller } = vi.hoisted(() => ({
  caller: {
    post: {
      getScheduled: vi.fn(),
      getPlannerDetail: vi.fn(),
      reschedule: vi.fn(),
      publishNow: vi.fn(),
      unschedule: vi.fn(),
      shiftSchedule: vi.fn(),
    },
  },
}));

vi.mock('~/server/utils/planner-endpoint', async (importOriginal) => ({
  ...(await importOriginal<typeof PlannerEndpoint>()),
  createPlannerCaller: () => caller,
}));
const OWNER = { id: 7, onboarding: 0xff };

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  // The session check is AuthedEndpoint's; keep its method gate and hand the handler the owner.
  AuthedEndpoint:
    (handler: Handler, allowedMethods: string[] = ['GET']) =>
    (req: { method?: string }, res: { status(code: number): { json(body: unknown): unknown } }) =>
      allowedMethods.includes(req.method ?? '')
        ? handler(req, res, OWNER)
        : res.status(405).json({ error: 'Method not allowed' }),
}));

import plannerRoute from '~/pages/api/v1/posts/planner/[action]';

const target = new Date(Date.now() + 5 * 86_400_000);

function makeRes() {
  const headers: Record<string, unknown> = {};
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headersSent: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      res.headersSent = true;
      return res;
    },
    end() {
      res.headersSent = true;
      return res;
    },
    setHeader(name: string, value: unknown) {
      headers[name] = value;
      return res;
    },
    getHeader: (name: string) => headers[name],
    removeHeader: (name: string) => delete headers[name],
  };
  return res;
}

type Handler = (req: unknown, res: unknown, user: unknown) => Promise<unknown>;
const call = async (
  action: string,
  { query, ...req }: Record<string, unknown> & { query?: Record<string, unknown> }
) => {
  const res = makeRes();
  await plannerRoute(
    {
      query: { action, ...query },
      body: {},
      headers: { 'content-type': 'application/json' },
      ...req,
    } as never,
    res as never
  );
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const procedure of Object.values(caller.post)) procedure.mockResolvedValue({ ok: true });
});

describe('the action table', () => {
  it('answers 404 for an action that is not in the contract', async () => {
    const res = await call('nope', { method: 'POST' });

    expect(res.statusCode).toBe(404);
    for (const procedure of Object.values(caller.post)) expect(procedure).not.toHaveBeenCalled();
  });

  it.each([
    ['scheduled', 'POST'],
    ['detail', 'POST'],
    ['schedule', 'GET'],
    ['unschedule', 'GET'],
    ['shift', 'GET'],
  ])('%s refuses %s with 405: reads are GET, writes are POST', async (action, method) => {
    const res = await call(action, { method });

    expect(res.statusCode).toBe(405);
    for (const procedure of Object.values(caller.post)) expect(procedure).not.toHaveBeenCalled();
  });
});

describe('cookie writes must be JSON', () => {
  it.each([
    ['schedule', { id: 11, publishedAt: target.toISOString(), expectedScope: 'post' }],
    ['unschedule', { ids: [11] }],
    ['shift', { ids: [11], deltaMinutes: 60 }],
  ])('refuses a form-encoded %s POST with 415 and calls no procedure', async (action, body) => {
    const res = await call(action, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(res.statusCode).toBe(415);
    for (const procedure of Object.values(caller.post)) expect(procedure).not.toHaveBeenCalled();
  });

  it('lets an API-key request through without the JSON requirement', async () => {
    const res = await call('shift', {
      method: 'POST',
      body: { ids: [11], deltaMinutes: 60 },
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      context: { apiKeyId: 5, tokenScope: 0xff },
    });

    expect(res.statusCode).toBe(200);
    expect(caller.post.shiftSchedule).toHaveBeenCalled();
  });
});

describe('routing into the procedures', () => {
  it('GET scheduled hands the query range to post.getScheduled', async () => {
    const query = { from: '2026-10-01', to: '2026-11-01', modelVersionId: '30' };
    const res = await call('scheduled', { method: 'GET', query });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(caller.post.getScheduled).toHaveBeenCalledWith(query);
  });

  it('GET detail hands the id to post.getPlannerDetail', async () => {
    const res = await call('detail', { method: 'GET', query: { id: '11' } });

    expect(res.statusCode).toBe(200);
    expect(caller.post.getPlannerDetail).toHaveBeenCalledWith({ id: '11' });
  });

  it('POST schedule with a date calls post.reschedule', async () => {
    const res = await call('schedule', {
      method: 'POST',
      body: { id: 11, publishedAt: target.toISOString(), expectedScope: 'post' },
    });

    expect(res.statusCode).toBe(200);
    expect(caller.post.reschedule).toHaveBeenCalledWith({
      id: 11,
      publishedAt: target,
      expectedScope: 'post',
    });
    expect(caller.post.publishNow).not.toHaveBeenCalled();
  });

  it('POST schedule with publishNow calls post.publishNow', async () => {
    const res = await call('schedule', {
      method: 'POST',
      body: { id: 11, publishNow: true, expectedScope: 'version' },
    });

    expect(res.statusCode).toBe(200);
    expect(caller.post.publishNow).toHaveBeenCalledWith({ id: 11, expectedScope: 'version' });
    expect(caller.post.reschedule).not.toHaveBeenCalled();
  });

  it.each([
    ['a malformed id', { id: 'x', publishedAt: target.toISOString(), expectedScope: 'post' }],
    ['publishNow: false', { id: 11, publishNow: false, expectedScope: 'post' }],
    ['no expectedScope', { id: 11, publishedAt: target.toISOString() }],
    ['an empty body', undefined],
  ])('POST schedule refuses %s with 400 before reaching a procedure', async (_label, body) => {
    const res = await call('schedule', { method: 'POST', body });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid schedule request', code: 'BAD_REQUEST' });
    expect(caller.post.reschedule).not.toHaveBeenCalled();
    expect(caller.post.publishNow).not.toHaveBeenCalled();
  });

  it('POST unschedule forwards the body to post.unschedule', async () => {
    const res = await call('unschedule', { method: 'POST', body: { ids: [11, 12] } });

    expect(res.statusCode).toBe(200);
    expect(caller.post.unschedule).toHaveBeenCalledWith({ ids: [11, 12] });
  });

  it('POST shift forwards the body to post.shiftSchedule', async () => {
    const res = await call('shift', { method: 'POST', body: { ids: [11], deltaMinutes: 60 } });

    expect(res.statusCode).toBe(200);
    expect(caller.post.shiftSchedule).toHaveBeenCalledWith({ ids: [11], deltaMinutes: 60 });
  });
});

describe('TRPCError → HTTP status', () => {
  it.each([
    ['CONFLICT', 409],
    ['BAD_REQUEST', 400],
    ['FORBIDDEN', 403],
    ['NOT_FOUND', 404],
    ['UNAUTHORIZED', 401],
    ['TOO_MANY_REQUESTS', 429],
  ] as const)('%s → %i, keeping the message the spoke shows', async (code, status) => {
    caller.post.unschedule.mockRejectedValue(new TRPCError({ code, message: `refused: ${code}` }));

    const res = await call('unschedule', { method: 'POST', body: { ids: [11] } });

    expect(res.statusCode).toBe(status);
    expect(res.body).toEqual({ error: `refused: ${code}`, code });
  });

  it('leaves a server fault to the shared REST error path, which genericizes it', async () => {
    caller.post.shiftSchedule.mockRejectedValue(
      new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'relation "Post" does not exist' })
    );

    const res = await call('shift', { method: 'POST', body: { ids: [11], deltaMinutes: 60 } });

    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('relation');
  });
});
