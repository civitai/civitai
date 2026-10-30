import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * `/api/mod/user/membership-code` — support mints a membership code for a customer.
 *
 * Each refusal has a control: the same call that must reach the service. The service owns the
 * bounds that need the database (price, target account, daily cap); this file pins who may call,
 * the schema bounds, and that the minter is the session's moderator rather than anything the body
 * says.
 */

const { mockAudit, session, mint, hasModeratorGrant } = vi.hoisted(() => ({
  mockAudit: vi.fn(),
  session: {
    user: { id: 990000007, isModerator: true, permissions: [], bannedAt: null } as Record<
      string,
      unknown
    >,
  },
  mint: vi.fn<(...a: unknown[]) => Promise<Record<string, unknown>>>(async () => ({
    code: 'MB-TEST-CODE',
    expiresAt: new Date('2026-11-12T12:00:00.000Z'),
    tier: 'silver',
    months: 2,
  })),
  hasModeratorGrant: vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true),
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
vi.mock('~/server/services/support-membership-code.service', () => ({
  SUPPORT_MEMBERSHIP_CODE_LIMITS: { maxMonths: 6, dailyPerModerator: 10, expiryDays: 30 },
  SUPPORT_MEMBERSHIP_CODE_TIERS: ['bronze', 'silver', 'gold'],
  mintSupportMembershipCode: (...a: unknown[]) => mint(...a),
}));
vi.mock('~/server/services/moderator-grants', () => ({
  hasModeratorGrant: (...a: unknown[]) => hasModeratorGrant(...a),
}));

import handler from '~/pages/api/mod/user/membership-code';

const TARGET = 8675309;
const VALID = { userId: TARGET, tier: 'silver', months: 2, reason: 'Support ticket 123' };

function call(body: Record<string, unknown>, method = 'POST') {
  const req = { method, headers: {}, body, query: {} } as Parameters<typeof handler>[0];
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
  session.user = { id: 990000007, isModerator: true, permissions: [], bannedAt: null };
  hasModeratorGrant.mockResolvedValue(true);
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('who may call it', () => {
  it('refuses a signed-in non-moderator', async () => {
    session.user = { id: 990000099, isModerator: false, permissions: [], bannedAt: null };
    const { status } = await call(VALID);
    expect(status).toBe(403);
    expect(mint).not.toHaveBeenCalled();
  });

  it('refuses a moderator without the user.membership.code permission', async () => {
    hasModeratorGrant.mockResolvedValue(false);
    const { status } = await call(VALID);
    expect(status).toBe(403);
    expect(hasModeratorGrant).toHaveBeenCalledWith(
      expect.objectContaining({ id: 990000007 }),
      'user.membership.code'
    );
    expect(mint).not.toHaveBeenCalled();
  });

  it('control: a moderator holding the permission mints, and gets the code back', async () => {
    const { status, body } = await call(VALID);
    expect(status).toBe(200);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ code: 'MB-TEST-CODE', tier: 'silver', months: 2 });
  });

  it('refuses GET (a mutating GET would be forgeable cross-site)', async () => {
    const { status } = await call(VALID, 'GET');
    expect(status).toBe(405);
    expect(mint).not.toHaveBeenCalled();
  });
});

describe('the minter is the session, not the body', () => {
  it('passes the acting moderator id, ignoring any moderatorId or mintedBy in the body', async () => {
    await call({ ...VALID, moderatorId: 1, mintedBy: 1 });
    expect(mint).toHaveBeenCalledWith({
      forUserId: TARGET,
      tier: 'silver',
      months: 2,
      reason: 'Support ticket 123',
      moderatorId: 990000007,
    });
  });
});

describe('schema bounds', () => {
  it.each([
    ['months 0', { months: 0 }],
    ['months 7', { months: 7 }],
    ['fractional months', { months: 1.5 }],
    ['an unknown tier', { tier: 'platinum' }],
    ['a blank reason', { reason: '   ' }],
    ['a 501-char reason', { reason: 'x'.repeat(501) }],
    ['no userId', { userId: undefined }],
  ])('refuses %s with a 400 and does not mint', async (_label, patch) => {
    const { status } = await call({ ...VALID, ...patch });
    expect(status).toBe(400);
    expect(mint).not.toHaveBeenCalled();
  });

  it.each([
    ['1 month of bronze', { months: 1, tier: 'bronze' }],
    ['6 months of gold', { months: 6, tier: 'gold' }],
  ])('control: accepts %s', async (_label, patch) => {
    const { status } = await call({ ...VALID, ...patch });
    expect(status).toBe(200);
    expect(mint).toHaveBeenCalledTimes(1);
  });
});

describe('refusals from the service reach the caller', () => {
  it('the daily cap is a 429 with its message intact', async () => {
    mint.mockRejectedValueOnce(
      new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Daily limit of 10 codes reached.' })
    );
    const { status, body } = await call(VALID);
    expect(status).toBe(429);
    expect(body).toMatchObject({ message: 'Daily limit of 10 codes reached.' });
  });
});
