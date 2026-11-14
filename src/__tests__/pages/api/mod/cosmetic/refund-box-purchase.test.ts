import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { session, refundBoxPurchase } = vi.hoisted(() => ({
  session: { user: {} as Record<string, unknown> },
  refundBoxPurchase: vi.fn(),
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
  hasModeratorGrant: async () => true,
}));
vi.mock('~/server/services/mystery-box-refund.service', () => ({ refundBoxPurchase }));

import handler from '~/pages/api/mod/cosmetic/refund-box-purchase';

const MODERATOR = 990000007;

function call(body: Record<string, unknown>) {
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

beforeEach(() => {
  vi.clearAllMocks();
  session.user = { id: MODERATOR, isModerator: true, permissions: [], bannedAt: null };
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('moderator box purchase refund', () => {
  it('refunds as the session moderator, for the moderator reason', async () => {
    refundBoxPurchase.mockResolvedValue({
      status: 'refunded',
      refunded: 1000,
      clawedBack: 700,
      payoutFailures: [],
    });

    const { status, body } = await call({ userId: 101, buzzTransactionId: 'p1' });

    expect(status).toBe(200);
    expect(refundBoxPurchase).toHaveBeenCalledWith({
      buzzTransactionId: 'p1',
      userId: 101,
      reason: 'moderator',
      actorId: MODERATOR,
    });
    expect(body).toMatchObject({ status: 'refunded', refunded: 1000, clawedBack: 700 });
  });

  it('refuses a signed-in user who is not a moderator', async () => {
    session.user = { id: 5, isModerator: false, permissions: [], bannedAt: null };

    const { status } = await call({ userId: 101, buzzTransactionId: 'p1' });

    expect([401, 403]).toContain(status);
    expect(refundBoxPurchase).not.toHaveBeenCalled();
  });

  it.each([
    ['skipped', { status: 'skipped', reason: 'already refunded' }, 'Not refunded'],
    ['failed', { status: 'failed', error: 'buzz down' }, 'Refund failed'],
  ])('answers 400 when the refund is %s', async (_, outcome, message) => {
    refundBoxPurchase.mockResolvedValue(outcome);

    const { status, body } = await call({ userId: 101, buzzTransactionId: 'p1' });

    expect(status).toBe(400);
    expect(body).toMatchObject({ message: expect.stringContaining(message) });
  });
});
