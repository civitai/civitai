import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as ClickhouseModule from '~/server/clickhouse/client';

const { session, run: runBackfill } = vi.hoisted(() => ({
  session: { current: null as null | { user: Record<string, unknown> } },
  run: vi.fn(),
}));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: vi.fn() }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => session.current),
}));
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseModule>()),
  Tracker: class {
    retoolAudit = vi.fn();
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/text-scan/article-category-backfill', () => ({
  runArticleCategoryBackfill: runBackfill,
}));

const handler = (await import('~/pages/api/admin/temp/article-category-backfill')).default;

async function post(body: unknown) {
  let statusCode = 200;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json: () => res,
    setHeader: vi.fn(),
    end: () => res,
  };
  await handler({ method: 'POST', query: {}, headers: {}, body } as never, res as never);
  return statusCode;
}

beforeEach(() => {
  vi.clearAllMocks();
  session.current = { user: { id: 990000321, isModerator: true, bannedAt: null, permissions: [] } };
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
  runBackfill.mockResolvedValue({});
});

describe('article-category-backfill endpoint', () => {
  it('an empty body is a dry run, so an omitted flag bills nothing', async () => {
    expect(await post({})).toBe(200);
    expect(runBackfill).toHaveBeenCalledWith({
      afterId: 0,
      limit: 100,
      concurrency: 2,
      dryRun: true,
    });
  });
});
