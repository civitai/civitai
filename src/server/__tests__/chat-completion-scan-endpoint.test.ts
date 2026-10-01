import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as PromptModule from '~/server/services/text-scan/prompt';
// Side-effect imports: the canonical mocks the handler's graph reaches at import time.
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/env.mock';

// @civitai/client is mocked globally in src/__tests__/setup.ts (submitWorkflow is a vi.fn()).
vi.mock('~/server/services/text-scan/profiles/index', () => ({}));
vi.mock('~/server/services/text-scan/prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof PromptModule>()),
  getActiveTextScanPrompts: vi.fn(),
  getTextScanConfig: vi.fn(),
  insertTextScanPrompt: vi.fn(),
  setTextScanConfig: vi.fn(),
}));

const { default: handler } = await import('~/pages/api/testing/chat-completion-scan');
const { registerTextScanProfile } = await import('~/server/services/text-scan/profiles');
const { submitWorkflow } = await import('@civitai/client');
const {
  composeUserMessage,
  getActiveTextScanPrompts,
  getTextScanConfig,
  insertTextScanPrompt,
  setTextScanConfig,
} = await import('~/server/services/text-scan/prompt');
const { textScanContentHash } = await import('~/server/services/text-scan/submit');

registerTextScanProfile({
  entityType: 'Post',
  labels: ['nsfw'],
  minChars: 3,
  load: async (ids) =>
    new Map(
      ids.map((id) => [
        id,
        {
          fields: [{ heading: 'Title', text: id === 99 ? 'x' : `title ${id}` }],
          declared: { nsfwLevel: 1 },
        },
      ])
    ),
});

function run({
  method = 'POST',
  query = {},
  body,
  token = 'test-webhook-token',
}: {
  method?: string;
  query?: Record<string, string>;
  body?: unknown;
  token?: string | null;
}) {
  const req = {
    method,
    query: { ...(token ? { token } : {}), ...query },
    headers: {},
    body,
  };

  let statusCode = 0;
  let payload: unknown;
  let headers: Record<string, string> = {};
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: unknown) {
      payload = data;
      return res;
    },
    send(data: unknown) {
      payload = data;
      return res;
    },
    setHeader(k: string, v: string) {
      headers = { ...headers, [k]: v };
      return res;
    },
    end: () => res,
    _status: () => statusCode,
    _body: () => payload as Record<string, unknown>,
    _headers: () => headers,
  };

  return handler(req as never, res as never).then(() => res);
}
const call = (body: unknown) => run({ body });

const PROMPTS = {
  base: { id: 1, key: 'base', content: 'BASE PROMPT' },
  'label:nsfw': { id: 2, key: 'label:nsfw', content: 'NSFW DEF' },
};
const CONFIG = { model: 'air:test', maxInputChars: 1000, thinking: false };
const okWorkflow = (id: string, parsed: unknown = { nsfw: { level: 'x', reason: 'r' } }) => ({
  data: {
    id,
    steps: [
      {
        $type: 'chatCompletion',
        output: {
          choices: [{ message: { content: JSON.stringify(parsed) }, finishReason: 'stop' }],
          parsed,
        },
      },
    ],
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getActiveTextScanPrompts).mockResolvedValue(PROMPTS);
  vi.mocked(getTextScanConfig).mockResolvedValue(CONFIG);
});

