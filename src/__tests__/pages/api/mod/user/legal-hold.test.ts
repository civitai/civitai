import { Prisma } from '@prisma/client';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * `GET /api/mod/user/legal-hold`, which the moderator app reads to enable or disable Delete account.
 * Runs over the real hold service; only the database answer is faked. The moderator app treats
 * anything but `held: false` as held, so the shape is pinned exactly.
 */

const { session } = vi.hoisted(() => ({
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
    retoolAudit = vi.fn();
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
const hasModeratorGrant = vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true);
vi.mock('~/server/services/moderator-grants', () => ({
  hasModeratorGrant: (...a: unknown[]) => hasModeratorGrant(...a),
}));

import handler from '~/pages/api/mod/user/legal-hold';

const TARGET = 8675309;
const CLEAR = {
  report: false,
  'image-review': false,
  'image-blocked': false,
  'reported-image': false,
  markerView: false,
  markerTable: false,
};

function call(query: Record<string, unknown>) {
  const req = { method: 'GET', headers: {}, body: {}, query } as Parameters<typeof handler>[0];
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
  hasModeratorGrant.mockImplementation(async () => true);
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockResolvedValue([CLEAR] as never);
});

describe('user.legalHold', () => {
  it('answers held: false for an account no hold covers, for that account', async () => {
    const { status, body } = await call({ userId: String(TARGET) });

    expect(status).toBe(200);
    expect(body).toEqual({ userId: TARGET, held: false });
    const [strings, ...values] = vi.mocked(dbMock.dbWrite.$queryRaw).mock.calls[0] as [
      TemplateStringsArray,
      ...never[]
    ];
    const ids = Prisma.sql(strings, ...values).values.filter((v) => typeof v === 'number');
    expect(new Set(ids)).toEqual(new Set([TARGET]));
  });

  it('answers held: true for a held account, and nothing about why', async () => {
    vi.mocked(dbMock.dbWrite.$queryRaw).mockResolvedValue([
      { ...CLEAR, 'image-review': true },
    ] as never);

    const { body } = await call({ userId: String(TARGET) });

    expect(body).toEqual({ userId: TARGET, held: true });
  });

  it('answers held: null, not false, when the lookup fails', async () => {
    vi.mocked(dbMock.dbWrite.$queryRaw).mockRejectedValue(new Error('connection reset'));

    const { status, body } = await call({ userId: String(TARGET) });

    expect(status).toBe(200);
    expect(body).toEqual({ userId: TARGET, held: null });
  });

  it('refuses a moderator with neither grant, before looking anything up', async () => {
    hasModeratorGrant.mockResolvedValue(false);

    const { status, body } = await call({ userId: String(TARGET) });

    expect(status).toBe(403);
    expect(JSON.stringify(body)).not.toContain('held');
    expect(hasModeratorGrant).toHaveBeenCalledWith(expect.anything(), 'user.deleteAccount');
    expect(hasModeratorGrant).toHaveBeenCalledWith(expect.anything(), 'user.purge');
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it.each(['user.deleteAccount', 'user.purge'])(
    'answers a moderator who holds only %s',
    async (grant) => {
      hasModeratorGrant.mockImplementation(async (_actor, id) => id === grant);

      const { status, body } = await call({ userId: String(TARGET) });

      expect(status).toBe(200);
      expect(body).toEqual({ userId: TARGET, held: false });
    }
  );
});
