import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * `/api/mod/user/creator-score-grant` and `…-revoke`: a moderator awards Creator Score by hand, or
 * withdraws a grant.
 *
 * Each refusal has a control: the same call that reaches the service. The service owns the bounds
 * that need the database (target account, daily cap, already revoked); this file pins who may call,
 * the schema bounds, and that the actor is the session's moderator rather than anything the body
 * says.
 */

const { mockAudit, session, grant, revoke, hasModeratorGrant } = vi.hoisted(() => ({
  mockAudit: vi.fn(),
  session: { user: {} as Record<string, unknown> },
  grant: vi.fn<(...a: unknown[]) => Promise<Record<string, unknown>>>(async () => ({
    id: 1,
    amount: 250,
    createdAt: new Date('2026-10-13T12:00:00.000Z'),
    total: 1250,
  })),
  revoke: vi.fn<(...a: unknown[]) => Promise<Record<string, unknown>>>(async () => ({
    id: 41,
    revokedAt: new Date('2026-10-13T12:00:00.000Z'),
    total: 1000,
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
vi.mock('~/server/services/creator-score-grant.service', () => ({
  CREATOR_SCORE_GRANT_LIMITS: {
    maxAmount: 10_000,
    largeMaxAmount: 1_000_000,
    dailyPerModerator: 20,
    maxReasonLength: 500,
  },
  grantCreatorScore: (...a: unknown[]) => grant(...a),
  revokeCreatorScoreGrant: (...a: unknown[]) => revoke(...a),
}));
vi.mock('~/server/services/moderator-grants', () => ({
  hasModeratorGrant: (...a: unknown[]) => hasModeratorGrant(...a),
}));

import grantHandler from '~/pages/api/mod/user/creator-score-grant';
import revokeHandler from '~/pages/api/mod/user/creator-score-grant-revoke';

const MODERATOR = 990000007;
const TARGET = 8675309;
const GRANT = { userId: TARGET, amount: 250, reason: 'Contest judge' };
const REVOKE = { userId: TARGET, grantId: 41, reason: 'Granted to the wrong account' };

function caller(handler: typeof grantHandler) {
  return (body: Record<string, unknown>, method = 'POST') => {
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
  };
}
const callGrant = caller(grantHandler);
const callRevoke = caller(revokeHandler);

beforeEach(() => {
  vi.clearAllMocks();
  session.user = { id: MODERATOR, isModerator: true, permissions: [], bannedAt: null };
  hasModeratorGrant.mockResolvedValue(true);
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('grant: who may call it', () => {
  it('refuses a signed-in non-moderator', async () => {
    session.user = { id: 990000099, isModerator: false, permissions: [], bannedAt: null };
    const { status } = await callGrant(GRANT);
    expect(status).toBe(403);
    expect(grant).not.toHaveBeenCalled();
  });

  it('refuses a moderator without the user.creatorScore.grant permission', async () => {
    hasModeratorGrant.mockResolvedValue(false);
    const { status } = await callGrant(GRANT);
    expect(status).toBe(403);
    expect(hasModeratorGrant).toHaveBeenCalledWith(
      expect.objectContaining({ id: MODERATOR }),
      'user.creatorScore.grant'
    );
    expect(grant).not.toHaveBeenCalled();
  });

  it('control: a moderator holding the permission grants, and gets the new total back', async () => {
    const { status, body } = await callGrant(GRANT);
    expect(status).toBe(200);
    expect(grant).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ id: 1, amount: 250, total: 1250 });
  });

  it('refuses GET (a mutating GET would be forgeable cross-site)', async () => {
    const { status } = await callGrant(GRANT, 'GET');
    expect(status).toBe(405);
    expect(grant).not.toHaveBeenCalled();
  });
});

describe('grant: the granter is the session, not the body', () => {
  it('passes the acting moderator id, ignoring any moderatorId or grantedById in the body', async () => {
    await callGrant({ ...GRANT, moderatorId: 1, grantedById: 1 });
    expect(grant).toHaveBeenCalledWith({
      userId: TARGET,
      amount: 250,
      reason: 'Contest judge',
      moderatorId: MODERATOR,
      allowLarge: false,
    });
  });
});

describe('grant: over 10,000 needs the large-grant permission as well', () => {
  const LARGE = { ...GRANT, amount: 100_000 };
  const holds = (...ids: string[]) =>
    hasModeratorGrant.mockImplementation(async (_actor, id) => ids.includes(id as string));

  it('refuses 100,000 from a moderator holding only user.creatorScore.grant', async () => {
    holds('user.creatorScore.grant');
    const { status, body } = await callGrant(LARGE);
    expect(status).toBe(403);
    expect(body).toMatchObject({
      message: expect.stringContaining('user.creatorScore.grantLarge'),
    });
    expect(grant).not.toHaveBeenCalled();
  });

  it('control: grants 100,000 for a moderator holding both, and lets the service take it', async () => {
    holds('user.creatorScore.grant', 'user.creatorScore.grantLarge');
    const { status } = await callGrant(LARGE);
    expect(status).toBe(200);
    expect(grant).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 100_000, moderatorId: MODERATOR, allowLarge: true })
    );
  });

  // The large permission widens the ordinary one; it does not stand in for it.
  it('refuses 100,000 from a moderator holding only the large-grant permission', async () => {
    holds('user.creatorScore.grantLarge');
    const { status } = await callGrant(LARGE);
    expect(status).toBe(403);
    expect(grant).not.toHaveBeenCalled();
  });

  it('control: 10,000 from a plain holder grants without the large permission', async () => {
    holds('user.creatorScore.grant');
    const { status } = await callGrant({ ...GRANT, amount: 10_000 });
    expect(status).toBe(200);
    expect(grant).toHaveBeenCalledWith(expect.objectContaining({ allowLarge: false }));
  });

  it('refuses 1,000,001 even for a holder of both', async () => {
    const { status } = await callGrant({ ...GRANT, amount: 1_000_001 });
    expect(status).toBe(400);
    expect(grant).not.toHaveBeenCalled();
  });
});

describe('grant: schema bounds', () => {
  it.each([
    ['amount 0', { amount: 0 }],
    ['a negative amount', { amount: -5 }],
    ['an amount over the large-grant cap', { amount: 1_000_001 }],
    ['a fractional amount', { amount: 1.5 }],
    ['a blank reason', { reason: '   ' }],
    ['a 501-char reason', { reason: 'x'.repeat(501) }],
    ['no userId', { userId: undefined }],
  ])('refuses %s with a 400 and does not grant', async (_label, patch) => {
    const { status } = await callGrant({ ...GRANT, ...patch });
    expect(status).toBe(400);
    expect(grant).not.toHaveBeenCalled();
  });

  it.each([
    ['1 point', { amount: 1 }],
    ['exactly the cap', { amount: 10_000 }],
    ['exactly the large-grant cap', { amount: 1_000_000 }],
  ])('control: accepts %s', async (_label, patch) => {
    const { status } = await callGrant({ ...GRANT, ...patch });
    expect(status).toBe(200);
    expect(grant).toHaveBeenCalledTimes(1);
  });
});

describe('grant: refusals from the service reach the caller', () => {
  it('the daily cap is a 429 with its message intact', async () => {
    grant.mockRejectedValueOnce(
      new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Daily limit of 20 grants reached.' })
    );
    const { status, body } = await callGrant(GRANT);
    expect(status).toBe(429);
    expect(body).toMatchObject({ message: 'Daily limit of 20 grants reached.' });
  });
});

describe('revoke', () => {
  it('refuses a moderator without the user.creatorScore.grant permission', async () => {
    hasModeratorGrant.mockResolvedValue(false);
    const { status } = await callRevoke(REVOKE);
    expect(status).toBe(403);
    expect(hasModeratorGrant).toHaveBeenCalledWith(
      expect.objectContaining({ id: MODERATOR }),
      'user.creatorScore.grant'
    );
    expect(revoke).not.toHaveBeenCalled();
  });

  it('control: a moderator holding the permission revokes as the session', async () => {
    const { status } = await callRevoke({ ...REVOKE, moderatorId: 1, revokedById: 1 });
    expect(status).toBe(200);
    expect(revoke).toHaveBeenCalledWith({
      grantId: 41,
      userId: TARGET,
      reason: 'Granted to the wrong account',
      moderatorId: MODERATOR,
    });
  });

  it.each([
    ['a blank reason', { reason: '   ' }],
    ['no grantId', { grantId: undefined }],
    ['grantId 0', { grantId: 0 }],
  ])('refuses %s with a 400 and does not revoke', async (_label, patch) => {
    const { status } = await callRevoke({ ...REVOKE, ...patch });
    expect(status).toBe(400);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('an already-revoked grant reaches the caller as a 409', async () => {
    revoke.mockRejectedValueOnce(
      new TRPCError({ code: 'CONFLICT', message: 'That grant has already been revoked.' })
    );
    const { status } = await callRevoke(REVOKE);
    expect(status).toBe(409);
  });
});
