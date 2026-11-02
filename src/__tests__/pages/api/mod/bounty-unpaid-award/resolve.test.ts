import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { mockResolve, session, signedIn } = vi.hoisted(() => ({
  mockResolve: vi.fn(),
  session: {
    user: { id: 7, isModerator: true as boolean, permissions: [], bannedAt: null },
  },
  signedIn: { current: true },
}));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: vi.fn() }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => (signedIn.current ? session : null)),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = vi.fn();
    userActivity = vi.fn();
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/bounty.service', () => ({ resolveUnpaidBountyAward: mockResolve }));

import handler from '~/pages/api/mod/bounty-unpaid-award/resolve';

function call(body: Record<string, unknown>) {
  const req = { method: 'POST', headers: {}, body, query: {} } as Parameters<typeof handler>[0];
  let statusCode = 200;
  let json: unknown;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json: (b: unknown) => {
      json = b;
      return res;
    },
    setHeader: vi.fn(),
    end: () => res,
  } as unknown as Parameters<typeof handler>[1];
  return handler(req, res).then(() => ({ status: statusCode, json }));
}

const ruling = {
  bountyId: 4,
  userId: 5,
  ruling: 'refunded_supporter',
  ledgerReference: '  manual refund  ',
};

beforeEach(() => {
  vi.clearAllMocks();
  session.user.isModerator = true;
  signedIn.current = true;
  mockResolve.mockResolvedValue({ recorded: true });
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('bounty.resolveUnpaidAward', () => {
  it('records the ruling as the acting moderator, with the reference trimmed', async () => {
    const { status, json } = await call(ruling);
    expect(status).toBe(200);
    expect(mockResolve).toHaveBeenCalledExactlyOnceWith({
      bountyId: 4,
      userId: 5,
      ruling: 'refunded_supporter',
      ledgerReference: 'manual refund',
      moderatorId: 7,
    });
    expect(json).toEqual({
      recorded: true,
      bountyId: 4,
      userId: 5,
      ruling: 'refunded_supporter',
    });
  });

  it('reports a repeated ruling as not recorded', async () => {
    mockResolve.mockResolvedValue({ recorded: false });
    expect((await call(ruling)).json).toMatchObject({ recorded: false });
  });

  it('refuses a caller who is not signed in', async () => {
    signedIn.current = false;
    expect((await call(ruling)).status).toBe(401);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('refuses a caller who is not a moderator', async () => {
    session.user.isModerator = false;
    expect((await call(ruling)).status).toBe(403);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it.each([
    ['a blank ledger reference', { ledgerReference: '   ' }],
    ['no ledger reference', { ledgerReference: undefined }],
    ['a ledger reference over 500 characters', { ledgerReference: 'x'.repeat(501) }],
    ['an unknown ruling', { ruling: 'split' }],
  ])('refuses %s before resolving anything', async (_, change) => {
    expect((await call({ ...ruling, ...change })).status).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  // The service refuses these (bounty-payout-lock.service.test.ts); the route must pass the refusal on
  // with its status and message, not turn it into a success or a 500.
  it.each([
    ['paid_winner on a record with no winner', 'BAD_REQUEST', 400],
    ['a different ruling on a resolved record', 'CONFLICT', 409],
  ] as const)('passes on the refusal of %s', async (_, code, expected) => {
    mockResolve.mockRejectedValue(new TRPCError({ code, message: `refused: ${code}` }));
    const { status, json } = await call({ ...ruling, ruling: 'paid_winner' });
    expect(status).toBe(expected);
    expect(JSON.stringify(json)).toContain(`refused: ${code}`);
  });
});
