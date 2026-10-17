import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * `/api/mod/user/reactions` (count) and `/api/mod/user/remove-reactions` (remove): the moderator path to
 * a request to erase someone's reactions. The deletes and metric follow-ups are the service's and have
 * their own suite; this one pins who may call, which account it lands on, and the audit row.
 *
 * Every refusal is paired with the same call succeeding, so a 4xx cannot pass because nothing routes.
 */

const { mockAudit, session } = vi.hoisted(() => ({
  mockAudit: vi.fn(),
  session: {
    user: { id: 990000007, isModerator: true, permissions: [], bannedAt: null } as Record<
      string,
      unknown
    >,
  },
}));

vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: vi.fn(async () => null),
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => session),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = mockAudit;
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

const REMOVED = { ImageReaction: 3, ArticleReaction: 1 };
const COUNTS = { ImageReaction: 3, ArticleReaction: 1, CommentReaction: 0 };
const removeUserReactions = vi.fn<
  (userId: number) => Promise<{ removed: typeof REMOVED; remaining: number }>
>(async () => ({ removed: REMOVED, remaining: 0 }));
const countUserReactions = vi.fn<(userId: number) => Promise<typeof COUNTS>>(async () => COUNTS);
vi.mock('~/server/services/user-reaction-erasure.service', () => ({
  IMAGE_ROWS_PER_RUN: 25_000,
  removeUserReactions: (id: number) => removeUserReactions(id),
  countUserReactions: (id: number) => countUserReactions(id),
}));
const trackModActivity = vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined);
vi.mock('~/server/services/moderator.service', () => ({
  trackModActivity: (...a: unknown[]) => trackModActivity(...a),
}));
const hasModeratorGrant = vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true);
vi.mock('~/server/services/moderator-grants', () => ({
  hasModeratorGrant: (...a: unknown[]) => hasModeratorGrant(...a),
}));

import removeHandler from '~/pages/api/mod/user/remove-reactions';
import countHandler from '~/pages/api/mod/user/reactions';

const TARGET = 8675309;
const NAME = 'not_a_real_user';

function call(
  handler: typeof removeHandler | typeof countHandler,
  method: 'GET' | 'POST',
  input: Record<string, unknown>,
  query: Record<string, unknown> = {}
) {
  const req = {
    method,
    headers: {},
    body: method === 'POST' ? input : {},
    query: method === 'GET' ? { ...input, ...query } : query,
  } as Parameters<typeof removeHandler>[0];
  let statusCode = 200;
  let payload: unknown;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader: vi.fn(),
    end() {
      return res;
    },
  } as unknown as Parameters<typeof removeHandler>[1];
  return handler(req, res).then(() => ({ status: statusCode, body: payload }));
}
const remove = (body: Record<string, unknown>, query?: Record<string, unknown>) =>
  call(removeHandler, 'POST', body, query);
const count = (query: Record<string, unknown>) => call(countHandler, 'GET', query);

beforeEach(() => {
  vi.clearAllMocks();
  session.user = { id: 990000007, isModerator: true, permissions: [], bannedAt: null };
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
  dbMock.dbWrite.user.findFirst.mockResolvedValue({ id: TARGET, username: NAME });
});

describe('user.removeReactions — who may call it', () => {
  it('removes for a moderator holding user.removeReactions', async () => {
    const { status, body } = await remove({ userId: TARGET, username: NAME });
    expect(status).toBe(200);
    expect(removeUserReactions).toHaveBeenCalledTimes(1);
    expect(removeUserReactions).toHaveBeenCalledWith(TARGET);
    expect(body).toEqual({ userId: TARGET, removed: REMOVED, remaining: 0, auditRecorded: true });
  });

  it('refuses a moderator without the permission, before touching anything', async () => {
    hasModeratorGrant.mockResolvedValueOnce(false);
    // An unknown id and a wrong name: a later check answering first would tell them the account exists.
    dbMock.dbWrite.user.findFirst.mockResolvedValue(null);
    const { status } = await remove({ userId: TARGET, username: 'someone_else' });
    expect(status).toBe(403);
    expect(hasModeratorGrant).toHaveBeenCalledWith(
      expect.objectContaining({ id: 990000007 }),
      'user.removeReactions'
    );
    expect(dbMock.dbWrite.user.findFirst).not.toHaveBeenCalled();
    expect(removeUserReactions).not.toHaveBeenCalled();
  });

  it('refuses a non-moderator', async () => {
    session.user = { id: 990000099, isModerator: false, permissions: [], bannedAt: null };
    const { status } = await remove({ userId: TARGET, username: NAME });
    expect(status).toBe(403);
    expect(removeUserReactions).not.toHaveBeenCalled();
  });
});

