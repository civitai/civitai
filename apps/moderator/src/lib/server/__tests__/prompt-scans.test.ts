import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ query }) }));

const { getPromptScans, readScores } = await import('../prompt-scans.service');

const rows = (r: unknown[]) => query.mockResolvedValue({ json: async () => r });

beforeEach(() => query.mockReset());

describe('getPromptScans', () => {
  // The id arrives from a URL; it must reach ClickHouse as a bound parameter, never as SQL text.
  it('binds the account, window and cap as parameters', async () => {
    rows([]);
    await getPromptScans(42, { days: 30, limit: 100 });
    const { query: sql, query_params } = query.mock.calls[0][0];
    expect(query_params).toEqual({ userId: 42, days: 30, limit: 100 });
    expect(sql).not.toContain('42');
    expect(sql).toMatch(/userId = \{userId:Int32\}/);
  });

  it('reads prompts and scores, an empty negative prompt as none', async () => {
    rows([
      {
        createdAt: '2026-10-27 05:00:00',
        positivePrompt: 'p',
        negativePrompt: '',
        scores: { alpha: 0.2, beta: 0.9 },
      },
    ]);
    expect(await getPromptScans(1, { days: 7, limit: 100 })).toEqual([
      {
        createdAt: '2026-10-27 05:00:00',
        prompt: 'p',
        negativePrompt: null,
        scores: [
          { label: 'beta', score: 0.9 },
          { label: 'alpha', score: 0.2 },
        ],
      },
    ]);
  });
});

describe('readScores', () => {
  it('skips the bookkeeping keys the scan writes beside its labels', () => {
    expect(readScores({ alpha: 0.5, '__marker:01ABC': 1 })).toEqual([
      { label: 'alpha', score: 0.5 },
    ]);
  });

  it('reads a missing map as no scores rather than throwing', () => {
    expect(readScores(null)).toEqual([]);
  });
});
