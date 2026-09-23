import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/db.mock';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { modelsFilterableAttributes } from '~/server/search-index/filterable-attributes';

/**
 * This endpoint is the only in-repo way to apply `modelsFilterableAttributes` to the LIVE models
 * index without a full rebuild, and Meilisearch reindexes the filterable fields across every
 * document when the list changes — unmeasured on ~705K documents.
 *
 * Two properties are pinned: it is INERT unless someone explicitly asks for the write, and the
 * write it makes is the whole desired list ON THE MODELS INDEX. `updateFilterableAttributes`
 * REPLACES rather than merges, so writing anything narrower — or writing to the wrong index —
 * silently strips that index's filterable attributes and every search on it then answers
 * 400 invalid_search_filter.
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
    getTasks.mockReset();
    getTasks.mockResolvedValue({ results: [] });
  });

  it('rejects a call with the wrong token, and writes nothing', async () => {
    const { statusCode } = await call({ dryRun: 'false' }, 'wrong');

    expect(statusCode).toBe(401);
    expect(updateFilterableAttributes).not.toHaveBeenCalled();
  });

  it('targets the MODELS index', async () => {
    // Retargeting this at another index passes every other assertion in this file while wiping that
    // index's filterable attributes in production.
    await call({});

    expect(index).toHaveBeenCalledWith(MODELS_SEARCH_INDEX);
  });

  it('asks only for PENDING SETTINGS tasks when deciding whether one is in flight', async () => {
    // Point this at another type or drop 'processing' and the double-reindex guard silently stops
    // guarding, while the 409 test below keeps passing on its canned result.
    await call({});

    expect(getTasks.mock.calls[0][0]).toEqual({
      statuses: ['enqueued', 'processing'],
      types: ['settingsUpdate'],
    });
  });

  it('writes NOTHING by default', async () => {
    const { payload } = await call({});

    expect(payload.dryRun).toBe(true);
    expect(payload.missing).toContain('hasActivePaidAccess');
    expect(updateFilterableAttributes).not.toHaveBeenCalled();
  });

  it('still answers the dry run when the tasks API is unreachable', async () => {
    // A key without tasks.get would otherwise take out the read-only path too. null means "did not
    // determine", which is distinct from [] meaning "checked, nothing pending".
    getTasks.mockRejectedValue(new Error('403 forbidden'));

    const { statusCode, payload } = await call({});

    expect(statusCode).toBe(200);
    expect(payload.pending).toBeNull();
    expect(updateFilterableAttributes).not.toHaveBeenCalled();
  });

  it('REFUSES the write when it cannot tell whether a settings task is pending', async () => {
    getTasks.mockRejectedValue(new Error('403 forbidden'));

    const { statusCode } = await call({ dryRun: 'false' });

    expect(statusCode).toBe(409);
    expect(updateFilterableAttributes).not.toHaveBeenCalled();
  });

  it('writes the WHOLE desired list, because the call replaces rather than merges', async () => {
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

  it('permits the removal only with allowRemove, and actually removes', async () => {
    // Asserting only that a write happened let `[...desired, ...extra]` pass — which reports
    // `removed` while removing nothing, so an operator re-runs forever.
    getFilterableAttributes.mockResolvedValue(['id', 'somethingElse']);

    const { payload } = await call({ dryRun: 'false', allowRemove: 'true' });

    expect(updateFilterableAttributes.mock.calls[0][0]).toEqual([...modelsFilterableAttributes]);
    expect(payload.removed).toEqual(['somethingElse']);
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

  it('permits it only with force, and still writes the whole list', async () => {
    // Production shape: the live index has everything except the one new attribute, so `added` is
    // exactly that attribute rather than the 20 the default fixture is missing.
    getFilterableAttributes.mockResolvedValue(
      modelsFilterableAttributes.filter((a) => a !== 'hasActivePaidAccess')
    );
    getTasks.mockResolvedValue({ results: [{ uid: 7 }] });

    const { payload } = await call({ dryRun: 'false', force: 'true' });

    expect(updateFilterableAttributes.mock.calls[0][0]).toEqual([...modelsFilterableAttributes]);
    expect(payload.added).toEqual(['hasActivePaidAccess']);
  });
});
