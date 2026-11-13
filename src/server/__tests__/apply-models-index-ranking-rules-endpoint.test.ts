import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/db.mock';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { modelsRankingRules } from '~/server/search-index/ranking-rules';
import { modelSearchIndexSelect } from '~/server/selectors/model.selector';

const OLD_RULES = [
  'sort',
  'attribute',
  'metrics.thumbsUpCount:desc',
  'words',
  'proximity',
  'exactness',
];

const { env, getRankingRules, updateRankingRules, getTasks, index } = vi.hoisted(() => {
  const getRankingRules = vi.fn(async () => [] as string[]);
  const updateRankingRules = vi.fn(async () => ({ taskUid: 99 }));
  const getTasks = vi.fn(async () => ({ results: [] as { uid: number }[] }));
  return {
    env: {
      WEBHOOK_TOKEN: 'test-token',
      LOGGING: '',
      NEXTAUTH_URL: 'https://example.test',
      TRPC_ORIGINS: [] as string[],
    },
    getRankingRules,
    updateRankingRules,
    getTasks,
    index: vi.fn(() => ({ getRankingRules, updateRankingRules, getTasks })),
  };
});

vi.mock('~/env/server', () => ({ env }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/meilisearch/client', () => ({
  searchClient: { index },
  metricsSearchClient: null,
}));

const handler = (await import('~/pages/api/admin/temp/apply-models-index-ranking-rules')).default;

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

describe('modelsRankingRules', () => {
  const at = (rule: string) => modelsRankingRules.indexOf(rule);

  it('ranks an official model above more-liked community models matching at the same position', () => {
    // A bare "MOSS" listed the official "MOSS Image" 11th, behind "Mossa…" LoRAs with more thumbs.
    expect(at('isOfficial:desc')).toBeGreaterThan(at('attribute'));
    expect(at('isOfficial:desc')).toBeLessThan(at('metrics.thumbsUpCount:desc'));
  });

  it('ranks on a field the indexed document actually carries', () => {
    // A document without the field sorts as if it were absent, so dropping it from the select would
    // turn the official boost into a silent no-op.
    expect(modelSearchIndexSelect).toHaveProperty('isOfficial', true);
  });

  it('keeps exactness below popularity', () => {
    // Above it, any trigger word equal to the query wins: "pony" ranked a small LoRA tagged "pony"
    // above Pony Diffusion V6 XL.
    expect(at('exactness')).toBeGreaterThan(at('metrics.thumbsUpCount:desc'));
  });
});

describe('apply-models-index-ranking-rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRankingRules.mockResolvedValue(OLD_RULES);
    getTasks.mockReset();
    getTasks.mockResolvedValue({ results: [] });
  });

  it('rejects a call with the wrong token, and writes nothing', async () => {
    const { statusCode } = await call({ dryRun: 'false' }, 'wrong');

    expect(statusCode).toBe(401);
    expect(updateRankingRules).not.toHaveBeenCalled();
  });

  it('targets the MODELS index', async () => {
    await call({});

    expect(index).toHaveBeenCalledWith(MODELS_SEARCH_INDEX);
  });

  it('writes NOTHING by default, and reports the change', async () => {
    const { payload } = await call({});

    expect(payload).toMatchObject({
      dryRun: true,
      current: OLD_RULES,
      desired: [...modelsRankingRules],
      unchanged: false,
    });
    expect(updateRankingRules).not.toHaveBeenCalled();
  });

  it('writes the desired rules to the live index', async () => {
    const { payload } = await call({ dryRun: 'false' });

    expect(updateRankingRules).toHaveBeenCalledTimes(1);
    expect(updateRankingRules.mock.calls[0][0]).toEqual([...modelsRankingRules]);
    expect(payload.taskUid).toBe(99);
  });

  it('does not write when the live rules already match', async () => {
    getRankingRules.mockResolvedValue([...modelsRankingRules]);

    const { payload } = await call({ dryRun: 'false' });

    expect(payload.unchanged).toBe(true);
    expect(updateRankingRules).not.toHaveBeenCalled();
  });

  it('treats a reorder of the same rules as a change', async () => {
    // Order is the whole meaning of the list: a set comparison would call this unchanged.
    const reordered = [...modelsRankingRules];
    [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
    getRankingRules.mockResolvedValue(reordered);

    await call({ dryRun: 'false' });

    expect(updateRankingRules).toHaveBeenCalledTimes(1);
    expect(updateRankingRules.mock.calls[0][0]).toEqual([...modelsRankingRules]);
  });

  it('asks only for PENDING SETTINGS tasks when deciding whether one is in flight', async () => {
    await call({});

    expect(getTasks.mock.calls[0][0]).toEqual({
      statuses: ['enqueued', 'processing'],
      types: ['settingsUpdate'],
    });
  });

  it('REFUSES the write while a settings task is enqueued, and permits it with force', async () => {
    getTasks.mockResolvedValue({ results: [{ uid: 7 }] });

    const refused = await call({ dryRun: 'false' });
    expect(refused.statusCode).toBe(409);
    expect(refused.payload.pending).toEqual([7]);
    expect(updateRankingRules).not.toHaveBeenCalled();

    await call({ dryRun: 'false', force: 'true' });
    expect(updateRankingRules.mock.calls[0][0]).toEqual([...modelsRankingRules]);
  });

  it('REFUSES the write when it cannot tell whether a settings task is pending', async () => {
    getTasks.mockRejectedValue(new Error('403 forbidden'));

    const { statusCode } = await call({ dryRun: 'false' });

    expect(statusCode).toBe(409);
    expect(updateRankingRules).not.toHaveBeenCalled();

    const forced = await call({ dryRun: 'false', force: 'true' });
    expect(forced.statusCode).toBe(200);
    expect(updateRankingRules).toHaveBeenCalledTimes(1);
  });
});
