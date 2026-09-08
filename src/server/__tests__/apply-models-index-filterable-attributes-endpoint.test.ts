import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/db.mock';

/**
 * This endpoint is the only in-repo way to apply `modelsFilterableAttributes` to the LIVE models
 * index without a full rebuild, and Meilisearch reindexes the filterable fields across every
 * document when the list changes — an unmeasured cost on ~705K documents.
 *
 * So the property that matters is that it is INERT unless someone explicitly asks for the write.
 * `dryRun` defaults to true; these fail if that default is ever flipped or the guard removed.
 */

const { env, getFilterableAttributes, updateFilterableAttributes, index } = vi.hoisted(() => {
  const getFilterableAttributes = vi.fn(async () => ['id', 'nsfwLevel'] as string[]);
  const updateFilterableAttributes = vi.fn(async () => ({ taskUid: 99 }));
  return {
    env: {
      WEBHOOK_TOKEN: 'test-token',
      LOGGING: '',
      NEXTAUTH_URL: 'https://example.test',
      TRPC_ORIGINS: [] as string[],
    },
    getFilterableAttributes,
    updateFilterableAttributes,
    index: vi.fn(() => ({ getFilterableAttributes, updateFilterableAttributes })),
  };
});

vi.mock('~/env/server', () => ({ env }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/meilisearch/client', () => ({
  searchClient: { index },
  metricsSearchClient: null,
}));

const handler = (await import('~/pages/api/admin/temp/apply-models-index-filterable-attributes'))
  .default;

function call(query: Record<string, string>) {
  const req = { method: 'POST', query: { token: 'test-token', ...query }, headers: {} } as never;
  let payload: Record<string, unknown> | undefined;
  const res = {
    status: () => res,
    json(data: Record<string, unknown>) {
      payload = data;
      return res;
    },
    setHeader: () => res,
    end: () => res,
  };
  return handler(req, res as never).then(() => payload as Record<string, unknown>);
}

describe('apply-models-index-filterable-attributes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes NOTHING by default', async () => {
    const payload = await call({});

    expect(payload.dryRun).toBe(true);
    expect(payload.missing).toContain('hasActivePaidAccess');
    expect(updateFilterableAttributes).not.toHaveBeenCalled();
  });

  it('writes only when dryRun is explicitly false, and returns the task to poll', async () => {
    const payload = await call({ dryRun: 'false' });

    expect(updateFilterableAttributes).toHaveBeenCalledTimes(1);
    expect(updateFilterableAttributes.mock.calls[0][0]).toContain('hasActivePaidAccess');
    expect(payload.taskUid).toBe(99);
  });

  it('does not write when the live list already matches', async () => {
    const { modelsFilterableAttributes } = await import(
      '~/server/search-index/filterable-attributes'
    );
    getFilterableAttributes.mockResolvedValueOnce([...modelsFilterableAttributes]);

    const payload = await call({ dryRun: 'false' });

    expect(payload.unchanged).toBe(true);
    expect(updateFilterableAttributes).not.toHaveBeenCalled();
  });
});
