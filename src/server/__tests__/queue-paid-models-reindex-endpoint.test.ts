import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/db.mock';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';

/**
 * The endpoint exists because `addToQueue` FAILS OPEN: on a degraded sysRedis it parks the ids in
 * Postgres and returns false, and neither `SearchIndexUpdate.queueUpdate` nor
 * `modelsSearchIndex.queueUpdate` propagates that boolean. So "the call resolved" is not evidence
 * the ids are queued.
 *
 * What is pinned here is that `landed` comes from READING THE QUEUE BACK. The two fixtures below
 * deliberately make queue depth and our-ids-landed DIFFERENT numbers — when they were equal, a
 * handler returning `after.length` passed both the landed-3 and the landed-0 case and the pair only
 * looked like a control.
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

const queued = (q: { content: number[] }) => ({ ...q, commit: async () => undefined });

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
  return handler(req, res as never).then(() => ({
    statusCode,
    payload: payload as Record<string, unknown>,
  }));
}

describe('queue-paid-models-reindex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // reset, not clear: clearAllMocks leaves a queued mockResolvedValueOnce behind, and a leaked
    // once-value surfaces as a failure in the NEXT test, which misattributes the cause.
    getQueue.mockReset();
    queryGatedModelIds.mockResolvedValue([1, 2, 3]);
    getQueue.mockResolvedValue(queued({ content: [] }));
  });

  it('rejects a call with the wrong token, and queues nothing', async () => {
    // Deleting the WebhookEndpoint wrapper leaves this route world-callable, and every other test
    // here passes a valid token, so nothing else can see it.
    const { statusCode } = await call({}, 'wrong');

    expect(statusCode).toBe(401);
    expect(queryGatedModelIds).not.toHaveBeenCalled();
    expect(queueUpdate).not.toHaveBeenCalled();
  });

  it('reads the models Update queue NON-destructively', async () => {
    // The third argument is readOnly. Passed as false — or omitted, since the real signature
    // defaults it to false — this endpoint checks the queue out destructively and consumes the
    // pending work the 15-minute sync was about to take, on every call including the dry run.
    await call({});

    expect(getQueue.mock.calls[0]).toEqual([MODELS_SEARCH_INDEX, 'Update', true]);
  });

  it('defaults to a dry run and queues nothing', async () => {
    getQueue.mockResolvedValue(queued({ content: [2, 777] }));

    const { statusCode, payload } = await call({});

    expect(statusCode).toBe(200);
    expect(payload.dryRun).toBe(true);
    expect(payload.gatedModelCount).toBe(3);
    expect(payload.queueDepthBefore).toBe(2);
    // Of ours, only id 2 is already queued — 777 belongs to another producer. A negation slip here
    // reports 2 and tells an operator the work is already done.
    expect(payload.alreadyQueued).toBe(1);
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
      .mockResolvedValueOnce(queued({ content: [] }))
      .mockResolvedValueOnce(queued({ content: [1, 2, 3] }));

    const { payload } = await call({ dryRun: 'false' });

    const items = queueUpdate.mock.calls.flatMap((c) => c[0] as { id: number; action: string }[]);
    expect(items.map((x) => x.id)).toEqual([1, 2, 3]);
    expect(new Set(items.map((x) => x.action))).toEqual(new Set(['Update']));
    expect(payload.landed).toBe(3);
  });

  it('counts OUR ids as landed, not the queue depth', async () => {
    // The queue also holds a foreign id, so landed (3) and queueDepthAfter (4) disagree. With the
    // two equal, `landed = after.length` passed every case here.
    getQueue
      .mockResolvedValueOnce(queued({ content: [] }))
      .mockResolvedValueOnce(queued({ content: [1, 2, 3, 999] }));

    const { payload } = await call({ dryRun: 'false' });

    expect(payload.landed).toBe(3);
    expect(payload.queueDepthAfter).toBe(4);
  });

  it('chunks by chunkSize rather than queueing only the first chunk', async () => {
    // slice(i, chunkSize) instead of slice(i, i + chunkSize) — the standard slice-arguments slip —
    // is invisible at the default chunk size, because three ids fit in one iteration.
    getQueue
      .mockResolvedValueOnce(queued({ content: [] }))
      .mockResolvedValueOnce(queued({ content: [1, 2, 3] }));

    await call({ dryRun: 'false', chunkSize: '2' });

    const batches = queueUpdate.mock.calls.map((c) => (c[0] as { id: number }[]).map((x) => x.id));
    expect(batches).toEqual([[1, 2], [3]]);
  });

  it('reports landed 0 when the enqueue silently dropped every id', async () => {
    // The fail-open shape: queueUpdate resolves, and the queue is still empty afterwards. A handler
    // that inferred success from the call returning would report 3 here.
    getQueue.mockResolvedValue(queued({ content: [] }));

    const { payload } = await call({ dryRun: 'false' });

    expect(queueUpdate).toHaveBeenCalled();
    expect(payload.gatedModelCount).toBe(3);
    expect(payload.landed).toBe(0);
  });
});
