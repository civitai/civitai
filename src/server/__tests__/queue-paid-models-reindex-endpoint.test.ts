import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/db.mock';

/**
 * The endpoint exists because `addToQueue` FAILS OPEN: on a degraded sysRedis it parks the ids in
 * Postgres and returns false, and neither `SearchIndexUpdate.queueUpdate` nor
 * `modelsSearchIndex.queueUpdate` propagates that boolean. So "the call resolved" is not evidence
 * the ids are queued.
 *
 * What is pinned here is that the response's `landed` count comes from READING THE QUEUE BACK, not
 * from the call returning — the last test drives exactly the fail-open shape and expects landed 0
 * while the call resolves normally.
 */

const { env, queryGatedModelIds, queueUpdate, getQueue } = vi.hoisted(() => ({
  env: {
    WEBHOOK_TOKEN: 'test-token',
    LOGGING: '',
    NEXTAUTH_URL: 'https://example.test',
    TRPC_ORIGINS: [] as string[],
  },
  queryGatedModelIds: vi.fn(async () => [1, 2, 3]),
  queueUpdate: vi.fn(async () => undefined),
  getQueue: vi.fn(async () => ({ content: [] as number[], commit: async () => undefined })),
}));

vi.mock('~/env/server', () => ({ env }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/services/paid-access.service', () => ({ queryGatedModelIds }));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: { queueUpdate } }));
vi.mock('~/server/search-index/SearchIndexUpdate', () => ({ SearchIndexUpdate: { getQueue } }));

const handler = (await import('~/pages/api/admin/temp/queue-paid-models-reindex')).default;

function call(query: Record<string, string>) {
  const req = { method: 'POST', query: { token: 'test-token', ...query }, headers: {} } as never;
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
    setHeader: () => res,
    end: () => res,
  };
  return handler(req, res as never).then(() => ({
    statusCode,
    payload: payload as Record<string, unknown>,
  }));
}

describe('queue-paid-models-reindex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryGatedModelIds.mockResolvedValue([1, 2, 3]);
    getQueue.mockResolvedValue({ content: [], commit: async () => undefined });
  });

  it('defaults to a dry run and queues nothing', async () => {
    const { statusCode, payload } = await call({});

    expect(statusCode).toBe(200);
    expect(payload.dryRun).toBe(true);
    expect(payload.gatedModelCount).toBe(3);
    expect(queueUpdate).not.toHaveBeenCalled();
  });

  it('reads the gated ids UNCACHED, so a stale cached set cannot decide the backfill', async () => {
    // `getGatedModelIds` is the cached entry point and carries a live TTL; a reindex must see the
    // set as it is now. Swap the call and this mock is never reached.
    await call({});

    expect(queryGatedModelIds).toHaveBeenCalledTimes(1);
  });

  it('queues every gated id as an Update when dryRun=false', async () => {
    getQueue
      .mockResolvedValueOnce({ content: [], commit: async () => undefined })
      .mockResolvedValueOnce({ content: [1, 2, 3], commit: async () => undefined });

    const { payload } = await call({ dryRun: 'false' });

    const queued = queueUpdate.mock.calls.flatMap((c) => c[0] as { id: number; action: string }[]);
    expect(queued.map((x) => x.id)).toEqual([1, 2, 3]);
    expect(new Set(queued.map((x) => x.action))).toEqual(new Set(['Update']));
    expect(payload.landed).toBe(3);
  });

  it('rejects a call with the wrong token, and queues nothing', async () => {
    // Deleting the WebhookEndpoint wrapper leaves both routes world-callable, and every other test
    // here passes a valid token, so nothing else can see it.
    const req = { method: 'POST', query: { token: 'wrong' }, headers: {} } as never;
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
    await handler(req, res as never);

    expect(statusCode).toBe(401);
    expect(queryGatedModelIds).not.toHaveBeenCalled();
    expect(queueUpdate).not.toHaveBeenCalled();
  });

  it('chunks by chunkSize rather than queueing only the first chunk', async () => {
    // slice(i, chunkSize) instead of slice(i, i + chunkSize) — the standard slice-arguments slip —
    // is invisible at the default chunk size, because three ids fit in one iteration.
    getQueue
      .mockResolvedValueOnce({ content: [], commit: async () => undefined })
      .mockResolvedValueOnce({ content: [1, 2, 3], commit: async () => undefined });

    await call({ dryRun: 'false', chunkSize: '2' });

    const batches = queueUpdate.mock.calls.map((c) => (c[0] as { id: number }[]).map((x) => x.id));
    expect(batches).toEqual([[1, 2], [3]]);
  });

  it('reports landed 0 when the enqueue silently dropped every id', async () => {
    // The fail-open shape: queueUpdate resolves, and the queue is still empty afterwards. A handler
    // that inferred success from the call returning would report 3 here.
    getQueue.mockResolvedValue({ content: [], commit: async () => undefined });

    const { payload } = await call({ dryRun: 'false' });

    expect(queueUpdate).toHaveBeenCalled();
    expect(payload.gatedModelCount).toBe(3);
    expect(payload.landed).toBe(0);
  });
});
