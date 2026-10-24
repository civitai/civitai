import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real module imports `$app/server`, which only exists inside SvelteKit.
vi.mock('../user-actions.service', () => ({
  callModEndpoint: vi.fn(),
  callModEndpointAs: vi.fn(),
}));

const { callModEndpoint, callModEndpointAs } = await import('../user-actions.service');
const { restErrorReason } = await import('../rest-error-reason');
const {
  LabHarnessError,
  StalePromptError,
  composeEntities,
  getPrompts,
  isRefused,
  isRejected,
  putPrompt,
  quoteTexts,
  scanTexts,
} = await import('../text-scan-lab/harness-client');

const call = vi.mocked(callModEndpoint);
const callAs = vi.mocked(callModEndpointAs);

const texts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    key: `t${i}`,
    fields: [{ heading: 'Name', text: `text ${i}` }],
  }));

const scannedOk = (key: string) => ({
  key,
  ok: true,
  workflowId: `wf-${key}`,
  promptIds: { base: 1, 'label:nsfw': 2 },
  thinking: false,
  parse: { ok: true, output: { nsfw: { level: 'none', reason: 'fine' } } },
  outcome: null,
  elapsedMs: 12,
});

beforeEach(() => {
  call.mockReset();
  callAs.mockReset();
});

describe('scanTexts', () => {
  it('splits 20 texts into single-wave calls of 8, 8 and 4 at concurrency 8, wait 60', async () => {
    call.mockImplementation(async (_path, body) => ({
      ok: true,
      body: {
        results: (body.texts as Array<{ key: string }>).map(({ key }) => scannedOk(key)),
      },
    }));

    const { results } = await scanTexts('Model', texts(20));

    expect(call).toHaveBeenCalledTimes(3);
    expect(call.mock.calls.map(([, body]) => (body.texts as unknown[]).length)).toEqual([8, 8, 4]);
    for (const [path, body, , timeout] of call.mock.calls) {
      expect(path).toBe('text-scan');
      expect(body).toMatchObject({
        action: 'scanTexts',
        entityType: 'Model',
        concurrency: 8,
        wait: 60,
      });
      expect(timeout).toBe(150_000);
    }
    expect(results.map((r) => r.key)).toEqual(texts(20).map((t) => t.key));
  });

  it('starts the next chunk only after the previous one returned', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    call.mockImplementation(async (_path, body) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return {
        ok: true,
        body: {
          results: (body.texts as Array<{ key: string }>).map(({ key }) => scannedOk(key)),
        },
      };
    });

    await scanTexts('Model', texts(120));
    expect(maxInFlight).toBe(1);
  });

  it('maps a parsed result to its output and a parse failure to a null output with the reason', async () => {
    call.mockResolvedValue({
      ok: true,
      body: {
        results: [
          scannedOk('a'),
          { ...scannedOk('b'), parse: { ok: false, reason: 'refused' }, rawContent: 'I cannot' },
          { key: 'c', ok: false, error: 'too-short' },
          {
            key: 'd',
            ok: false,
            error: 'workflow wf-d expired',
            workflowId: 'wf-d',
            workflowStatus: 'expired',
          },
        ],
      },
    });

    const { results } = await scanTexts(
      'Model',
      ['a', 'b', 'c', 'd'].map((key) => ({ key, fields: [{ heading: 'Name', text: key }] })),
      { prompts: { base: 'BASE PROMPT' } }
    );

    expect(results).toEqual([
      {
        key: 'a',
        ok: true,
        workflowId: 'wf-a',
        promptIds: { base: 1, 'label:nsfw': 2 },
        output: { nsfw: { level: 'none', reason: 'fine' } },
        elapsedMs: 12,
      },
      {
        key: 'b',
        ok: true,
        workflowId: 'wf-b',
        promptIds: { base: 1, 'label:nsfw': 2 },
        output: null,
        parseError: 'refused',
        rawContent: 'I cannot',
        elapsedMs: 12,
      },
      { key: 'c', ok: false, error: 'not enough text to judge' },
      { key: 'd', ok: false, error: 'workflow wf-d expired', workflowId: 'wf-d' },
    ]);
    expect(call.mock.calls[0][1]).toMatchObject({ promptOverrides: { base: 'BASE PROMPT' } });
  });

  it("throws LabHarnessError carrying the endpoint's message when the first request is refused", async () => {
    call.mockResolvedValue({
      ok: false,
      status: 400,
      error: 'Text-scan scan: promptOverrides.base: empty prompt',
      reason: 'promptOverrides.base: empty prompt',
    });

    const scan = scanTexts('Model', texts(1), { prompts: { base: ' ' } });
    await expect(scan).rejects.toBeInstanceOf(LabHarnessError);
    await expect(scan).rejects.toThrow('promptOverrides.base: empty prompt');
  });

  it.each([
    { requestNeverSent: true, error: 'Text-scan scan failed: no session to forward.' },
    { status: 403, error: 'Text-scan scan: missing permission' },
  ])('throws when the first request is refused outright (%o)', async (failure) => {
    call.mockResolvedValue({ ok: false, ...failure });
    await expect(scanTexts('Model', texts(25))).rejects.toThrow(failure.error);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('records per-text errors for a 422 on the first chunk instead of throwing (invalid, not refused)', async () => {
    call.mockResolvedValue({ ok: false, status: 422, error: 'Text-scan scan returned 422.' });

    const { results } = await scanTexts('Model', texts(2));

    expect(isRefused({ ok: false, status: 422, error: 'x' })).toBe(false);
    expect(isRejected({ ok: false, status: 422, error: 'x' })).toBe(true);
    expect(results).toEqual(
      texts(2).map(({ key }) => ({ key, ok: false, error: 'Text-scan scan returned 422.' }))
    );
  });

  it('turns a failed chunk into per-text errors and keeps scanning', async () => {
    const ok = (n: number, from: number) => ({
      ok: true as const,
      body: {
        results: texts(from + n)
          .slice(from)
          .map((t) => scannedOk(t.key)),
      },
    });
    call
      .mockResolvedValueOnce(ok(8, 0))
      .mockResolvedValueOnce({ ok: false, error: 'Text-scan scan returned 502.', status: 502 })
      .mockResolvedValueOnce(ok(4, 16));

    const { results } = await scanTexts('Model', texts(20));

    expect(call).toHaveBeenCalledTimes(3);
    expect(results.map((r) => r.key)).toEqual(texts(20).map((t) => t.key));
    expect(results.slice(0, 8).every((r) => r.ok)).toBe(true);
    expect(results.slice(8, 16)).toEqual(
      texts(16)
        .slice(8)
        .map(({ key }) => ({ key, ok: false, error: 'Text-scan scan returned 502.' }))
    );
    expect(results.slice(16).every((r) => r.ok)).toBe(true);
  });

  it('keeps collected results when a later request is refused', async () => {
    call
      .mockResolvedValueOnce({
        ok: true,
        body: { results: texts(8).map((t) => scannedOk(t.key)) },
      })
      .mockResolvedValueOnce({ ok: false, status: 401, error: 'Text-scan scan: sign in again' });

    const { results } = await scanTexts('Model', texts(16));

    expect(results.filter((r) => r.ok)).toHaveLength(8);
    expect(results[8]).toEqual({ key: 't8', ok: false, error: 'Text-scan scan: sign in again' });
  });
});

