import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ query }) }));

const { getPromptScans, isScanTimeout, readScores } = await import('../prompt-scans.service');

const rows = (r: unknown[]) => query.mockResolvedValue({ json: async () => r });

beforeEach(() => query.mockReset());

describe('getPromptScans', () => {
  // The id arrives from a URL; it must reach ClickHouse as a bound parameter, never as SQL text.
  it('binds the account, window and cap as parameters', async () => {
    rows([]);
    await getPromptScans(42, { days: 30, limit: 100 });
    const { query: sql, query_params } = query.mock.calls[0][0];
    expect(query_params).toEqual({ userId: 42, days: 30, limit: 100 });
    expect(sql).toMatch(/xguardPromptResults FINAL/);
    expect(sql).not.toContain('42');
    expect(sql).toMatch(/userId = \{userId:Int32\}/);
  });

  // A scan measured 20.1 s under load and failed at the old 20 s cap; Cloudflare cuts the request at 100 s.
  it('gives the scan room beyond the measured worst case, inside the edge limit', async () => {
    rows([]);
    await getPromptScans(1, { days: 30, limit: 100 });
    const cap = query.mock.calls[0][0].clickhouse_settings.max_execution_time;
    expect(cap).toBeGreaterThanOrEqual(40);
    expect(cap).toBeLessThanOrEqual(60);
  });

  // ClickHouse's default keeps a query running after its client disconnects, so a closed tab would
  // still hold a slot for the full cap.
  it('asks ClickHouse to cancel the scan when the client goes away', async () => {
    rows([]);
    await getPromptScans(1, { days: 30, limit: 100 });
    expect(
      query.mock.calls[0][0].clickhouse_settings.cancel_http_readonly_queries_on_client_close
    ).toBe(1);
  });

  it('reads prompts and scores, an empty negative prompt as none', async () => {
    rows([
      {
        promptHash: '-123',
        createdAt: '2026-10-27 05:00:00',
        positivePrompt: 'p',
        negativePrompt: '',
        scores: { alpha: 0.2, beta: 0.9 },
      },
    ]);
    expect(await getPromptScans(1, { days: 7, limit: 100 })).toEqual([
      {
        id: '-123',
        // ClickHouse sends UTC without a zone marker; unmarked, a browser would read it as local time.
        createdAt: '2026-10-27T05:00:00Z',
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

  it('drops a score that is not a finite number', () => {
    expect(readScores({ a: Number.NaN, b: 0.3 })).toEqual([{ label: 'b', score: 0.3 }]);
  });

  it('reads a missing map as no scores rather than throwing', () => {
    expect(readScores(null)).toEqual([]);
  });
});

describe('isScanTimeout', () => {
  it("recognises ClickHouse's TIMEOUT_EXCEEDED and nothing else", () => {
    expect(isScanTimeout({ code: '159', type: 'TIMEOUT_EXCEEDED' })).toBe(true);
    expect(isScanTimeout({ code: '497' })).toBe(false);
    expect(isScanTimeout(new Error('socket hang up'))).toBe(false);
    expect(isScanTimeout(null)).toBe(false);
  });
});
