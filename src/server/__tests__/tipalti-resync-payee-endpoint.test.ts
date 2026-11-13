import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as ClickhouseModule from '~/server/clickhouse/client';
import type * as ResyncModule from '~/server/services/tipalti-payee-resync.service';

const { session, mockAudit, resync } = vi.hoisted(() => ({
  session: { current: null as null | { user: Record<string, unknown> } },
  mockAudit: vi.fn(),
  resync: vi.fn(),
}));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: vi.fn() }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => session.current),
}));
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseModule>()),
  Tracker: class {
    retoolAudit = mockAudit;
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/tipalti-payee-resync.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ResyncModule>()),
  resyncTipaltiPayees: resync,
}));

const handler = (await import('~/pages/api/mod/tipalti-resync-payee')).default;

function call(method: string, query: Record<string, string>) {
  const req = { method, query, headers: {}, body: {} };
  let statusCode = 200;
  let payload: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: unknown) {
      payload = data;
      return res;
    },
    setHeader: vi.fn(),
    end: () => res,
  };
  return Promise.resolve(handler(req as never, res as never)).then(() => ({
    status: statusCode,
    body: payload as Record<string, unknown>,
  }));
}

const MOD = 990000321;
beforeEach(() => {
  vi.clearAllMocks();
  resync.mockResolvedValue([]);
  session.current = { user: { id: MOD, isModerator: true, bannedAt: null, permissions: [] } };
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('/api/mod/tipalti-resync-payee', () => {
  it('is a dry run unless execute=true', async () => {
    const { status } = await call('POST', { userIds: '7' });

    expect(status).toBe(200);
    expect(resync).toHaveBeenCalledWith({ userIds: [7], dryRun: true, actorId: MOD });
  });

  it('writes with execute=true, as the calling moderator', async () => {
    await call('POST', { userIds: '7,8', execute: 'true' });

    expect(resync).toHaveBeenCalledWith({ userIds: [7, 8], dryRun: false, actorId: MOD });
  });

  it('refuses a GET, so a link can never reach Tipalti or write', async () => {
    const { status } = await call('GET', { userIds: '7', execute: 'true' });

    expect(status).toBe(405);
    expect(resync).not.toHaveBeenCalled();
  });

  it('rejects the whole call on a bad id', async () => {
    const { status } = await call('POST', { userIds: '7,7', execute: 'true' });

    expect(status).toBe(400);
    expect(resync).not.toHaveBeenCalled();
  });

  it('refuses a non-moderator', async () => {
    session.current = { user: { id: 5, isModerator: false, bannedAt: null, permissions: [] } };

    const { status } = await call('POST', { userIds: '7', execute: 'true' });

    expect(status).toBeGreaterThanOrEqual(401);
    expect(resync).not.toHaveBeenCalled();
  });
});