describe('harness limits', () => {
  const huge = (key: string, n = 600_001) => ({
    key,
    fields: [{ heading: 'Description', text: 'x'.repeat(n) }],
  });
  const manyFields = (key: string) => ({
    key,
    fields: Array.from({ length: 501 }, () => ({ heading: 'Version name', text: 'v' })),
  });

  it('keeps an oversize text out of every request and reports it as its own error, in order', async () => {
    call.mockImplementation(async (_path, body) => ({
      ok: true,
      body: { results: (body.texts as Array<{ key: string }>).map(({ key }) => scannedOk(key)) },
    }));

    const { results } = await scanTexts('Model', [
      ...texts(2),
      huge('big'),
      manyFields('wide'),
      ...texts(3).slice(2),
    ]);

    const sent = call.mock.calls.flatMap(([, body]) =>
      (body.texts as Array<{ key: string }>).map((t) => t.key)
    );
    expect(sent).toEqual(['t0', 't1', 't2']);
    expect(results.map((r) => r.key)).toEqual(['t0', 't1', 'big', 'wide', 't2']);
    expect(results[2]).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^too large: 1 fields \/ 600001 chars/),
    });
    expect(results[3]).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^too large: 501 fields \/ 501 chars/),
    });
  });

  it('splits a request at the per-request character cap', async () => {
    call.mockImplementation(async (_path, body) => ({
      ok: true,
      body: { results: (body.texts as Array<{ key: string }>).map(({ key }) => scannedOk(key)) },
    }));
    await scanTexts(
      'Model',
      Array.from({ length: 6 }, (_, i) => huge(`h${i}`, 190_000))
    );
    expect(call.mock.calls.map(([, body]) => (body.texts as unknown[]).length)).toEqual([5, 1]);
  });

  it('passes the segment count of a segmented scan through', async () => {
    call.mockResolvedValue({ ok: true, body: { results: [{ ...scannedOk('a'), segments: 3 }] } });
    const {
      results: [result],
    } = await scanTexts(
      'Model',
      texts(1).map((t) => ({ ...t, key: 'a' }))
    );
    expect(result).toMatchObject({ key: 'a', ok: true, segments: 3 });
  });

  it('omits segments for a single-segment scan', async () => {
    call.mockResolvedValue({ ok: true, body: { results: [{ ...scannedOk('a'), segments: 1 }] } });
    const {
      results: [result],
    } = await scanTexts(
      'Model',
      texts(1).map((t) => ({ ...t, key: 'a' }))
    );
    expect(result).not.toHaveProperty('segments');
  });

  it('calls pasted text "your text" in a refusal', async () => {
    call.mockResolvedValueOnce({
      ok: false,
      status: 400,
      error: 'Invalid request: texts.0.fields: Too big',
    });
    await expect(
      scanTexts('Model', [{ key: 'text', fields: [{ heading: 'Name', text: 'x' }] }])
    ).rejects.toThrow('Invalid request: your text.fields: Too big');
  });

  it('names a refused text by its key, not its position', async () => {
    call
      .mockResolvedValueOnce({ ok: true, body: { results: texts(8).map((t) => scannedOk(t.key)) } })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        error: 'Invalid request: texts.1.fields: Too big',
      });

    const { results } = await scanTexts('Model', texts(16));

    expect(results[9]).toEqual({
      key: 't9',
      ok: false,
      error: 'Invalid request: item t9.fields: Too big',
    });
  });
});