describe('chat-completion-scan text-scan actions', () => {
  it('rejects a request without the token', async () => {
    expect((await run({ body: { action: 'getPrompts' }, token: null }))._status()).toBe(401);
  });

  it('getPrompts returns the active prompts and the config', async () => {
    const res = await call({ action: 'getPrompts' });
    expect(res._status()).toBe(200);
    expect(res._body()).toMatchObject({ active: PROMPTS, config: CONFIG });
  });

  it('putPrompt rejects an unknown key, a missing note and a missing createdById', async () => {
    expect(
      (
        await call({
          action: 'putPrompt',
          key: 'label:hate',
          content: 'x',
          note: 'n',
          createdById: 5,
        })
      )._status()
    ).toBe(400);
    expect(
      (await call({ action: 'putPrompt', key: 'base', content: 'x', createdById: 5 }))._status()
    ).toBe(400);
    expect(
      (await call({ action: 'putPrompt', key: 'base', content: 'x', note: 'n' }))._status()
    ).toBe(400);
    expect(insertTextScanPrompt).not.toHaveBeenCalled();
  });

  it('putPrompt inserts with the moderator id', async () => {
    vi.mocked(insertTextScanPrompt).mockResolvedValue({ id: 5, key: 'base' });
    const res = await call({
      action: 'putPrompt',
      key: 'base',
      content: 'BASE v2',
      note: 'tighten',
      createdById: 5,
    });
    expect(res._status()).toBe(200);
    expect(insertTextScanPrompt).toHaveBeenCalledWith({
      key: 'base',
      content: 'BASE v2',
      note: 'tighten',
      createdById: 5,
    });
  });

  it('putPrompt surfaces a non-moderator as 401', async () => {
    vi.mocked(insertTextScanPrompt).mockRejectedValueOnce(
      new TRPCError({ code: 'UNAUTHORIZED', message: 'not a moderator' })
    );
    expect(
      (
        await call({ action: 'putPrompt', key: 'base', content: 'x', note: 'n', createdById: 9 })
      )._status()
    ).toBe(401);
  });

  it('putConfig validates the patch and passes the moderator id', async () => {
    expect(
      (await call({ action: 'putConfig', moderatorId: 5, config: { maxInputChars: -1 } }))._status()
    ).toBe(400);
    expect(
      (await call({ action: 'putConfig', moderatorId: 5, config: { other: 1 } }))._status()
    ).toBe(400);
    expect((await call({ action: 'putConfig', config: { thinking: true } }))._status()).toBe(400);
    expect(setTextScanConfig).not.toHaveBeenCalled();

    vi.mocked(setTextScanConfig).mockResolvedValue({ ...CONFIG, thinking: true });
    const res = await call({ action: 'putConfig', moderatorId: 5, config: { thinking: true } });
    expect(res._status()).toBe(200);
    expect(setTextScanConfig).toHaveBeenCalledWith({ thinking: true }, { moderatorId: 5 });
    expect(res._body()).toEqual({ ...CONFIG, thinking: true });
  });

  it('scanEntity composes the production prompt, applies overrides, and waits', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue(okWorkflow('wf-1') as any);
    const res = await call({
      action: 'scanEntity',
      entityType: 'Post',
      entityId: 3,
      promptOverrides: { 'label:nsfw': 'CANDIDATE DEF' },
    });
    expect(res._status()).toBe(200);
    const sent = vi.mocked(submitWorkflow).mock.calls[0][0];
    expect(sent.query).toMatchObject({ wait: expect.any(Number) });
    expect(sent.body!.callbacks ?? []).toEqual([]);
    const input = (sent.body!.steps[0] as any).input;
    expect(input.messages[0].content).toContain('CANDIDATE DEF');
    expect(input.chatTemplateKwargs).toEqual({ enable_thinking: false });
    expect(res._body()).toMatchObject({
      promptIds: { base: 1, nsfw: 0 },
      thinking: false,
      parse: { ok: true },
      outcome: { triggeredLabels: ['nsfw'] },
    });
  });

  it('scanEntity takes a per-call thinking override', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue(okWorkflow('wf-1') as any);
    const res = await call({
      action: 'scanEntity',
      entityType: 'Post',
      entityId: 3,
      thinking: true,
    });
    expect(
      (vi.mocked(submitWorkflow).mock.calls[0][0].body!.steps[0] as any).input.chatTemplateKwargs
    ).toEqual({ enable_thinking: true });
    expect(res._body()).toMatchObject({ thinking: true });
  });

  it('batchEntities summarises outcomes and label firing, skipping text below minChars', async () => {
    vi.mocked(submitWorkflow)
      .mockResolvedValueOnce(okWorkflow('a') as any)
      .mockResolvedValueOnce({
        data: {
          id: 'b',
          steps: [
            {
              $type: 'chatCompletion',
              output: { choices: [{ message: { content: "I'm sorry" } }] },
            },
          ],
        },
      } as any);
    const res = await call({
      action: 'batchEntities',
      entityType: 'Post',
      entityIds: [1, 2, 99],
      concurrency: 1,
    });
    expect(submitWorkflow).toHaveBeenCalledTimes(2);
    expect(res._body()).toMatchObject({
      count: 3,
      byOutcome: { ok: 1, refused: 1, too_short: 1 },
      firing: { nsfw: 1 },
    });
  });

  it('putPrompt and putConfig without any moderator id are a 400', async () => {
    expect(
      (await call({ action: 'putPrompt', key: 'base', content: 'x', note: 'n' }))._status()
    ).toBe(400);
    expect((await call({ action: 'putConfig', config: { thinking: true } }))._status()).toBe(400);
    expect(insertTextScanPrompt).not.toHaveBeenCalled();
    expect(setTextScanConfig).not.toHaveBeenCalled();
  });

  it('a harness action that throws goes through the error envelope', async () => {
    vi.mocked(getActiveTextScanPrompts).mockRejectedValueOnce(new Error('db down'));
    expect((await call({ action: 'getPrompts' }))._status()).toBe(500);
  });

  it('scanEntity rejects an entity type without a profile', async () => {
    expect(
      (await call({ action: 'scanEntity', entityType: 'Bounty', entityId: 1 }))._status()
    ).toBe(400);
  });
});

