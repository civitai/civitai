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
const { runTextScanHarnessAction, textScanHarnessSchema } = await import(
  '~/server/services/text-scan/harness'
);
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

  it.each(['   ', '\n\t'])('putPrompt rejects whitespace-only content %j', async (content) => {
    const res = await call({
      action: 'putPrompt',
      key: 'base',
      content,
      note: 'n',
      createdById: 5,
    });
    expect(res._status()).toBe(400);
    expect((res._body() as { issues: Array<{ path: unknown[] }> }).issues[0].path).toEqual([
      'content',
    ]);
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
      wait: 40,
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

// Served only by the attributed /api/mod/text-scan (the testing route refuses it), so driven directly.
const shadow = (input: Record<string, unknown>) =>
  runTextScanHarnessAction(textScanHarnessSchema.parse({ action: 'sampleShadow', ...input }), {
    moderatorId: 1,
  });

describe('sampleShadow', () => {
  it('rejects a label the profile does not scan', async () => {
    await expect(shadow({ entityType: 'BountyEntry', label: 'scam' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('flags changed and deleted entities', async () => {
    vi.mocked(dbMock.dbRead.$queryRaw).mockResolvedValue([
      scanRow(1, hashOf(1)),
      scanRow(2, 'hash-from-older-text'),
      scanRow(99, 'whatever'),
    ] as never);
    const res = await shadow({ entityType: 'BountyEntry', label: 'nsfw' });
    const items = (res.body as { items: Array<Record<string, unknown>> }).items;
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
    await shadow({ entityType: 'BountyEntry', label: 'nsfw' });
    await shadow({ entityType: 'BountyEntry', label: 'nsfw', promptScope: 'any' });
    expect(queryValues(0)).toContain(JSON.stringify(PROMPT_IDS));
    expect(queryValues(1)).not.toContain(JSON.stringify(PROMPT_IDS));
  });

  it('csv neutralises formulas and escapes quotes/newlines', async () => {
    vi.mocked(dbMock.dbRead.$queryRaw).mockResolvedValue([
      scanRow(1, hashOf(1)),
      scanRow(2, hashOf(2), '=HYPERLINK("x")'),
    ] as never);
    const res = await shadow({ entityType: 'BountyEntry', label: 'nsfw', format: 'csv' });
    expect(res.kind).toBe('csv');
    const csv = res.body as string;
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

const commentSubjects = new Map([
  [7, { fields: [{ heading: 'Comment', text: '  hello there ' }], declared: {}, userId: 42 }],
  [8, { fields: [{ heading: 'Comment', text: '   ' }], declared: {} }],
]);
registerTextScanProfile({
  entityType: 'Comment',
  labels: ['scam'],
  load: async (ids) =>
    new Map(
      ids.filter((id) => commentSubjects.has(id)).map((id) => [id, commentSubjects.get(id)!])
    ),
});
registerTextScanProfile({
  entityType: 'Model',
  labels: ['nsfw'],
  load: async (ids) =>
    new Map(
      ids.map((id) => [
        id,
        {
          fields: [
            { heading: 'Name', text: 'My LoRA' },
            { heading: 'Description', text: null },
            { heading: 'Trained words', text: '  ' },
          ],
          declared: {},
          userId: 3,
        },
      ])
    ),
});
registerTextScanProfile({
  entityType: 'ChatMessage',
  labels: ['scam'],
  load: async (ids) =>
    new Map(
      ids.map((id) => [
        id,
        {
          fields: [{ heading: 'Messages, newest first', text: 'newest message\nolder message' }],
          declared: {},
          userId: 5,
          meta: { chatId: 9, senderId: 5, messageIds: [id, 21] },
        },
      ])
    ),
});
const SCAM_OVERRIDES = { base: 'BASE PROMPT', 'label:scam': 'SCAM DEF' };
const scamWorkflow = (id: string) => ({
  data: {
    id,
    status: 'succeeded',
    steps: [
      {
        $type: 'chatCompletion',
        output: {
          parsed: { scam: { detected: true, reason: 'r' } },
          choices: [{ finishReason: 'stop', message: { content: '' } }],
        },
      },
    ],
  },
});

describe('free-text actions', () => {
  beforeEach(() => {
    vi.mocked(getActiveTextScanPrompts).mockResolvedValue({});
  });

  it('scanTexts composes like production and keeps each key', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue(scamWorkflow('wf1') as never);
    const res = await call({
      action: 'scanTexts',
      entityType: 'Comment',
      texts: [{ key: 'a', fields: [{ heading: 'Comment', text: 'hello' }] }],
      promptOverrides: SCAM_OVERRIDES,
    });
    expect(res._status()).toBe(200);
    const body = res._body() as { results: unknown[] };
    expect(body).toMatchObject({ entityType: 'Comment', count: 1, firing: { scam: 1 } });
    expect(body.results[0]).toMatchObject({
      key: 'a',
      ok: true,
      workflowId: 'wf1',
      promptIds: { base: 0, scam: 0 },
      outcome: { triggeredLabels: ['scam'] },
    });
    const sent = vi.mocked(submitWorkflow).mock.calls[0][0];
    expect(sent.query).toMatchObject({ wait: 90 });
    const step = sent.body!.steps[0];
    expect(JSON.stringify(step)).toContain('## Comment\\nhello');
    expect(JSON.stringify(step)).toContain('SCAM DEF');
  });

  it('scanTexts refuses a text with no non-empty field', async () => {
    const res = await call({
      action: 'scanTexts',
      entityType: 'Comment',
      texts: [{ key: 'a', fields: [{ heading: 'Comment', text: '   ' }] }],
      promptOverrides: SCAM_OVERRIDES,
    });
    const body = res._body() as { results: unknown[]; byOutcome: unknown };
    expect(body.results[0]).toEqual({ key: 'a', ok: false, error: 'too-short' });
    expect(body.byOutcome).toEqual({ too_short: 1 });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('scanTexts reports a missing prompt key instead of submitting', async () => {
    const res = await call({
      action: 'scanTexts',
      entityType: 'Comment',
      texts: [{ key: 'a', fields: [{ heading: 'Comment', text: 'x' }] }],
      promptOverrides: { base: 'B' },
    });
    expect(res._status()).toBe(200);
    expect((res._body() as { results: unknown[] }).results[0]).toMatchObject({
      key: 'a',
      ok: false,
      error: expect.stringContaining('label:scam'),
    });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it.each(['  ', '\n', ''])(
    'refuses a blank prompt override %j before submitting',
    async (blank) => {
      const res = await call({
        action: 'scanTexts',
        entityType: 'Comment',
        texts: [{ key: 'a', fields: [{ heading: 'Comment', text: 'x' }] }],
        promptOverrides: { base: 'B', 'label:scam': blank },
      });
      expect(res._status()).toBe(400);
      const issues = (res._body() as { issues: Array<{ path: unknown[] }> }).issues;
      expect(issues.map((i) => i.path)).toContainEqual(['promptOverrides', 'label:scam']);
      expect(submitWorkflow).not.toHaveBeenCalled();
    }
  );

  it('scanTexts rejects more than 50 texts and an empty field list', async () => {
    const text = { key: 'k', fields: [{ heading: 'Comment', text: 'x' }] };
    expect(
      (
        await call({ action: 'scanTexts', entityType: 'Comment', texts: Array(51).fill(text) })
      )._status()
    ).toBe(400);
    expect(
      (
        await call({
          action: 'scanTexts',
          entityType: 'Comment',
          texts: [{ key: 'k', fields: [] }],
        })
      )._status()
    ).toBe(400);
  });

  it('quoteTexts accepts an entity-sized text: many fields and a long description', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue({ data: { id: 'q', cost: { total: 1 } } } as never);
    const fields = Array.from({ length: 33 }, (_, i) => ({ heading: `F${i}`, text: 'x' }));
    fields.push({ heading: 'Description', text: 'y'.repeat(60_000) });
    const res = await call({
      action: 'quoteTexts',
      entityType: 'Comment',
      texts: [{ key: 'a', fields }],
      promptOverrides: SCAM_OVERRIDES,
    });
    expect(res._status()).toBe(200);
  });

  it.each([
    {
      name: 'too many fields',
      texts: [{ key: 'a', fields: Array(501).fill({ heading: 'H', text: 'x' }) }],
    },
    {
      name: 'a text over its character cap',
      texts: [{ key: 'a', fields: Array(3).fill({ heading: 'H', text: 'x'.repeat(70_000) }) }],
    },
    {
      name: 'a request over its character cap',
      texts: Array.from({ length: 6 }, (_, i) => ({
        key: `k${i}`,
        fields: [{ heading: 'H', text: 'x'.repeat(190_000) }],
      })),
    },
  ])('quoteTexts refuses $name', async ({ texts }) => {
    const res = await call({ action: 'quoteTexts', entityType: 'Comment', texts });
    expect(res._status()).toBe(400);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('quoteTexts refuses more than textsPerRequest texts on `texts`', async () => {
    const res = await call({
      action: 'quoteTexts',
      entityType: 'Comment',
      texts: Array.from({ length: 51 }, (_, i) => ({
        key: `k${i}`,
        fields: [{ heading: 'Comment', text: 'hello' }],
      })),
    });
    expect(res._status()).toBe(400);
    expect((res._body() as { issues: Array<{ path: unknown[] }> }).issues[0].path).toEqual([
      'texts',
    ]);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: '500 fields',
      texts: [{ key: 'a', fields: Array(500).fill({ heading: 'H', text: 'x' }) }],
    },
    {
      name: '200,000 characters in one text',
      texts: [{ key: 'a', fields: [{ heading: 'H', text: 'x'.repeat(200_000) }] }],
    },
    {
      name: '1,000,000 characters in one request',
      texts: Array.from({ length: 5 }, (_, i) => ({
        key: `k${i}`,
        fields: [{ heading: 'H', text: 'x'.repeat(200_000) }],
      })),
    },
    {
      name: 'exactly 50 texts',
      texts: Array.from({ length: 50 }, (_, i) => ({
        key: `k${i}`,
        fields: [{ heading: 'Comment', text: 'hello' }],
      })),
    },
  ])('quoteTexts accepts $name', async ({ texts }) => {
    vi.mocked(submitWorkflow).mockResolvedValue({ data: { id: 'q', cost: { total: 1 } } } as never);
    const res = await call({
      action: 'quoteTexts',
      entityType: 'Comment',
      texts,
      promptOverrides: SCAM_OVERRIDES,
    });
    expect(res._status()).toBe(200);
  });

  it.each([
    { action: 'composeEntities', entityType: 'Comment', entityIds: [7] },
    { action: 'sampleShadow', entityType: 'Post', label: 'nsfw' },
  ])('$action is refused on the unattributed testing route', async (input) => {
    const res = await call(input);
    expect(res._status()).toBe(403);
    expect(submitWorkflow).not.toHaveBeenCalled();
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('composeEntities returns the composed text without submitting', async () => {
    const res = await runTextScanHarnessAction(
      textScanHarnessSchema.parse({
        action: 'composeEntities',
        entityType: 'Comment',
        entityIds: [7, 8, 9],
      }),
      { moderatorId: 1 }
    );
    expect(res.body).toEqual({
      entityType: 'Comment',
      results: [
        {
          entityId: 7,
          ok: true,
          text: '## Comment\nhello there',
          fields: [{ heading: 'Comment', text: '  hello there ' }],
          userId: 42,
        },
        { entityId: 8, ok: false, error: 'too-short' },
        { entityId: 9, ok: false, error: 'entity not found' },
      ],
    });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('composeEntities drops fields whose text is null or blank', async () => {
    const res = await runTextScanHarnessAction(
      textScanHarnessSchema.parse({
        action: 'composeEntities',
        entityType: 'Model',
        entityIds: [1],
      }),
      { moderatorId: 1 }
    );
    expect(res.body).toEqual({
      entityType: 'Model',
      results: [
        {
          entityId: 1,
          ok: true,
          text: '## Name\nMy LoRA',
          fields: [{ heading: 'Name', text: 'My LoRA' }],
          userId: 3,
        },
      ],
    });
  });

  it('quoteTexts prices the composition with whatif', async () => {
    vi.mocked(submitWorkflow)
      .mockResolvedValueOnce({ data: { id: 'q1', cost: { total: 2 } } } as never)
      .mockResolvedValueOnce({ data: { id: 'q2', cost: { total: 4 } } } as never);
    const res = await call({
      action: 'quoteTexts',
      entityType: 'Comment',
      texts: [
        { key: 'a', fields: [{ heading: 'Comment', text: 'one' }] },
        { key: 'b', fields: [{ heading: 'Comment', text: 'two' }] },
        { key: 'c', fields: [{ heading: 'Comment', text: '' }] },
      ],
      promptOverrides: SCAM_OVERRIDES,
    });
    expect(res._status()).toBe(200);
    const sent = vi.mocked(submitWorkflow).mock.calls[0][0];
    expect(sent.query).toEqual({ whatif: true });
    expect(JSON.stringify(sent.body!.steps[0])).toContain('SCAM DEF');
    expect(res._body()).toMatchObject({
      count: 3,
      quoted: 2,
      meanCostTotal: 3,
      maxCostTotal: 4,
      results: [
        { key: 'a', ok: true, costTotal: 2 },
        { key: 'b', ok: true, costTotal: 4 },
        { key: 'c', ok: false, error: 'too-short' },
      ],
    });
  });

  it('passes an object-shaped orchestrator error through as text', async () => {
    const error = { status: 400, detail: 'model not available' };
    vi.mocked(submitWorkflow).mockResolvedValue({ data: undefined, error } as never);
    const res = await call({
      action: 'scanTexts',
      entityType: 'Comment',
      texts: [{ key: 'a', fields: [{ heading: 'Comment', text: 'hello' }] }],
      promptOverrides: SCAM_OVERRIDES,
    });
    expect((res._body() as { results: unknown[] }).results[0]).toEqual({
      key: 'a',
      ok: false,
      error: JSON.stringify(error),
    });
  });

  it('passes a string orchestrator error through unchanged', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue({ data: undefined, error: 'quota' } as never);
    const res = await call({
      action: 'quoteTexts',
      entityType: 'Comment',
      texts: [{ key: 'a', fields: [{ heading: 'Comment', text: 'hello' }] }],
      promptOverrides: SCAM_OVERRIDES,
    });
    expect((res._body() as { results: unknown[] }).results[0]).toEqual({
      key: 'a',
      ok: false,
      error: 'quota',
    });
  });

  const ALL_ACTIVE = {
    ...PROMPTS,
    'label:scam': { id: 3, key: 'label:scam', content: 'SCAM DEF' },
  };
  const commentText = (key: string) => ({ key, fields: [{ heading: 'Comment', text: 'hello' }] });

  it.each([
    { action: 'scanTexts', entityType: 'Comment', texts: [commentText('a')] },
    { action: 'quoteTexts', entityType: 'Comment', texts: [commentText('a')] },
    { action: 'scanEntity', entityType: 'Model', entityId: 1 },
    { action: 'batchEntities', entityType: 'Model', entityIds: [1] },
    { action: 'quoteEntities', entityType: 'Model', entityIds: [1] },
  ])('$action sends a model override in the step', async (input) => {
    vi.mocked(getActiveTextScanPrompts).mockResolvedValue(ALL_ACTIVE);
    vi.mocked(submitWorkflow).mockResolvedValue({
      ...scamWorkflow('wf'),
      data: { ...scamWorkflow('wf').data, cost: { total: 1 } },
    } as never);
    await call({ ...input, model: 'air:override' });
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
    expect((vi.mocked(submitWorkflow).mock.calls[0][0].body!.steps[0] as any).input.model).toBe(
      'air:override'
    );
  });

  it.each([
    {
      name: 'a failed workflow',
      data: {
        id: 'wf-f',
        status: 'failed',
        steps: [
          {
            $type: 'chatCompletion',
            status: 'failed',
            jobs: [{ id: 'j', status: 'failed', reason: 'model air:missing not found' }],
          },
        ],
      },
      error: 'workflow wf-f failed: model air:missing not found',
      outcome: 'workflow_failed',
    },
    {
      name: 'a failed step with an object error',
      data: {
        id: 'wf-o',
        status: 'failed',
        steps: [
          { $type: 'chatCompletion', status: 'failed', error: { code: 'E1', detail: 'boom' } },
        ],
      },
      error: 'workflow wf-o failed: {"code":"E1","detail":"boom"}',
      outcome: 'workflow_failed',
    },
    {
      name: 'an expired workflow with no detail',
      data: {
        id: 'wf-e',
        status: 'expired',
        steps: [{ $type: 'chatCompletion', status: 'expired' }],
      },
      error: 'workflow wf-e expired',
      outcome: 'workflow_expired',
    },
    {
      name: 'a canceled workflow',
      data: {
        id: 'wf-c',
        status: 'canceled',
        steps: [{ $type: 'chatCompletion', status: 'canceled' }],
      },
      error: 'workflow wf-c canceled',
      outcome: 'workflow_canceled',
    },
    {
      name: 'a failed workflow whose step status differs',
      data: {
        id: 'wf-s',
        status: 'failed',
        steps: [{ $type: 'chatCompletion', status: 'expired' }],
      },
      error: 'workflow wf-s failed: step expired',
      outcome: 'workflow_failed',
    },
    {
      name: 'error detail on the step metadata',
      data: {
        id: 'wf-m',
        status: 'failed',
        steps: [{ $type: 'chatCompletion', status: 'failed', metadata: { reason: 'quota' } }],
      },
      error: 'workflow wf-m failed: quota',
      outcome: 'workflow_failed',
    },
    {
      name: 'error detail on the step output',
      data: {
        id: 'wf-u',
        status: 'failed',
        steps: [{ $type: 'chatCompletion', status: 'failed', output: { message: 'bad output' } }],
      },
      error: 'workflow wf-u failed: bad output',
      outcome: 'workflow_failed',
    },
    {
      name: 'an array of errors',
      data: {
        id: 'wf-a',
        status: 'failed',
        steps: [{ $type: 'chatCompletion', status: 'failed', errors: ['first', 'second'] }],
      },
      error: 'workflow wf-a failed: first; second',
      outcome: 'workflow_failed',
    },
    {
      name: 'a workflow still running after wait',
      data: {
        id: 'wf-p',
        status: 'processing',
        steps: [{ $type: 'chatCompletion', status: 'processing' }],
      },
      error: 'workflow wf-p still processing after 30s',
      outcome: 'workflow_processing',
    },
  ])("scanTexts reports $name in the orchestrator's words, not as a parse failure", async (c) => {
    vi.mocked(submitWorkflow).mockResolvedValue({ data: c.data } as never);
    const res = await call({
      action: 'scanTexts',
      entityType: 'Comment',
      texts: [{ key: 'a', fields: [{ heading: 'Comment', text: 'hello' }] }],
      promptOverrides: SCAM_OVERRIDES,
      wait: 30,
    });
    const body = res._body() as { results: unknown[]; byOutcome: unknown };
    expect(body.results[0]).toEqual({
      key: 'a',
      ok: false,
      error: c.error,
      workflowId: c.data.id,
      workflowStatus: c.data.status,
    });
    expect(body.byOutcome).toEqual({ [c.outcome]: 1 });
  });

  it('scanTexts passes wait through to the workflow query', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue(scamWorkflow('wf') as never);
    await call({
      action: 'scanTexts',
      entityType: 'Comment',
      texts: [{ key: 'a', fields: [{ heading: 'Comment', text: 'hello' }] }],
      promptOverrides: SCAM_OVERRIDES,
      wait: 30,
    });
    expect(vi.mocked(submitWorkflow).mock.calls[0][0].query).toEqual({ wait: 30 });
  });

  const six = Array.from({ length: 6 }, (_, i) => i + 1);
  it.each([
    {
      action: 'scanTexts',
      entityType: 'Comment',
      texts: six.map((i) => commentText(`k${i}`)),
      wait: 30,
    },
    { action: 'quoteTexts', entityType: 'Comment', texts: six.map((i) => commentText(`k${i}`)) },
    { action: 'batchEntities', entityType: 'Model', entityIds: six, wait: 30 },
    { action: 'quoteEntities', entityType: 'Model', entityIds: six },
  ])('$action never has more than `concurrency` workflows in flight', async (input) => {
    vi.mocked(getActiveTextScanPrompts).mockResolvedValue(ALL_ACTIVE);
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(submitWorkflow).mockImplementation((async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { data: { ...scamWorkflow('wf').data, cost: { total: 1 } } };
    }) as never);
    const res = await call({ ...input, concurrency: 2 });
    expect(res._status()).toBe(200);
    expect(submitWorkflow).toHaveBeenCalledTimes(6);
    expect(maxInFlight).toBe(2);
  });

  it.each([
    { texts: 9, concurrency: 8, wait: 61 },
    { texts: 4, concurrency: undefined, wait: undefined },
  ])('scanTexts refuses a request that could outrun the time budget (%o)', async (shape) => {
    const res = await call({
      action: 'scanTexts',
      entityType: 'Comment',
      texts: Array.from({ length: shape.texts }, (_, i) => ({
        key: `k${i}`,
        fields: [{ heading: 'Comment', text: 'x' }],
      })),
      promptOverrides: SCAM_OVERRIDES,
      concurrency: shape.concurrency,
      wait: shape.wait,
    });
    expect(res._status()).toBe(400);
    expect((res._body() as { issues: Array<{ path: unknown[] }> }).issues[0].path).toEqual([
      'wait',
    ]);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    { ids: 9, concurrency: 8, wait: 61 },
    { ids: 4, concurrency: undefined, wait: undefined },
  ])('batchEntities refuses a request that could outrun the time budget (%o)', async (shape) => {
    const res = await call({
      action: 'batchEntities',
      entityType: 'Comment',
      entityIds: Array.from({ length: shape.ids }, (_, i) => i + 1),
      concurrency: shape.concurrency,
      wait: shape.wait,
    });
    expect(res._status()).toBe(400);
    expect((res._body() as { issues: Array<{ path: unknown[] }> }).issues[0].path).toEqual([
      'wait',
    ]);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('batchEntities accepts one wave of 8 at wait 60', () => {
    expect(
      textScanHarnessSchema.safeParse({
        action: 'batchEntities',
        entityType: 'Comment',
        entityIds: [1, 2, 3, 4, 5, 6, 7, 8],
        concurrency: 8,
        wait: 60,
      }).success
    ).toBe(true);
  });

  it('scanEntity refuses a wait past the time budget', async () => {
    const res = await call({ action: 'scanEntity', entityType: 'Comment', entityId: 7, wait: 121 });
    expect(res._status()).toBe(400);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('scanTexts accepts one wave of 8 at wait 60', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue(scamWorkflow('wf') as never);
    const res = await call({
      action: 'scanTexts',
      entityType: 'Comment',
      texts: Array.from({ length: 8 }, (_, i) => ({
        key: `k${i}`,
        fields: [{ heading: 'Comment', text: 'x' }],
      })),
      promptOverrides: SCAM_OVERRIDES,
      concurrency: 8,
      wait: 60,
    });
    expect(res._status()).toBe(200);
  });

  it.each([
    { action: 'scanEntity', entityId: 7 },
    { action: 'batchEntities', entityIds: [7] },
    { action: 'quoteEntities', entityIds: [7] },
  ])('$action reports a missing prompt key per entity without submitting', async (input) => {
    const res = await call({ entityType: 'Comment', promptOverrides: { base: 'B' }, ...input });
    expect(res._status()).toBe(200);
    const body = res._body() as { results?: unknown[] };
    expect(body.results?.[0] ?? body).toMatchObject({
      entityId: 7,
      ok: false,
      error: expect.stringContaining('label:scam'),
    });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('quoteTexts reports a missing prompt key per text without submitting', async () => {
    const res = await call({
      action: 'quoteTexts',
      entityType: 'Comment',
      texts: [{ key: 'a', fields: [{ heading: 'Comment', text: 'x' }] }],
      promptOverrides: { base: 'B' },
    });
    expect((res._body() as { results: unknown[] }).results[0]).toMatchObject({
      key: 'a',
      ok: false,
      error: expect.stringContaining('label:scam'),
    });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('counts a missing prompt as missing_prompt, not submit_failed', async () => {
    const res = await call({
      action: 'batchEntities',
      entityType: 'Comment',
      entityIds: [7, 8],
      promptOverrides: { base: 'B' },
    });
    expect((res._body() as { byOutcome: unknown }).byOutcome).toEqual({
      missing_prompt: 1,
      too_short: 1,
    });
  });

  it('a blank active prompt is reported as missing', async () => {
    vi.mocked(getActiveTextScanPrompts).mockResolvedValue({
      base: { id: 1, key: 'base', content: 'BASE PROMPT' },
      'label:scam': { id: 2, key: 'label:scam', content: '  ' },
    });
    const res = await call({
      action: 'scanTexts',
      entityType: 'Comment',
      texts: [{ key: 'a', fields: [{ heading: 'Comment', text: 'x' }] }],
    });
    expect((res._body() as { results: unknown[] }).results[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining('label:scam'),
    });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it("reports 'no workflow id' when the orchestrator returns neither an id nor an error", async () => {
    vi.mocked(submitWorkflow).mockResolvedValue({ data: undefined, error: null } as never);
    const res = await call({
      action: 'scanTexts',
      entityType: 'Comment',
      texts: [{ key: 'a', fields: [{ heading: 'Comment', text: 'hello' }] }],
      promptOverrides: SCAM_OVERRIDES,
    });
    expect((res._body() as { results: unknown[] }).results[0]).toEqual({
      key: 'a',
      ok: false,
      error: 'no workflow id',
    });
  });
});