describe('getPrompts / composeEntities', () => {
  it('sends 51 ids as 50 then 1 and joins the results in order', async () => {
    call.mockImplementation(async (_path, body) => ({
      ok: true,
      body: {
        results: (body.entityIds as number[]).map((entityId) => ({
          entityId,
          ok: false,
          error: 'entity not found',
        })),
      },
    }));
    const ids = Array.from({ length: 51 }, (_, i) => i + 1);

    const results = await composeEntities('Model', ids);

    expect(call.mock.calls.map(([, body]) => (body.entityIds as number[]).length)).toEqual([50, 1]);
    expect(results.map((r) => r.entityId)).toEqual(ids);
  });

  it('passes the history key through and returns the body', async () => {
    const body = {
      active: { base: { id: 1, key: 'base', content: 'BASE PROMPT' } },
      config: { model: 'm', maxInputChars: 1000, maxSegments: 10, thinking: false },
    };
    call.mockResolvedValue({ ok: true, body });

    expect(await getPrompts('base')).toEqual(body);
    expect(call.mock.calls[0][1]).toEqual({ action: 'getPrompts', history: 'base' });
  });

  it('returns the composed results for the requested ids', async () => {
    const ok = {
      entityId: 1,
      ok: true,
      fields: [{ heading: 'Name', text: 'x' }],
      text: 'x',
      userId: 9,
    };
    const results = [ok, { entityId: 2, ok: false, error: 'entity not found' }];
    call.mockResolvedValue({ ok: true, body: { entityType: 'Model', results } });

    expect(await composeEntities('Model', [1, 2])).toEqual([
      ok,
      { entityId: 2, ok: false, error: 'not found' },
    ]);
    expect(call.mock.calls[0][1]).toEqual({
      action: 'composeEntities',
      entityType: 'Model',
      entityIds: [1, 2],
    });
  });

  it('drops null and blank text from composed fields, and skips an entity left with none', async () => {
    call.mockResolvedValue({
      ok: true,
      body: {
        results: [
          {
            entityId: 1,
            ok: true,
            fields: [
              { heading: 'Name', text: 'x' },
              { heading: 'Description', text: null },
            ],
            text: '## Name\nx',
            userId: 9,
          },
          {
            entityId: 2,
            ok: true,
            fields: [{ heading: 'Description', text: null }],
            text: '',
            userId: 9,
          },
          { entityId: 3, ok: true, fields: [{ heading: ' ', text: 'y' }], text: 'y', userId: 9 },
        ],
      },
    });

    expect(await composeEntities('Model', [1, 2, 3])).toEqual([
      {
        entityId: 1,
        ok: true,
        fields: [{ heading: 'Name', text: 'x' }],
        text: '## Name\nx',
        userId: 9,
      },
      { entityId: 2, ok: false, error: 'not enough text to judge' },
      { entityId: 3, ok: false, error: 'Every field with text needs a heading.' },
    ]);
  });
});

