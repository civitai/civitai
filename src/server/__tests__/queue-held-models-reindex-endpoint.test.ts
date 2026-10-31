import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Harness from queue-paid-models-reindex-endpoint.test.ts.
const { env, queueUpdate, getQueue } = vi.hoisted(() => ({
  env: {
    WEBHOOK_TOKEN: 'test-token',
    LOGGING: '',
    NEXTAUTH_URL: 'https://example.test',
    TRPC_ORIGINS: [] as string[],
  },
  queueUpdate: vi.fn(async () => undefined),
  getQueue: vi.fn(async () => ({ content: [] as number[], commit: async () => undefined })),
}));

vi.mock('~/env/server', () => ({ env }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: { queueUpdate } }));
vi.mock('~/server/search-index/SearchIndexUpdate', () => ({ SearchIndexUpdate: { getQueue } }));

const handler = (await import('~/pages/api/admin/temp/queue-held-models-reindex')).default;

function call(query: Record<string, string>, token = 'test-token') {
  const req = { method: 'POST', query: { token, ...query }, headers: {} } as never;
  let statusCode = 0;
  let payload: Record<string, unknown> | undefined;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: Record<string, unknown>) {
      payload = data;
      return res;
    },
    send: () => res,
    setHeader: () => res,
    end: () => res,
  };
  return handler(req, res as never).then(() => ({ statusCode, payload }));
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.model.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
});

describe('queue-held-models-reindex', () => {
  it('selects published minor or SFW-only models', async () => {
    await call({});
    expect(dbMock.dbRead.model.findMany.mock.calls[0][0].where).toEqual({
      status: 'Published',
      OR: [{ minor: true }, { sfwOnly: true }],
    });
  });

  it('only reports on a dry run, the default', async () => {
    const { payload } = await call({});
    expect(payload).toMatchObject({ dryRun: true, heldModelCount: 2 });
    expect(queueUpdate).not.toHaveBeenCalled();
  });

  it('queues each held model for a rewrite when asked', async () => {
    getQueue.mockResolvedValueOnce({ content: [], commit: async () => undefined });
    getQueue.mockResolvedValueOnce({ content: [1, 2], commit: async () => undefined });
    const { payload } = await call({ dryRun: 'false' });
    expect(queueUpdate).toHaveBeenCalledWith([
      { id: 1, action: 'Update' },
      { id: 2, action: 'Update' },
    ]);
    expect(payload).toMatchObject({ landed: 2 });
  });

  it('queues the ids in chunks of chunkSize, each id once', async () => {
    dbMock.dbRead.model.findMany.mockResolvedValue([1, 2, 3, 4, 5, 6, 7].map((id) => ({ id })));
    await call({ dryRun: 'false', chunkSize: '3' });
    expect(
      queueUpdate.mock.calls.map(([items]) => (items as { id: number }[]).map((x) => x.id))
    ).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });

  it('reads the queue without taking work from the scheduled sync', async () => {
    await call({ dryRun: 'false' });
    expect(getQueue).toHaveBeenCalledTimes(2);
    for (const args of getQueue.mock.calls as unknown[][]) expect(args[2]).toBe(true);
  });

  it('refuses a call without the token, and queues nothing', async () => {
    const { statusCode } = await call({ dryRun: 'false' }, 'wrong');
    expect(statusCode).toBe(401);
    expect(queueUpdate).not.toHaveBeenCalled();
  });

  it('refuses a dry run with a missing token, and reads nothing', async () => {
    const { statusCode } = await call({}, '');
    expect(statusCode).toBe(401);
    expect(dbMock.dbRead.model.findMany).not.toHaveBeenCalled();
  });
});
