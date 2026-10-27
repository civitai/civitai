import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as SubscriptionsService from '~/server/services/subscriptions.service';

/**
 * `/api/mod/user/buzz-membership-end` — support ends a Buzz-purchased membership.
 *
 * The service owns which row ends; this file pins who may call, the input shape, and that the
 * moderator recorded is the session's.
 */

const { mockAudit, session, endBuzzMembership, hasModeratorGrant } = vi.hoisted(() => ({
  mockAudit: vi.fn(),
  session: {
    user: { id: 990000007, isModerator: true, permissions: [], bannedAt: null } as Record<
      string,
      unknown
    >,
  },
  endBuzzMembership: vi.fn<(...a: unknown[]) => Promise<Record<string, unknown>>>(async () => ({
    subscriptionId: 'buzz-membership:8675309:civitai-buzz-bronze-monthly:yellow:2026-10-08',
    previousStatus: 'active',
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
vi.mock('~/server/services/subscriptions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SubscriptionsService>()),
  endBuzzMembership: (...a: unknown[]) => endBuzzMembership(...a),
}));
vi.mock('~/server/services/moderator-grants', () => ({
  hasModeratorGrant: (...a: unknown[]) => hasModeratorGrant(...a),
}));

import handler from '~/pages/api/mod/user/buzz-membership-end';
const TARGET = 8675309;
const VALID = { userId: TARGET, reason: 'Buzz refunded by support' };

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
    expect(endBuzzMembership).not.toHaveBeenCalled();
  });

  it('refuses a signed-in non-moderator', async () => {
    session.user = { id: 990000099, isModerator: false, permissions: [], bannedAt: null };
    const { status } = await call(VALID);
    expect(status).toBe(403);
    expect(endBuzzMembership).not.toHaveBeenCalled();
  });

  it('control: a permitted moderator ends it, as themselves', async () => {
    const { status, body } = await call({ ...VALID, moderatorId: 1 });
    expect(status).toBe(200);
    expect(endBuzzMembership).toHaveBeenCalledWith({ userId: TARGET, moderatorId: 990000007 });
    expect(body).toMatchObject({ previousStatus: 'active' });
  });
});

describe('input', () => {
  it.each([
    ['no reason', { reason: undefined }],
    ['a blank reason', { reason: '   ' }],
    ['no userId', { userId: undefined }],
  ])('refuses %s with a 400', async (_l, patch) => {
    const { status } = await call({ ...VALID, ...patch });
    expect(status).toBe(400);
    expect(endBuzzMembership).not.toHaveBeenCalled();
  });

  it('no Buzz membership to end is a 404 with its message intact', async () => {
    endBuzzMembership.mockRejectedValueOnce(
      new TRPCError({
        code: 'NOT_FOUND',
        message: 'This account has no Buzz-purchased membership to end.',
      })
    );
    const { status, body } = await call(VALID);
    expect(status).toBe(404);
    expect(body).toMatchObject({
      message: 'This account has no Buzz-purchased membership to end.',
    });
  });
});
