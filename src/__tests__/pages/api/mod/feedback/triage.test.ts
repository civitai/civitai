import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { redisMock, resetSharedMocks } from '~/__tests__/mocks';

/**
 * `/api/mod/feedback/triage`: a moderator's API key setting one feedback report's triage status.
 *
 * Drives the REAL endpoint wrapper and the REAL role-grant check, so each refusal is the rule itself
 * answering. Faked: the session, the grant row, and the moderator app, which owns the write and
 * whose half is pinned against real rows in `feedback-triage-action.pglite.test.ts`.
 */

const MOD = 5;
const GRANTED_ROLE = 'moderator:feedback';
const HQ_URL = 'https://hq.civitai.com/t/abc_def_9xyz';

const { session, grantRow, triage } = vi.hoisted(() => ({
  session: { user: {} as Record<string, unknown> },
  grantRow: { path: null as string | null, roles: [] as string[] },
  triage: vi.fn(),
}));

vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: vi.fn(async () => null),
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => session),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = vi.fn();
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: (
    res: { status: (n: number) => { json: (b: unknown) => unknown } },
    e: unknown
  ) => {
    const status = e instanceof TRPCError ? getHTTPStatusCodeFromError(e) : 500;
    return res
      .status(status)
      .json({ error: (e as { code?: string }).code ?? 'error', message: (e as Error).message });
  },
}));
// The grant store: one `AppPageAccess` row, keyed by the path the check asks for.
vi.mock('~/server/db/kyselyDb', () => {
  let path: unknown;
  const query = {
    select: () => query,
    where: (col: string, _op: string, value: unknown) => {
      if (col === 'path') path = value;
      return query;
    },
    executeTakeFirst: async () => (path === grantRow.path ? { roles: grantRow.roles } : undefined),
  };
  return { kyselyWrite: { selectFrom: () => query } };
});
vi.mock('~/server/services/moderator-app.service', () => ({
  moderatorApp: { feedbackTriage: triage },
}));

import triageHandler from '~/pages/api/mod/feedback/triage';

function call(input: Record<string, unknown>) {
  const req = { method: 'POST', headers: {}, body: input, query: {} } as unknown as Parameters<
    typeof triageHandler
  >[0];
  let status = 200;
  let body: unknown;
  const res = {
    status(c: number) {
      status = c;
      return res;
    },
    json(b: unknown) {
      body = b;
      return res;
    },
    setHeader: vi.fn(),
    end() {
      return res;
    },
  } as unknown as Parameters<typeof triageHandler>[1];
  return Promise.resolve(triageHandler(req, res)).then(() => ({
    status,
    body: body as Record<string, unknown>,
  }));
}

const asUser = (over: Record<string, unknown>) => {
  session.user = { id: MOD, isModerator: true, roles: [GRANTED_ROLE], bannedAt: null, ...over };
};

const spokeAnswers = (result: unknown) => triage.mockResolvedValue({ ok: true, result });

const REQUEST = { id: 258, status: 'reviewed', expectedStatus: 'new' };

beforeEach(() => {
  resetSharedMocks();
  triage.mockReset();
  grantRow.path = 'grant:feedback.status.set';
  grantRow.roles = [GRANTED_ROLE];
  asUser({});
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
  spokeAnswers({ ok: true, changed: true });
});

describe('who may call it', () => {
  it('control: a moderator in a role on the feedback.status.set grant sets the status', async () => {
    const { status, body } = await call({
      ...REQUEST,
      noteAppend: 'tracked in HQ',
      hqTaskUrl: HQ_URL,
    });
    expect(status).toBe(200);
    expect(body).toEqual({ id: 258, status: 'reviewed', changed: true });
    expect(triage).toHaveBeenCalledTimes(1);
    expect(triage).toHaveBeenCalledWith({
      id: 258,
      status: 'reviewed',
      expectedStatus: 'new',
      noteAppend: 'tracked in HQ',
      hqTaskUrl: HQ_URL,
      userId: MOD,
    });
  });

  it('refuses a moderator whose roles are not on the grant, and writes nothing', async () => {
    asUser({ roles: ['moderator:other'] });
    const { status } = await call(REQUEST);
    expect(status).toBe(403);
    expect(triage).not.toHaveBeenCalled();
  });

  it('refuses everyone but moderator:admin when no grant row exists', async () => {
    grantRow.path = null;
    expect((await call(REQUEST)).status).toBe(403);
    asUser({ roles: ['moderator:admin'] });
    expect((await call(REQUEST)).status).toBe(200);
    expect(triage).toHaveBeenCalledTimes(1);
  });

  it('refuses a non-moderator even in a granted role', async () => {
    asUser({ isModerator: false });
    expect((await call(REQUEST)).status).toBe(403);
    expect(triage).not.toHaveBeenCalled();
  });

  it('refuses a caller with no session', async () => {
    session.user = undefined as unknown as Record<string, unknown>;
    expect((await call(REQUEST)).status).toBe(401);
    expect(triage).not.toHaveBeenCalled();
  });

  it('acts as the session, never as a user id in the body', async () => {
    await call({ ...REQUEST, userId: 99, moderatorId: 98 });
    expect(triage).toHaveBeenCalledWith(expect.objectContaining({ userId: MOD }));
  });
});

describe('what it accepts', () => {
  it.each([
    ['a status outside the set', { status: 'closed' }],
    ['no expected status', { expectedStatus: undefined }],
    ['a link to another host', { hqTaskUrl: 'https://example.com/t/abc' }],
    ['an http link', { hqTaskUrl: 'http://hq.civitai.com/t/abc' }],
    ['a link with a fragment', { hqTaskUrl: `${HQ_URL}#c1` }],
    ['a note over the cap', { noteAppend: 'x'.repeat(2001) }],
    ['a blank note', { noteAppend: ' ' }],
  ])('refuses %s with 400, before the write', async (_label, over) => {
    const { status } = await call({ ...REQUEST, ...over });
    expect(status).toBe(400);
    expect(triage).not.toHaveBeenCalled();
  });
});

describe('what it answers', () => {
  it('409 when the row moved since the caller read it', async () => {
    spokeAnswers({ ok: true, changed: false });
    const { status, body } = await call(REQUEST);
    expect(status).toBe(409);
    expect(body.message).toContain('new');
  });

  it('404 when the row does not exist', async () => {
    spokeAnswers({ ok: false, reason: 'gone' });
    expect((await call(REQUEST)).status).toBe(404);
  });

  it('500 when the moderator app answers something it does not recognise', async () => {
    triage.mockResolvedValue({ unexpected: true });
    expect((await call(REQUEST)).status).toBe(500);
  });
});
