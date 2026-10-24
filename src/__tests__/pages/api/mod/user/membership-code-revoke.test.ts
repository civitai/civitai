import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * `/api/mod/user/membership-code-revoke` — support revokes an unredeemed code it minted.
 *
 * Same gate as minting. The service owns which codes can be revoked; this file pins who may call,
 * the input shape, and that the revoker is the session's moderator.
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
    code: 'MB-ABCD-EF12',
    revokedAt: new Date('2026-10-13T12:00:00.000Z'),
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
  revokeSupportMembershipCode: (...a: unknown[]) => mint(...a),
}));
vi.mock('~/server/services/moderator-grants', () => ({
  hasModeratorGrant: (...a: unknown[]) => hasModeratorGrant(...a),
}));

import handler from '~/pages/api/mod/user/membership-code-revoke';

const TARGET = 8675309;
const VALID = { userId: TARGET, code: 'MB-ABCD-EF12' };

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

  it('refuses a signed-in non-moderator', async () => {
    session.user = { id: 990000099, isModerator: false, permissions: [], bannedAt: null };
    const { status } = await call(VALID);
    expect(status).toBe(403);
    expect(mint).not.toHaveBeenCalled();
  });

  it('control: a permitted moderator revokes, as themselves', async () => {
    const { status, body } = await call({ ...VALID, moderatorId: 1 });
    expect(status).toBe(200);
    expect(mint).toHaveBeenCalledWith({
      code: 'MB-ABCD-EF12',
      forUserId: TARGET,
      moderatorId: 990000007,
    });
    expect(body).toMatchObject({ code: 'MB-ABCD-EF12' });
  });
});

describe('input', () => {
  it.each([
    ['a malformed code', { code: 'not-a-code' }],
    ['a lowercase code', { code: 'mb-abcd-ef12' }],
    ['no code', { code: undefined }],
    ['no userId', { userId: undefined }],
  ])('refuses %s with a 400', async (_l, patch) => {
    const { status } = await call({ ...VALID, ...patch });
    expect(status).toBe(400);
    expect(mint).not.toHaveBeenCalled();
  });

  it('a redeemed code is a 409 with its message intact', async () => {
    mint.mockRejectedValueOnce(
      new TRPCError({ code: 'CONFLICT', message: 'That code has already been redeemed.' })
    );
    const { status, body } = await call(VALID);
    expect(status).toBe(409);
    expect(body).toMatchObject({ message: 'That code has already been redeemed.' });
  });
});
