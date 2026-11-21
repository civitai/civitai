import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { session, compMembershipGift, revokeCompMembershipGift, grant } = vi.hoisted(() => ({
  session: { user: {} as Record<string, unknown> },
  compMembershipGift: vi.fn(),
  revokeCompMembershipGift: vi.fn(),
  grant: { held: true, asked: [] as string[] },
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
  ) =>
    res
      .status(e instanceof TRPCError ? getHTTPStatusCodeFromError(e) : 500)
      .json({ message: (e as Error).message }),
}));
vi.mock('~/server/services/moderator-grants', () => ({
  hasModeratorGrant: async (_user: unknown, id: string) => {
    grant.asked.push(id);
    return grant.held;
  },
}));
vi.mock('~/server/services/membership-gift-comp.service', () => ({
  COMP_GIFT_LIMITS: { maxMonths: 12, dailyPerModerator: 10 },
  compMembershipGift,
  revokeCompMembershipGift,
}));

import compHandler from '~/server/api-routes/mod/membership-gift/comp';
import revokeHandler from '~/server/api-routes/mod/membership-gift/comp-revoke';

const MODERATOR = 990000007;
const RECIPIENT = 990100021;

function call(handler: typeof compHandler, body: Record<string, unknown>) {
  const req = { method: 'POST', headers: {}, body, query: {} } as unknown as Parameters<
    typeof handler
  >[0];
  let status = 200;
  let payload: unknown;
  const res = {
    status(c: number) {
      status = c;
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
  return Promise.resolve(handler(req, res)).then(() => ({ status, body: payload }));
}

const compBody = {
  userId: RECIPIENT,
  tier: 'gold',
  months: 3,
  reason: 'Thank-you for community work',
  execute: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  grant.held = true;
  grant.asked = [];
  session.user = { id: MODERATOR, isModerator: true, permissions: [], bannedAt: null };
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
  compMembershipGift.mockResolvedValue({ outcome: 'comped', giftId: 'gift_9', fulfilled: true });
  revokeCompMembershipGift.mockResolvedValue({ outcome: 'revoked', giftId: 'gift_9' });
});

describe('comp gift endpoints', () => {
  it('a moderator without user.membership.gift.comp is refused and nothing is comped', async () => {
    grant.held = false;
    const res = await call(compHandler, compBody);
    expect(res.status).toBe(403);
    expect(grant.asked).toEqual(['user.membership.gift.comp']);
    expect(compMembershipGift).not.toHaveBeenCalled();
  });

  it('with the grant, comps as the session moderator', async () => {
    const res = await call(compHandler, compBody);
    expect(res.status).toBe(200);
    expect(compMembershipGift).toHaveBeenCalledWith({
      recipientId: RECIPIENT,
      tier: 'gold',
      months: 3,
      reason: 'Thank-you for community work',
      message: undefined,
      anonymous: false,
      execute: true,
      moderatorId: MODERATOR,
    });
  });

  it('is a dry run unless execute is sent', async () => {
    const { execute: _execute, ...dry } = compBody;
    await call(compHandler, dry);
    expect(compMembershipGift).toHaveBeenCalledWith(expect.objectContaining({ execute: false }));
  });

  it('refuses a reason too short to audit, before the service runs', async () => {
    const res = await call(compHandler, { ...compBody, reason: 'thanks' });
    expect(res.status).toBe(400);
    expect(compMembershipGift).not.toHaveBeenCalled();
  });

  it('revoking a comp needs the same grant', async () => {
    grant.held = false;
    const res = await call(revokeHandler, { giftId: 'gift_9', execute: true });
    expect(res.status).toBe(403);
    expect(revokeCompMembershipGift).not.toHaveBeenCalled();

    grant.held = true;
    grant.asked = [];
    const ok = await call(revokeHandler, { giftId: 'gift_9', execute: true });
    expect(ok.status).toBe(200);
    expect(grant.asked).toEqual(['user.membership.gift.comp']);
    expect(revokeCompMembershipGift).toHaveBeenCalledWith({
      giftId: 'gift_9',
      execute: true,
      moderatorId: MODERATOR,
    });
  });
});
