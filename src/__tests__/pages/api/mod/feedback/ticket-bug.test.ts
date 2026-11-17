import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, redisMock, resetSharedMocks } from '~/__tests__/mocks';

const MOD = 5;
const GRANTED_ROLE = 'moderator:tickets';
const HQ_URL = 'https://hq.civitai.com/t/abc_def_9xyz';

const { session, grantRow, createFeedback, fileFeedbackToHq } = vi.hoisted(() => ({
  session: { user: {} as Record<string, unknown> },
  grantRow: { path: null as string | null, roles: [] as string[] },
  createFeedback: vi.fn(),
  fileFeedbackToHq: vi.fn(),
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
vi.mock('~/server/services/feedback.service', () => ({ createFeedback }));
vi.mock('~/server/services/feedback-hq.service', () => ({ fileFeedbackToHq }));

import handler from '~/pages/api/mod/feedback/ticket-bug';

function call(input: Record<string, unknown>) {
  const req = { method: 'POST', headers: {}, body: input, query: {} } as unknown as Parameters<
    typeof handler
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
  } as unknown as Parameters<typeof handler>[1];
  return Promise.resolve(handler(req, res)).then(() => ({
    status,
    body: body as Record<string, unknown>,
  }));
}

const asUser = (over: Record<string, unknown>) => {
  session.user = { id: MOD, isModerator: true, roles: [GRANTED_ROLE], bannedAt: null, ...over };
};

const REQUEST = { ticketId: 4321, message: 'Freshdesk ticket #4321\n\nButtons overlap' };

beforeEach(() => {
  resetSharedMocks();
  createFeedback.mockReset().mockResolvedValue({ id: 77 });
  fileFeedbackToHq.mockReset().mockResolvedValue(undefined);
  dbMock.dbWrite.feedback.findUnique.mockResolvedValue({
    context: { hq: { id: 'abc_def_9xyz', url: HQ_URL } },
  });
  grantRow.path = 'grant:tickets.escalate';
  grantRow.roles = [GRANTED_ROLE];
  asUser({});
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('filing a bug from a ticket', () => {
  it('control: files a site bug report as the moderator, stamped with the ticket, and files it to HQ', async () => {
    const { status, body } = await call(REQUEST);
    expect(status).toBe(200);
    expect(body).toEqual({ id: 77, hqUrl: HQ_URL });
    expect(createFeedback).toHaveBeenCalledTimes(1);
    expect(fileFeedbackToHq).toHaveBeenCalledTimes(1);
    expect(createFeedback).toHaveBeenCalledWith({
      area: 'site-bug-report',
      message: REQUEST.message,
      context: { reportedSource: 'moderator-ticket' },
      userId: MOD,
      freshdeskTicketId: 4321,
    });
    // Nothing re-files a row that missed this, so it must happen here.
    expect(fileFeedbackToHq).toHaveBeenCalledWith(
      expect.objectContaining({ feedbackId: 77, userId: MOD, area: 'site-bug-report' })
    );
  });

  it('answers a null hqUrl when the HQ filing did not land; the report is still saved', async () => {
    dbMock.dbWrite.feedback.findUnique.mockResolvedValue({ context: {} });
    const { status, body } = await call(REQUEST);
    expect(status).toBe(200);
    expect(body).toEqual({ id: 77, hqUrl: null });
  });

  it('refuses a moderator whose roles are not on the tickets.escalate grant, and files nothing', async () => {
    asUser({ roles: ['moderator:other'] });
    expect((await call(REQUEST)).status).toBe(403);
    expect(createFeedback).not.toHaveBeenCalled();
    expect(fileFeedbackToHq).not.toHaveBeenCalled();
  });

  it('refuses a non-moderator even in a granted role', async () => {
    asUser({ isModerator: false });
    expect((await call(REQUEST)).status).toBe(403);
    expect(createFeedback).not.toHaveBeenCalled();
  });

  it('refuses an empty message or a bad ticket id', async () => {
    expect((await call({ ...REQUEST, message: '  ' })).status).toBe(400);
    expect((await call({ ...REQUEST, ticketId: 0 })).status).toBe(400);
    expect(createFeedback).not.toHaveBeenCalled();
  });
});
