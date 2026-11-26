import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { redisMock } from '~/__tests__/mocks';
import type * as ClickhouseClient from '~/server/clickhouse/client';

// The wrapper is unmocked: the route is served through `defineModeratorEndpoint`. The page grant
// and the report's reason are the endpoint's own checks, pinned here.
const { hubSession, svc, hasModeratorPageAccess } = vi.hoisted(() => ({
  hubSession: { current: null as null | { user: Record<string, unknown> } },
  svc: {
    refusePostText: vi.fn(),
    restorePostText: vi.fn(),
    holdPostTextForCsam: vi.fn(),
    getPostTextReportReason: vi.fn(),
  },
  hasModeratorPageAccess: vi.fn(),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: vi.fn(async () => null),
}));
vi.mock('~/server/auth/session-client', () => ({
  getHubSession: vi.fn(async () => hubSession.current),
  maybeRollHubCookie: vi.fn(async () => undefined),
  sessionClient: { getSessionUserById: vi.fn(async () => null) },
}));
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  Tracker: class {
    retoolAudit = vi.fn();
  },
}));
vi.mock('~/server/services/post-text-moderation.service', () => svc);
vi.mock('~/server/services/moderator-grants', () => ({ hasModeratorPageAccess }));

const { default: handler } = (await import('~/server/api-routes/mod/post-text/moderate')) as {
  default: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
};

const MODERATOR = {
  id: 4242,
  username: 'mod',
  isModerator: true,
  bannedAt: null,
  permissions: [],
  roles: ['moderator:reports'],
};
const MEMBER = { ...MODERATOR, isModerator: false };

async function call(body: Record<string, unknown>) {
  const req = {
    method: 'POST',
    url: '/api/mod/post-text/moderate',
    headers: { host: 'civitai.com' },
    query: {},
    body,
    cookies: {},
  } as unknown as NextApiRequest;
  let status = 200;
  let json: unknown;
  const headers = new Map<string, unknown>();
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      json = value;
      return res;
    },
    send(value: unknown) {
      json = value;
      return res;
    },
    setHeader(name: string, value: unknown) {
      headers.set(name.toLowerCase(), value);
      return res;
    },
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    end: () => res,
    on: () => res,
    once: () => res,
  } as unknown as NextApiResponse;
  await handler(req, res);
  return { status, json };
}

const TEXT = 71;
const REPORT = 300;
const minors = { reason: 'TOSViolation', details: { violation: 'Child abuse and exploitation' } };

beforeEach(() => {
  vi.clearAllMocks();
  hubSession.current = { user: MODERATOR };
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn(async () => ['OK', 1]),
  }));
  hasModeratorPageAccess.mockResolvedValue(true);
  svc.refusePostText.mockResolvedValue({ ok: true, postId: 5, changed: true });
  svc.holdPostTextForCsam.mockResolvedValue({ postId: 5, holdId: 9, changed: true });
  svc.getPostTextReportReason.mockResolvedValue(minors);
});

describe('/api/mod/post-text/moderate', () => {
  it("refuses a moderator without the report queues' page grant, and writes nothing", async () => {
    hasModeratorPageAccess.mockResolvedValue(false);
    for (const action of ['refuse', 'restore', 'hold'])
      expect((await call({ textId: TEXT, action, reason: 'why', reportId: REPORT })).status).toBe(
        403
      );
    expect(hasModeratorPageAccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: MODERATOR.id }),
      '/reports'
    );
    expect(svc.refusePostText).not.toHaveBeenCalled();
    expect(svc.restorePostText).not.toHaveBeenCalled();
    expect(svc.holdPostTextForCsam).not.toHaveBeenCalled();
  });

  it('refuses a non-moderator, and writes nothing', async () => {
    hubSession.current = { user: MEMBER };
    expect((await call({ textId: TEXT, action: 'refuse', reason: 'why' })).status).toBe(403);
    expect(svc.refusePostText).not.toHaveBeenCalled();
  });

  it('refuses for a moderator who holds the grant', async () => {
    const { status, json } = await call({ textId: TEXT, action: 'refuse', reason: 'graphic' });
    expect(status).toBe(200);
    expect(svc.refusePostText).toHaveBeenCalledWith({ textId: TEXT, moderatorId: MODERATOR.id });
    expect(json).toMatchObject({ textId: TEXT, action: 'refuse', changed: true });
  });

  it('answers a restore under a hold with 409, and a text that is gone with 404', async () => {
    svc.restorePostText.mockResolvedValueOnce({ ok: false, postId: 5, error: 'held' });
    expect((await call({ textId: TEXT, action: 'restore', reason: 'why' })).status).toBe(409);
    svc.restorePostText.mockResolvedValueOnce(null);
    expect((await call({ textId: TEXT, action: 'restore', reason: 'why' })).status).toBe(404);
  });

  it.each([
    ['an ordinary reason', { reason: 'TOSViolation', details: { violation: 'Graphic violence' } }],
    ['a report not on this text', null],
  ])('refuses a hold on %s, and holds nothing', async (_label, report) => {
    svc.getPostTextReportReason.mockResolvedValue(report);
    const { status } = await call({
      textId: TEXT,
      action: 'hold',
      reason: 'why',
      reportId: REPORT,
    });
    expect(status).toBe(400);
    expect(svc.getPostTextReportReason).toHaveBeenCalledWith(REPORT, TEXT);
    expect(svc.holdPostTextForCsam).not.toHaveBeenCalled();
  });

  it('refuses a hold with no report', async () => {
    expect((await call({ textId: TEXT, action: 'hold', reason: 'why' })).status).toBe(400);
    expect(svc.holdPostTextForCsam).not.toHaveBeenCalled();
  });

  it.each([
    ['a minor-sexualization report', minors],
    ['a CSAM report', { reason: 'CSAM', details: {} }],
  ])('holds on %s', async (_label, report) => {
    svc.getPostTextReportReason.mockResolvedValue(report);
    const { status } = await call({
      textId: TEXT,
      action: 'hold',
      reason: 'why',
      reportId: REPORT,
    });
    expect(status).toBe(200);
    expect(svc.holdPostTextForCsam).toHaveBeenCalledWith({
      textId: TEXT,
      moderatorId: MODERATOR.id,
      reportId: REPORT,
    });
  });
});