describe('user.removeReactions — which account', () => {
  it('requires the username for an account that has one, without naming it', async () => {
    const { status, body } = await remove({ userId: TARGET });
    expect(status).toBe(400);
    expect(JSON.stringify(body)).not.toContain(NAME);
    expect(removeUserReactions).not.toHaveBeenCalled();
  });

  it('refuses a username that belongs to someone else', async () => {
    const { status } = await remove({ userId: TARGET, username: 'someone_else' });
    expect(status).toBe(400);
    expect(removeUserReactions).not.toHaveBeenCalled();
  });

  it('accepts no username for an account without one', async () => {
    dbMock.dbWrite.user.findFirst.mockResolvedValue({ id: TARGET, username: null });
    const { status } = await remove({ userId: TARGET });
    expect(status).toBe(200);
    expect(removeUserReactions).toHaveBeenCalledWith(TARGET);
  });

  it('refuses the confirmation in the query string', async () => {
    const { status } = await remove({ userId: TARGET }, { username: NAME });
    expect(status).toBe(400);
    expect(removeUserReactions).not.toHaveBeenCalled();
  });

  it('answers NOT_FOUND for an unknown id', async () => {
    dbMock.dbWrite.user.findFirst.mockResolvedValue(null);
    const { status } = await remove({ userId: TARGET, username: NAME });
    expect(status).toBe(404);
    expect(removeUserReactions).not.toHaveBeenCalled();
  });
});

describe('user.removeReactions — the audit trail', () => {
  it('writes one removeReactions ModActivity row against the acting moderator', async () => {
    await remove({ userId: TARGET, username: NAME });
    expect(trackModActivity).toHaveBeenCalledTimes(1);
    expect(trackModActivity).toHaveBeenCalledWith(990000007, {
      entityType: 'user',
      entityId: TARGET,
      activity: 'removeReactions',
    });
  });

  it('puts the counts on the audit row and keeps the typed username off it', async () => {
    await remove({ userId: TARGET, username: NAME });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.removeReactions',
        outcome: 'ok',
        payload: { userId: TARGET },
        affected: { userIds: [TARGET], removed: REMOVED, remaining: 0 },
      })
    );
  });

  it('reports a failed ModActivity write without failing a removal that committed', async () => {
    trackModActivity.mockRejectedValueOnce(new Error('db down'));
    const { status, body } = await remove({ userId: TARGET, username: NAME });
    expect(status).toBe(200);
    expect(body).toMatchObject({ auditRecorded: false, removed: REMOVED });
  });
});

describe('user.reactions — the count before removing', () => {
  it('counts for a holder of user.removeReactions and removes nothing', async () => {
    const { status, body } = await count({ userId: String(TARGET) });
    expect(status).toBe(200);
    expect(body).toEqual({ userId: TARGET, counts: COUNTS });
    expect(countUserReactions).toHaveBeenCalledWith(TARGET);
    expect(removeUserReactions).not.toHaveBeenCalled();
  });

  it('refuses without the permission, before looking the account up', async () => {
    hasModeratorGrant.mockResolvedValueOnce(false);
    dbMock.dbWrite.user.findFirst.mockResolvedValue(null);
    const { status } = await count({ userId: String(TARGET) });
    expect(status).toBe(403);
    expect(dbMock.dbWrite.user.findFirst).not.toHaveBeenCalled();
    expect(hasModeratorGrant).toHaveBeenCalledWith(
      expect.objectContaining({ id: 990000007 }),
      'user.removeReactions'
    );
    expect(countUserReactions).not.toHaveBeenCalled();
  });

  it('answers NOT_FOUND for an unknown id rather than a row of zeros', async () => {
    dbMock.dbWrite.user.findFirst.mockResolvedValue(null);
    const { status } = await count({ userId: String(TARGET) });
    expect(status).toBe(404);
    expect(countUserReactions).not.toHaveBeenCalled();
  });

  it('is a GET: a POST is refused', async () => {
    const { status } = await call(countHandler, 'POST', { userId: TARGET });
    expect(status).toBe(405);
  });
});
