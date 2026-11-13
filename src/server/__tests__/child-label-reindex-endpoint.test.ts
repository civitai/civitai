import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/db.mock';

/** The route's own contract: token auth, dryRun on by default, and a validated query. */

const { env, runChildLabelReindex } = vi.hoisted(() => ({
  env: {
    WEBHOOK_TOKEN: 'test-token',
    LOGGING: '',
    NEXTAUTH_URL: 'https://example.test',
    TRPC_ORIGINS: [] as string[],
  },
  runChildLabelReindex: vi.fn(async (opts: Record<string, unknown>) => opts),
}));

vi.mock('~/env/server', () => ({ env }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/services/child-label-reindex.service', () => ({ runChildLabelReindex }));

const handler = (await import('~/pages/api/admin/temp/child-label-reindex')).default;

function call(query: Record<string, string>, token = 'test-token') {
  const req = { method: 'POST', query: { token, ...query }, headers: {} } as never;
  let statusCode = 0;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json: () => res,
    send: () => res,
    setHeader: () => res,
    end: () => res,
  };
  return handler(req, res as never).then(() => statusCode);
}

describe('child-label-reindex route', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a wrong token and runs nothing', async () => {
    expect(await call({ step: 'bust', dryRun: 'false' }, 'wrong')).toBe(401);
    expect(runChildLabelReindex).not.toHaveBeenCalled();
  });

  it('runs dry when dryRun is not given', async () => {
    expect(await call({ step: 'bust' })).toBe(200);
    expect(runChildLabelReindex).toHaveBeenCalledWith({
      step: 'bust',
      dryRun: true,
      chunkSize: 500,
      after: 0,
    });
  });

  it('refuses a missing step or an oversized chunk', async () => {
    expect(await call({})).toBe(400);
    expect(await call({ step: 'bust', chunkSize: '5001' })).toBe(400);
    expect(await call({ step: 'bust', chunkSize: '2.5' })).toBe(400);
    expect(runChildLabelReindex).not.toHaveBeenCalled();
  });

  it('passes a real run through', async () => {
    expect(
      await call({ step: 'bust', dryRun: 'false', chunkSize: '200', after: '7', maxChunks: '3' })
    ).toBe(200);
    expect(runChildLabelReindex).toHaveBeenCalledWith({
      step: 'bust',
      dryRun: false,
      chunkSize: 200,
      after: 7,
      maxChunks: 3,
    });
  });
});