describe('restErrorReason', () => {
  it("appends the endpoint's validation issues to its message", () => {
    expect(
      restErrorReason(
        {
          error: 'Invalid request',
          issues: [
            { path: ['texts', 0, 'fields', 1, 'text'], message: 'expected string, received null' },
            { path: [], message: 'top-level problem' },
          ],
        },
        400
      )
    ).toBe(
      'Invalid request: texts.0.fields.1.text: expected string, received null; top-level problem'
    );
  });

  it('caps a long issue list', () => {
    const issues = Array.from({ length: 7 }, (_, i) => ({ path: ['f', i], message: 'bad' }));
    expect(restErrorReason({ error: 'Invalid request', issues }, 400)).toBe(
      'Invalid request: f.0: bad; f.1: bad; f.2: bad; f.3: bad; f.4: bad (+2 more)'
    );
  });
});

describe('scanTexts — what a run sent', () => {
  it('takes the system prompt from the first chunk that has one', async () => {
    call.mockImplementation(async (_path, body) => ({
      ok: true,
      body: {
        results: (body.texts as Array<{ key: string }>).map(({ key }) => scannedOk(key)),
        system: 'SYSTEM',
      },
    }));
    const run = await scanTexts('Model', texts(10));
    expect(run.system).toBe('SYSTEM');
    expect(run.results[0]).toMatchObject({ ok: true });
  });

  it('never sends rule overrides: they only exist for the literal Model rules try', async () => {
    call.mockImplementation(async (_path, body) => ({
      ok: true,
      body: { results: (body.texts as Array<{ key: string }>).map(({ key }) => scannedOk(key)) },
    }));
    await scanTexts('Model', texts(1), { prompts: { base: 'B' } });
    expect(call.mock.calls[0][1]).toMatchObject({ promptOverrides: { base: 'B' } });
    expect(call.mock.calls[0][1]).not.toHaveProperty('ruleOverrides');
  });

  it('reads a run without a system prompt as having none', async () => {
    call.mockResolvedValue({ ok: true, body: { results: [scannedOk('t0')] } });
    expect(await scanTexts('Model', texts(1))).toMatchObject({ system: null });
  });
});

