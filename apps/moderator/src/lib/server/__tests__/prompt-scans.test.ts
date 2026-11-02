import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ query }) }));

const { getPromptScans, isScanTimeout, readScores } = await import('../prompt-scans.service');

/** Step 1 answers with the account's hashes, step 2 with the rows for them. */
const answers = (hashes: string[], rows: unknown[] = []) =>
  query
    .mockResolvedValueOnce({ json: async () => hashes.map((promptHash) => ({ promptHash })) })
    .mockResolvedValueOnce({ json: async () => rows });

beforeEach(() => query.mockReset());

describe('getPromptScans', () => {
  // The id arrives from a URL; it must reach ClickHouse as a bound parameter, never as SQL text.
  it('binds the account, window and cap as parameters', async () => {
    answers(['-123']);
    await getPromptScans(42, { days: 30, limit: 100 });
    const [step1, step2] = query.mock.calls.map((c) => c[0]);
    expect(step1.query_params).toEqual({ userId: 42, days: 30, limit: 100 });
    expect(step2.query_params).toMatchObject({ userId: 42, limit: 100 });
    for (const { query: sql } of [step1, step2]) {
      expect(sql).not.toContain('42');
      expect(sql).toMatch(/userId = \{userId:Int32\}/);
    }
  });

  // FINAL over the prompt text across the whole table took 40 s for a busy account.
  it('finds the hashes without FINAL, then reads only those rows with FINAL', async () => {
    answers(['-123', '9007199254740993']);
    await getPromptScans(1, { days: 30, limit: 100 });
    const [step1, step2] = query.mock.calls.map((c) => c[0]);
    expect(step1.query).not.toMatch(/FINAL/);
    expect(step2.query).toMatch(/xguardPromptResults FINAL/);
    expect(step2.query).toMatch(/promptHash IN \{hashes:Array\(Int64\)\}/);
    // As bigints the client sends them unquoted; a Number would round a hash past 2^53.
    expect(step2.query_params.hashes).toEqual([-123n, 9007199254740993n]);
  });

  // Step 1 reads without FINAL, so it can return a hash whose current row now belongs to another account.
  it('re-checks the account when reading the rows', async () => {
    answers(['1']);
    await getPromptScans(7, { days: 30, limit: 100 });
    const step2 = query.mock.calls[1][0];
    expect(step2.query).toMatch(/AND userId = \{userId:Int32\}/);
    expect(step2.query_params.userId).toBe(7);
  });

  // The re-check can leave fewer rows than the limit on an account that has more; a count under the limit
  // must not read as everything in the window.
  it('reports the read as capped when the hashes reached the limit, whatever the re-check dropped', async () => {
    const hashes = Array.from({ length: 100 }, (_, i) => String(i));
    answers(hashes, []);
    expect(await getPromptScans(1, { days: 30, limit: 100 })).toEqual({
      items: [],
      truncated: true,
    });
    answers(hashes.slice(1), []);
    expect((await getPromptScans(1, { days: 30, limit: 100 })).truncated).toBe(false);
  });

  it('skips the second read when the account has no prompts in the window', async () => {
    answers([]);
    expect(await getPromptScans(1, { days: 7, limit: 100 })).toEqual({
      items: [],
      truncated: false,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  // A scan measured 40.1 s under load; Cloudflare cuts the request at 100 s.
  it('gives the scan room beyond the measured worst case, inside the edge limit', async () => {
    answers(['1']);
    await getPromptScans(1, { days: 30, limit: 100 });
    const cap = query.mock.calls[0][0].clickhouse_settings.max_execution_time;
    expect(cap).toBeGreaterThanOrEqual(40);
    expect(cap).toBeLessThanOrEqual(60);
  });

  // Two reads each given the full cap would run to twice it, past the edge cut.
  const secondReadCap = async (firstReadMs: number) => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    query
      .mockImplementationOnce(async () => {
        now.mockReturnValue(firstReadMs);
        return { json: async () => [{ promptHash: '1' }] };
      })
      .mockResolvedValueOnce({ json: async () => [] });
    await getPromptScans(1, { days: 30, limit: 100 }).finally(() => now.mockRestore());
    const [step1, step2] = query.mock.calls.map((c) => c[0].clickhouse_settings.max_execution_time);
    return { step1, step2 };
  };

  it('gives the second read only what the first left of the budget', async () => {
    const { step1, step2 } = await secondReadCap(30_000);
    expect(step2).toBe(step1 - 30);
  });

  // ClickHouse reads a max_execution_time of 0 as no limit at all.
  it('still caps the second read when the first used the whole budget', async () => {
    expect((await secondReadCap(60_000)).step2).toBe(1);
  });

  // The route turns a timeout into its own message; swallowing it would show an empty list instead.
  it('passes a failed first read to the caller', async () => {
    const timeout = { code: '159' };
    query.mockRejectedValueOnce(timeout);
    await expect(getPromptScans(1, { days: 30, limit: 100 })).rejects.toBe(timeout);
  });

  it('passes a failed second read to the caller', async () => {
    const timeout = { code: '159' };
    query
      .mockResolvedValueOnce({ json: async () => [{ promptHash: '1' }] })
      .mockRejectedValueOnce(timeout);
    await expect(getPromptScans(1, { days: 30, limit: 100 })).rejects.toBe(timeout);
  });

  // ClickHouse's default keeps a query running after its client disconnects, so a closed tab would
  // still hold a slot for the full cap.
  it('asks ClickHouse to cancel both reads when the client goes away', async () => {
    answers(['1']);
    const signal = new AbortController().signal;
    await getPromptScans(1, { days: 30, limit: 100, signal });
    expect(query).toHaveBeenCalledTimes(2);
    for (const [call] of query.mock.calls) {
      // The cancel only applies to a readonly query; this app's user is not readonly by default.
      expect(call.clickhouse_settings).toMatchObject({
        readonly: '2',
        cancel_http_readonly_queries_on_client_close: 1,
      });
      expect(call.abort_signal).toBe(signal);
    }
  });

  it('reads prompts and scores, an empty negative prompt as none', async () => {
    answers(
      ['-123'],
      [
        {
          promptHash: '-123',
          createdAt: '2026-10-27 05:00:00',
          positivePrompt: 'p',
          negativePrompt: '',
          scores: { alpha: 0.2, beta: 0.9 },
        },
      ]
    );
    expect((await getPromptScans(1, { days: 7, limit: 100 })).items).toEqual([
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
