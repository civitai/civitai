import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * 🔴 THIS FILE IS NAMED FOR A DECISION, NOT FOR A FUNCTION. READ IT BEFORE DELETING THE
 * `trackModActivity` CALL IN `src/pages/api/mod/user/delete.ts`.
 *
 * Most `defineModeratorEndpoint`s leave the `ModActivity` row to the moderator app's `logAction`, so
 * this endpoint writing its own looks like an inconsistency to remove, and removing it is the defect
 * this file exists to catch. The convention is wrong here: `defineModeratorEndpoint` also accepts an
 * `Authorization: Bearer` API key, so a script can delete
 * an account without the spoke ever seeing it, and under the convention that deletion would leave
 * no `ModActivity` row. The account-history panel reads that table, not the framework's own
 * audit row.
 *
 * The other end of the same decision: `deleteAccount` in
 * `apps/moderator/src/lib/server/user-actions.service.ts` deliberately does NOT call `logAction`.
 * If you restore the convention here, restore it there too — `ModActivity` is append-only in
 * production, so having both is two rows in the account history for one deletion.
 *
 * WHAT THE ASSERTION IS ACTUALLY FOR. The moderator id and the target id are both plain numbers,
 * adjacent in the call, and a swap type-checks. Every shape-only assertion passes against it, and
 * the resulting audit trail names the deleted person as the moderator who deleted them. So the ids
 * below are deliberately far apart, and the cases that assert an id assert the exact value.
 */

const { mockAudit, mockUserActivity, session } = vi.hoisted(() => ({
  mockAudit: vi.fn(),
  mockUserActivity: vi.fn(),
  session: {
    user: { id: 990000007, isModerator: true, permissions: [], bannedAt: null } as Record<
      string,
      unknown
    >,
  },
}));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: vi.fn() }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => session),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = mockAudit;
    userActivity = mockUserActivity;
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: (
    res: { status: (n: number) => { json: (b: unknown) => unknown } },
    e: unknown
  ) => res.status(500).json({ error: 'error', message: (e as Error).message }),
}));

const deleteUser = vi.fn(async () => ({}));
vi.mock('~/server/services/user.service', () => ({
  deleteUser: (...a: unknown[]) => deleteUser(...(a as [])),
}));
const trackModActivity = vi.fn(async () => undefined);
vi.mock('~/server/services/moderator.service', () => ({
  trackModActivity: (...a: unknown[]) => trackModActivity(...(a as [])),
}));
vi.mock('~/server/services/moderator-grants', () => ({ hasModeratorGrant: async () => true }));

import handler from '~/pages/api/mod/user/delete';

const MODERATOR = 990000007;
const OTHER_MODERATOR = 990005550;
const TARGET = 8675309;
/** The confirmation the endpoint REQUIRES for any account that has a username. */
const NAME = 'not_a_real_user';

function call(body: Record<string, unknown>) {
  const req = { method: 'POST', headers: {}, body, query: {} } as Parameters<typeof handler>[0];
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
  } as unknown as Parameters<typeof handler>[1];
  return handler(req, res).then(() => ({ status: statusCode, body: payload }));
}

beforeEach(() => {
  vi.clearAllMocks();
  session.user = { id: MODERATOR, isModerator: true, permissions: [], bannedAt: null };
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
  dbMock.dbWrite.user.findFirst.mockResolvedValue({
    id: TARGET,
    username: 'not_a_real_user',
    deletedAt: null,
  });
});

describe('user.delete — the audit row names the moderator, not the account', () => {
  it('writes a ModActivity row AT ALL (do not remove this call for consistency)', async () => {
    const { status } = await call({ userId: TARGET, username: NAME });
    expect(status).toBe(200);
    expect(trackModActivity).toHaveBeenCalledTimes(1);
  });

  it('attributes it to the CALLER, with the target as the entity', async () => {
    await call({ userId: TARGET, username: NAME });
    expect(trackModActivity).toHaveBeenCalledWith(MODERATOR, {
      entityType: 'user',
      entityId: TARGET,
      activity: 'deleteAccount',
    });
  });

  // The pair above passes against a hardcoded moderator id. This one does not: a different
  // moderator deleting the same account must produce a different actor.
  it('follows the session, so two moderators are told apart', async () => {
    session.user = { id: OTHER_MODERATOR, isModerator: true, permissions: [], bannedAt: null };
    await call({ userId: TARGET, username: NAME });
    expect(trackModActivity).toHaveBeenCalledWith(OTHER_MODERATOR, {
      entityType: 'user',
      entityId: TARGET,
      activity: 'deleteAccount',
    });
  });

  it('records the account closure against the TARGET, which is the other direction', async () => {
    await call({ userId: TARGET, username: NAME });
    expect(mockUserActivity).toHaveBeenCalledWith({
      type: 'Account closure',
      targetUserId: TARGET,
    });
  });

  it('writes no ModActivity row when the deletion itself failed', async () => {
    deleteUser.mockRejectedValueOnce(new Error('boom'));
    const { status } = await call({ userId: TARGET, username: NAME });
    expect(status).toBe(500);
    expect(trackModActivity).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 THE DELETION HAS COMMITTED BEFORE THE AUDIT ROW IS WRITTEN.
 *
 * So a failing audit write must not be allowed to turn a completed erasure into a 500. That
 * combination is the worst available: the person is erased, the `ModActivity` row is missing, the
 * framework's own audit row says `outcome: 'error'`, and the operator is told it failed — which is
 * what sends them to retry something that is already done.
 *
 * The gap is reported in the response instead of being swallowed, so the caller can say so.
 */
describe('user.delete — a failed audit write does not become a failed deletion', () => {
  it('still reports success, and says the audit row did not land', async () => {
    trackModActivity.mockRejectedValueOnce(new Error('postgres is down'));
    const { status, body } = await call({ userId: TARGET, username: NAME });
    expect(status).toBe(200);
    expect(body).toEqual({ deleted: true, userId: TARGET, auditRecorded: false });
  });

  // Paired with the case above, which alone would also pass against a handler that always reports
  // `auditRecorded: false`.
  it('reports auditRecorded true when the row DID land', async () => {
    const { status, body } = await call({ userId: TARGET, username: NAME });
    expect(status).toBe(200);
    expect(body).toEqual({ deleted: true, userId: TARGET, auditRecorded: true });
    expect(trackModActivity).toHaveBeenCalledTimes(1);
  });

  // 🔴 `auditRecorded` SPEAKS FOR THE ModActivity ROW AND NOTHING ELSE. If these two writes shared a
  // catch, a failure of the ClickHouse event would report the Postgres row as missing.
  // That is not a cosmetic lie: the spoke logs it as "the row failed", an operator adds the row by
  // hand, and ModActivity is append-only in production — so the account history ends up with the
  // duplicate entry this whole design exists to avoid. One try block per write.
  it('does NOT blame the ModActivity row when only the closure event failed', async () => {
    mockUserActivity.mockRejectedValueOnce(new Error('clickhouse is down'));

    const { status, body } = await call({ userId: TARGET, username: NAME });

    expect(status).toBe(200);
    expect(trackModActivity).toHaveBeenCalledTimes(1);
    expect(body).toEqual({ deleted: true, userId: TARGET, auditRecorded: true });
  });
});