describe('putPrompt', () => {
  it('sends a note only when there is one, and the base version as given', async () => {
    call.mockResolvedValue({ ok: true, body: { id: 4, key: 'base' } });
    await putPrompt('base', 'X', { baseId: null });
    await putPrompt('base', 'X', { note: 'why', baseId: 3 });
    expect(call.mock.calls.map((c) => c[1])).toEqual([
      { action: 'putPrompt', key: 'base', content: 'X', baseId: null },
      { action: 'putPrompt', key: 'base', content: 'X', note: 'why', baseId: 3 },
    ]);
  });

  it('turns a 409 into StalePromptError and anything else into LabHarnessError', async () => {
    call.mockResolvedValueOnce({ ok: false, status: 409, error: 'x: newer', reason: 'newer' });
    await expect(putPrompt('base', 'X', { baseId: 3 })).rejects.toBeInstanceOf(StalePromptError);
    call.mockResolvedValueOnce({ ok: false, status: 500, error: 'boom' });
    await expect(putPrompt('base', 'X', { baseId: 3 })).rejects.toBeInstanceOf(LabHarnessError);
  });

  it('marks a 4xx or never-sent failure as refused, and a 5xx as not known', async () => {
    const refusedOf = async () =>
      putPrompt('base', 'X', { baseId: 3 }).catch(
        (e: InstanceType<typeof LabHarnessError>) => e.refused
      );
    call.mockResolvedValueOnce({ ok: false, status: 400, error: 'bad' });
    expect(await refusedOf()).toBe(true);
    call.mockResolvedValueOnce({ ok: false, status: 422, error: 'invalid' });
    expect(await refusedOf()).toBe(true);
    call.mockResolvedValueOnce({ ok: false, requestNeverSent: true, error: 'no session' });
    expect(await refusedOf()).toBe(true);
    call.mockResolvedValueOnce({ ok: false, status: 502, error: 'down' });
    expect(await refusedOf()).toBe(false);
  });
});

describe('isRefused', () => {
  it.each([
    [{ ok: false, error: 'x', requestNeverSent: true }, true],
    [{ ok: false, error: 'x', status: 400 }, true],
    [{ ok: false, error: 'x', status: 401 }, true],
    [{ ok: false, error: 'x', status: 403 }, true],
    [{ ok: false, error: 'x', status: 404 }, false],
    [{ ok: false, error: 'x', status: 409 }, false],
    [{ ok: false, error: 'x', status: 502 }, false],
    [{ ok: false, error: 'x' }, false],
    [{ ok: true, body: {} }, false],
  ] as const)('%o -> %s', (result, expected) => {
    expect(isRefused(result as never)).toBe(expected);
  });
});

describe('isRejected', () => {
  it.each([
    [{ ok: false, error: 'x', requestNeverSent: true }, true],
    [{ ok: false, error: 'x', status: 404 }, true],
    [{ ok: false, error: 'x', status: 422 }, true],
    [{ ok: false, error: 'x', status: 502 }, false],
    [{ ok: false, error: 'x' }, false],
    [{ ok: true, body: {} }, false],
  ] as const)('%o -> %s', (result, expected) => {
    expect(isRejected(result as never)).toBe(expected);
  });
});

