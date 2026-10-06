import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real module imports `$app/server`, which only exists inside SvelteKit.
vi.mock('../user-actions.service', () => ({ callModEndpoint: vi.fn() }));

const { callModEndpoint } = await import('../user-actions.service');
const { LabHarnessError, composeEntities, getPrompts, quoteTexts, scanTexts } = await import(
  '../text-scan-lab/harness-client'
);

const call = vi.mocked(callModEndpoint);

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
});

describe('scanTexts', () => {
  it('splits 120 texts into sequential calls of 50, 50 and 20', async () => {
    call.mockImplementation(async (_path, body) => ({
      ok: true,
      body: {
        results: (body.texts as Array<{ key: string }>).map(({ key }) => scannedOk(key)),
      },
    }));

    const results = await scanTexts('Model', texts(120));

    expect(call).toHaveBeenCalledTimes(3);
    expect(call.mock.calls.map(([, body]) => (body.texts as unknown[]).length)).toEqual([
      50, 50, 20,
    ]);
    for (const [path, body, , timeout] of call.mock.calls) {
      expect(path).toBe('text-scan');
      expect(body).toMatchObject({ action: 'scanTexts', entityType: 'Model' });
      expect(timeout).toBe(150_000);
    }
    expect(results.map((r) => r.key)).toEqual(texts(120).map((t) => t.key));
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
          { ...scannedOk('b'), parse: { ok: false, reason: 'refused' } },
          { key: 'c', ok: false, error: 'too-short' },
        ],
      },
    });

    const results = await scanTexts('Model', texts(3), { base: 'BASE PROMPT' });

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
        elapsedMs: 12,
      },
      { key: 'c', ok: false, error: 'too-short' },
    ]);
    expect(call.mock.calls[0][1]).toMatchObject({ promptOverrides: { base: 'BASE PROMPT' } });
  });

  it("throws LabHarnessError carrying the endpoint's message when the call fails", async () => {
    call.mockResolvedValue({
      ok: false,
      status: 400,
      error: 'Text-scan scan: promptOverrides.base: empty prompt',
      reason: 'promptOverrides.base: empty prompt',
    });

    const scan = scanTexts('Model', texts(1), { base: ' ' });
    await expect(scan).rejects.toBeInstanceOf(LabHarnessError);
    await expect(scan).rejects.toThrow('promptOverrides.base: empty prompt');
  });

  it('stops at the first failed chunk', async () => {
    call
      .mockResolvedValueOnce({
        ok: true,
        body: { results: texts(50).map((t) => scannedOk(t.key)) },
      })
      .mockResolvedValueOnce({ ok: false, error: 'Text-scan scan returned 502.', status: 502 });

    await expect(scanTexts('Model', texts(120))).rejects.toThrow('Text-scan scan returned 502.');
    expect(call).toHaveBeenCalledTimes(2);
  });
});

describe('quoteTexts', () => {
  it('weights each chunk mean by how many texts it quoted', async () => {
    call
      .mockResolvedValueOnce({ ok: true, body: { count: 50, quoted: 50, meanCostTotal: 2 } })
      .mockResolvedValueOnce({ ok: true, body: { count: 10, quoted: 10, meanCostTotal: 8 } });

    const quote = await quoteTexts('Article', texts(60));

    expect(call.mock.calls.map(([, body]) => body.action)).toEqual(['quoteTexts', 'quoteTexts']);
    expect(quote).toEqual({ count: 60, meanCostTotal: 3 });
  });

  it('reports a null mean when nothing could be quoted', async () => {
    call.mockResolvedValue({ ok: true, body: { count: 2, quoted: 0, meanCostTotal: null } });
    expect(await quoteTexts('Article', texts(2))).toEqual({ count: 2, meanCostTotal: null });
  });
});

describe('getPrompts / composeEntities', () => {
  it('passes the history key through and returns the body', async () => {
    const body = {
      active: { base: { id: 1, key: 'base', content: 'BASE PROMPT' } },
      config: { model: 'm', maxInputChars: 1000, thinking: false },
    };
    call.mockResolvedValue({ ok: true, body });

    expect(await getPrompts('base')).toEqual(body);
    expect(call.mock.calls[0][1]).toEqual({ action: 'getPrompts', history: 'base' });
  });

  it('returns the composed results for the requested ids', async () => {
    const results = [
      { entityId: 1, ok: true, fields: [{ heading: 'Name', text: 'x' }], text: 'x', userId: 9 },
      { entityId: 2, ok: false, error: 'entity not found' },
    ];
    call.mockResolvedValue({ ok: true, body: { entityType: 'Model', results } });

    expect(await composeEntities('Model', [1, 2])).toEqual(results);
    expect(call.mock.calls[0][1]).toEqual({
      action: 'composeEntities',
      entityType: 'Model',
      entityIds: [1, 2],
    });
  });
});
