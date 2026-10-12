import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as ClickhouseModule from '~/server/clickhouse/client';
import type * as ModeModule from '~/server/services/text-scan/mode';

const { session, mockAudit } = vi.hoisted(() => ({
  session: { current: null as null | { user: Record<string, unknown> } },
  mockAudit: vi.fn(),
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
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(),
}));

const handler = (await import('~/pages/api/admin/temp/text-scan-clavata-cutover')).default;
const { getTextScanMode } = await import('~/server/services/text-scan/mode');

function run(body: unknown) {
  const req = { method: 'POST', query: {}, headers: {}, body };
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

beforeEach(() => {
  vi.clearAllMocks();
  session.current = { user: { id: 990000456, isModerator: true, bannedAt: null, permissions: [] } };
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
  vi.mocked(dbMock.dbRead.post.findMany).mockResolvedValue([{ id: 3 }] as never);
});

describe('text-scan-clavata-cutover endpoint', () => {
  it('refuses a caller who is not a moderator', async () => {
    session.current = { user: { id: 5, isModerator: false, bannedAt: null } };
    expect((await run({ action: 'status' })).status).toBe(403);
  });

  it('answers a refused disable with a 409 and an error audit row, writing nothing', async () => {
    vi.mocked(getTextScanMode).mockResolvedValue('shadow');
    const res = await run({ action: 'disable', entityType: 'Post' });
    expect(res.status).toBe(409);
    expect(redisMock.sysRedis.hSet).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'textScan.clavataCutover', outcome: 'error' })
    );
  });

  it('rejects Challenge, which Clavata never scanned', async () => {
    expect((await run({ action: 'disable', entityType: 'Challenge' })).status).toBe(400);
  });

  it('returns the status rows under targets', async () => {
    const res = await run({ action: 'status' });
    expect(res.status).toBe(200);
    expect(res.body.targets).toHaveLength(12);
  });
});