describe('explicit credentials', () => {
  const okScan = async (_cookie: string, _path: string, body: Record<string, unknown>) => ({
    ok: true as const,
    body: { results: (body.texts as Array<{ key: string }>).map(({ key }) => scannedOk(key)) },
  });

  it('sends a given credential through callModEndpointAs, never the request session', async () => {
    callAs.mockImplementation(okScan);
    const { results } = await scanTexts('Model', texts(2), {}, 'civ-token=synthetic');
    expect(results.every((r) => r.ok)).toBe(true);
    expect(call).not.toHaveBeenCalled();
    expect(callAs.mock.calls[0][0]).toBe('civ-token=synthetic');
    expect(callAs.mock.calls[0][1]).toBe('text-scan');
  });

  it('composes entities with a given credential', async () => {
    callAs.mockResolvedValue({ ok: true, body: { results: [] } });
    await composeEntities('Model', [1], 'civ-token=synthetic');
    expect(call).not.toHaveBeenCalled();
    expect(callAs.mock.calls[0][0]).toBe('civ-token=synthetic');
  });

  it.each([
    {
      requestNeverSent: true,
      noSession: true as const,
      error: 'Text-scan scan failed: no session to forward.',
    },
    { status: 401, error: 'Text-scan scan: sign in again' },
    { status: 403, error: 'Text-scan scan: missing permission' },
  ])('marks a first-request auth refusal (%o)', async (failure) => {
    call.mockResolvedValue({ ok: false, ...failure });
    const error = await scanTexts('Model', texts(1)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LabHarnessError);
    expect((error as InstanceType<typeof LabHarnessError>).authRefused).toBe(true);
  });

  it('does not mark a first-request validation refusal as an auth refusal', async () => {
    call.mockResolvedValue({ ok: false, status: 400, error: 'Text-scan scan: bad request' });
    const error = await scanTexts('Model', texts(1)).catch((e: unknown) => e);
    expect((error as InstanceType<typeof LabHarnessError>).authRefused).toBe(false);
  });

  it('flags a run whose later request was refused for auth', async () => {
    call
      .mockResolvedValueOnce({ ok: true, body: { results: texts(8).map((t) => scannedOk(t.key)) } })
      .mockResolvedValueOnce({ ok: false, status: 401, error: 'Text-scan scan: sign in again' });
    const run = await scanTexts('Model', texts(16));
    expect(run.authRefused).toBe(true);
  });

  it('does not flag a run whose later request failed for another reason', async () => {
    call
      .mockResolvedValueOnce({ ok: true, body: { results: texts(8).map((t) => scannedOk(t.key)) } })
      .mockResolvedValueOnce({ ok: false, status: 502, error: 'Text-scan scan returned 502.' });
    const run = await scanTexts('Model', texts(16));
    expect(run.authRefused).toBeUndefined();
  });
});

describe('quoteTexts', () => {
  const credential = 'civ-token=synthetic';

  it('prices texts at concurrency 8 under the given credential, sending prompt overrides only when there are some', async () => {
    callAs.mockResolvedValue({ ok: true, body: { count: 2, quoted: 2, maxCostTotal: 1 } });
    expect(await quoteTexts('CommentV2', texts(2), undefined, credential)).toEqual({
      count: 2,
      quoted: 2,
      maxCostTotal: 1,
    });
    expect(call).not.toHaveBeenCalled();
    expect(callAs.mock.calls[0][0]).toBe(credential);
    expect(callAs.mock.calls[0][2]).toEqual({
      action: 'quoteTexts',
      entityType: 'CommentV2',
      texts: texts(2),
      concurrency: 8,
    });
    await quoteTexts('CommentV2', texts(1), { 'label:scam': 'synthetic draft' }, credential);
    expect(callAs.mock.calls[1][2]).toMatchObject({
      promptOverrides: { 'label:scam': 'synthetic draft' },
    });
  });

  it('throws LabHarnessError when the harness refuses', async () => {
    callAs.mockResolvedValue({ ok: false, error: 'Text-scan quote returned 400.', status: 400 });
    await expect(quoteTexts('CommentV2', texts(1), undefined, credential)).rejects.toBeInstanceOf(
      LabHarnessError
    );
  });
});