const entrySubjects = new Map([
  [
    1,
    {
      fields: [{ heading: 'Description', text: 'plain text' }],
      declared: { nsfwLevel: 1 },
      userId: 10,
    },
  ],
  [
    2,
    {
      fields: [{ heading: 'Description', text: 'line1\nsays "hi"' }],
      declared: { nsfwLevel: 1 },
      userId: 20,
    },
  ],
]);
registerTextScanProfile({
  entityType: 'BountyEntry',
  labels: ['nsfw'],
  load: async (ids) =>
    new Map(ids.filter((id) => entrySubjects.has(id)).map((id) => [id, entrySubjects.get(id)!])),
});

const PROMPT_IDS = { base: 1, nsfw: 2 };
const scanRow = (entityId: number, contentHash: string, reason = 'reason "quoted"') => ({
  entityId,
  workflowId: `wf-${entityId}`,
  triggeredLabels: ['nsfw'],
  nsfwLevel: 8,
  result: {
    version: 1,
    labels: { nsfw: { level: 'x', reason } },
    promptIds: PROMPT_IDS,
    model: 'air:test',
  },
  contentHash,
  updatedAt: new Date('2026-09-20T00:00:00Z'),
});
const hashOf = (id: number) =>
  textScanContentHash({
    user: composeUserMessage(entrySubjects.get(id)!, 1000),
    promptIds: PROMPT_IDS,
    model: 'air:test',
    thinking: false,
  });
const queryValues = (call: number) => vi.mocked(dbMock.dbRead.$queryRaw).mock.calls[call].slice(1);

