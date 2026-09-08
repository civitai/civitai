import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/db.mock';
import { modelsFilterableAttributes } from '~/server/search-index/filterable-attributes';

/**
 * This endpoint is the only in-repo way to apply `modelsFilterableAttributes` to the LIVE models
 * index without a full rebuild, and Meilisearch reindexes the filterable fields across every
 * document when the list changes — an unmeasured cost on ~705K documents.
 *
 * So what is pinned here is that it is INERT unless someone explicitly asks for the write, and that
 * the write it makes is the whole desired list. `updateFilterableAttributes` REPLACES rather than
 * merges, so writing anything narrower silently strips the rest of the index's filterable
 * attributes and every models search then answers 400 invalid_search_filter.
 */

const { env, getFilterableAttributes, updateFilterableAttributes, getTasks, index } = vi.hoisted(
  () => {
    const getFilterableAttributes = vi.fn(async () => ['id', 'nsfwLevel'] as string[]);
    const updateFilterableAttributes = vi.fn(async () => ({ taskUid: 99 }));
    const getTasks = vi.fn(async () => ({ results: [] as { uid: number }[] }));
    return {
      env: {
        WEBHOOK_TOKEN: 'test-token',
        LOGGING: '',
        NEXTAUTH_URL: 'https://example.test',
        TRPC_ORIGINS: [] as string[],
      },
      getFilterableAttributes,
      updateFilterableAttributes,
      getTasks,
      index: vi.fn(() => ({ getFilterableAttributes, updateFilterableAttributes, getTasks })),
    };
  }
);

vi.mock('~/env/server', () => ({ env }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/meilisearch/client', () => ({
  searchClient: { index },
  metricsSearchClient: null,
}));

const handler = (await import('~/pages/api/admin/temp/apply-models-index-filterable-attributes'))
  .default;

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

describe('apply-models-index-filterable-attributes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getFilterableAttributes.mockResolvedValue(['id', 'nsfwLevel']);
    getTasks.mockResolvedValue({ results: [] });
  });

  it('rejects a call with the wrong token, and writes nothing', async () => {
    // Deleting the WebhookEndpoint wrapper makes this route world-callable, and every other test
    // here passes a valid token, so nothing else can see it.
    const { statusCode } = await call({ dryRun: 'false' }, 'wrong');

    expect(statusCode).toBe(401);
    expect(updateFilterableAttributes).not.toHaveBeenCalled();
  });

  it('writes NOTHING by default', async () => {
    const { payload } = await call({});

    expect(payload.dryRun).toBe(true);
    expect(payload.missing).toContain('hasActivePaidAccess');
    expect(updateFilterableAttributes).not.toHaveBeenCalled();
  });

  it('writes the WHOLE desired list, because the call replaces rather than merges', async () => {
    // toContain would pass on `updateFilterableAttributes(missing)`, which reads like the obvious
    // edit and strips every other filterable attribute from the live index.
    const { payload } = await call({ dryRun: 'false' });

    expect(updateFilterableAttributes).toHaveBeenCalledTimes(1);
    expect(updateFilterableAttributes.mock.calls[0][0]).toEqual([...modelsFilterableAttributes]);
    expect(payload.taskUid).toBe(99);
  });

  it('does not write when the live list already matches', async () => {
    getFilterableAttributes.mockResolvedValue([...modelsFilterableAttributes]);

    const { payload } = await call({ dryRun: 'false' });

    expect(payload.unchanged).toBe(true);
    expect(updateFilterableAttributes).not.toHaveBeenCalled();
  });

  it('REFUSES a write that would remove an attribute the live index has', async () => {
    // Drift is not directional. Removing a filterable attribute makes every query using it answer
    // 400, and undoing that costs a second full reindex.
    getFilterableAttributes.mockResolvedValue(['id', 'somethingElse']);

    const { statusCode, payload } = await call({ dryRun: 'false' });

    expect(statusCode).toBe(409);
    expect(payload.extra).toEqual(['somethingElse']);
    expect(updateFilterableAttributes).not.toHaveBeenCalled();
  });

  it('permits the removal only when allowRemove is passed', async () => {
    getFilterableAttributes.mockResolvedValue(['id', 'somethingElse']);

    await call({ dryRun: 'false', allowRemove: 'true' });

    expect(updateFilterableAttributes).toHaveBeenCalledTimes(1);
  });

  it('REFUSES a second write while a settings task is still enqueued', async () => {
    // getFilterableAttributes reports what is APPLIED, so during the enqueue-to-applied window a
    // second call sees the same `missing` and would enqueue a second full reindex. There is no
    // method guard on the route, so a browser reload is enough to do it.
    getTasks.mockResolvedValue({ results: [{ uid: 7 }] });

    const { statusCode, payload } = await call({ dryRun: 'false' });

    expect(statusCode).toBe(409);
    expect(payload.pending).toEqual([7]);
    expect(updateFilterableAttributes).not.toHaveBeenCalled();
  });

  it('permits it only when force is passed', async () => {
    getTasks.mockResolvedValue({ results: [{ uid: 7 }] });

    await call({ dryRun: 'false', force: 'true' });

    expect(updateFilterableAttributes).toHaveBeenCalledTimes(1);
  });
});