describe('sampleShadow', () => {
  it('rejects a label the profile does not scan', async () => {
    const res = await call({ action: 'sampleShadow', entityType: 'BountyEntry', label: 'scam' });
    expect(res._status()).toBe(400);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('flags changed and deleted entities', async () => {
    vi.mocked(dbMock.dbRead.$queryRaw).mockResolvedValue([
      scanRow(1, hashOf(1)),
      scanRow(2, 'hash-from-older-text'),
      scanRow(99, 'whatever'),
    ] as never);
    const res = await call({ action: 'sampleShadow', entityType: 'BountyEntry', label: 'nsfw' });
    expect(res._status()).toBe(200);
    const items = (res._body() as { items: Array<Record<string, unknown>> }).items;
    expect(queryValues(0)).toContain('BountyEntry:shadow');
    expect(queryValues(0)).not.toContain('BountyEntry');
    expect(items.map((i) => [i.entityId, i.textChangedSinceScan])).toEqual([
      [1, false],
      [2, true],
      [99, null],
    ]);
    expect(items[2]).toMatchObject({
      text: null,
      userId: null,
      verdict: 'x',
      reason: 'reason "quoted"',
    });
    expect(items[0]).toMatchObject({ userId: 10, triggered: true, declared: { nsfwLevel: 1 } });
  });

  it('filters to the active prompt ids unless asked for any', async () => {
    vi.mocked(dbMock.dbRead.$queryRaw).mockResolvedValue([] as never);
    await call({ action: 'sampleShadow', entityType: 'BountyEntry', label: 'nsfw' });
    await call({
      action: 'sampleShadow',
      entityType: 'BountyEntry',
      label: 'nsfw',
      promptScope: 'any',
    });
    expect(queryValues(0)).toContain(JSON.stringify(PROMPT_IDS));
    expect(queryValues(1)).not.toContain(JSON.stringify(PROMPT_IDS));
  });

  it('csv neutralises formulas and escapes quotes/newlines', async () => {
    vi.mocked(dbMock.dbRead.$queryRaw).mockResolvedValue([
      scanRow(1, hashOf(1)),
      scanRow(2, hashOf(2), '=HYPERLINK("x")'),
    ] as never);
    const res = await call({
      action: 'sampleShadow',
      entityType: 'BountyEntry',
      label: 'nsfw',
      format: 'csv',
    });
    expect(res._status()).toBe(200);
    expect(res._headers()['Content-Type']).toBe('text/csv; charset=utf-8');
    const csv = res._body() as unknown as string;
    expect(csv.split('\r\n')[0]).toBe(
      '"entityType","entityId","userId","scannedAt","triggered","verdict","reason","declared","textChangedSinceScan","text","grade","note"'
    );
    expect(csv).toContain('"reason ""quoted"""');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).not.toContain('"=HYPERLINK');
    expect(csv).toContain('line1\nsays ""hi""');
  });
});

describe('quoteEntities', () => {
  it('prices the production composition with whatif and no callbacks', async () => {
    vi.mocked(submitWorkflow)
      .mockResolvedValueOnce({ data: { id: 'q1', cost: { total: 4 } } } as never)
      .mockResolvedValueOnce({ data: { id: 'q2', cost: { total: 6 } } } as never);
    const res = await call({
      action: 'quoteEntities',
      entityType: 'Post',
      entityIds: [1, 2],
      concurrency: 1,
    });
    expect(res._status()).toBe(200);
    const sent = vi.mocked(submitWorkflow).mock.calls[0][0];
    expect(sent.query).toEqual({ whatif: true });
    expect(sent.body!.callbacks ?? []).toEqual([]);
    expect(res._body()).toMatchObject({ count: 2, quoted: 2, meanCostTotal: 5, maxCostTotal: 6 });
  });

  it('passes a thinking override into the step', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue({ data: { id: 'q', cost: { total: 1 } } } as never);
    await call({ action: 'quoteEntities', entityType: 'Post', entityIds: [1] });
    await call({ action: 'quoteEntities', entityType: 'Post', entityIds: [1], thinking: true });
    const [off, on] = vi
      .mocked(submitWorkflow)
      .mock.calls.map((c) => (c[0].body!.steps[0] as any).input.chatTemplateKwargs);
    expect(off).toEqual({ enable_thinking: false });
    expect(on).toEqual({ enable_thinking: true });
  });

  it('reports a missing entity and text below minChars without failing the batch', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue({ data: { id: 'q', cost: { total: 1 } } } as never);
    const missing = await call({
      action: 'quoteEntities',
      entityType: 'BountyEntry',
      entityIds: [99],
    });
    expect(missing._body()).toMatchObject({
      count: 1,
      quoted: 0,
      results: [{ entityId: 99, ok: false, error: 'entity not found' }],
    });
    const short = await call({ action: 'quoteEntities', entityType: 'Post', entityIds: [99] });
    expect(short._body()).toMatchObject({
      quoted: 0,
      results: [{ entityId: 99, ok: false, error: 'too-short' }],
    });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });
});
