import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromptModule from '~/server/services/text-scan/prompt';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import '~/__tests__/mocks/logging.mock';

// @civitai/orchestration-client is mocked globally in src/__tests__/setup.ts (submitWorkflow is a vi.fn()).
vi.mock('~/server/services/text-scan/profiles/index', () => ({}));
vi.mock('~/server/services/text-scan/prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof PromptModule>()),
  getActiveTextScanPrompts: vi.fn(),
  getTextScanConfig: vi.fn(),
  setTextScanLabelMode: vi.fn(),
  setTextScanCsamMode: vi.fn(),
}));

const { runTextScanHarnessAction, textScanHarnessSchema } = await import(
  '~/server/services/text-scan/harness'
);
const { getTextScanProfile, registerTextScanProfile } = await import(
  '~/server/services/text-scan/profiles'
);
const { textScanContentHash } = await import('~/server/services/text-scan/submit');
const { composeUserText } = await import('~/server/services/text-scan/segment');
const { resetTextScanRolloutCache } = await import('~/server/services/text-scan/mode');
const { submitWorkflow } = await import('@civitai/orchestration-client');
const { getActiveTextScanPrompts, getTextScanConfig, setTextScanLabelMode, setTextScanCsamMode } =
  await import('~/server/services/text-scan/prompt');

const PROMPTS = {
  base: { id: 1, key: 'base', content: 'BASE PROMPT' },
  'label:nsfw': { id: 2, key: 'label:nsfw', content: 'NSFW DEF' },
};
const CONFIG = { model: 'air:test', maxInputChars: 1000, maxSegments: 10, thinking: false };
const words = (count: number) =>
  Array.from({ length: count }, (_, i) => `w${String(i).padStart(4, '0')}`).join(' ');

registerTextScanProfile({
  entityType: 'Post',
  labels: ['nsfw'],
  load: async (ids) =>
    new Map(
      ids.map((id) => [
        id,
        {
          fields: [
            { heading: 'Title', text: 'Hello world' },
            { heading: 'Body', text: words(400) },
          ],
          declared: {},
        },
      ])
    ),
});

const run = async (input: Record<string, unknown>) =>
  ((await runTextScanHarnessAction(textScanHarnessSchema.parse(input), { moderatorId: 1 })) as any)
    .body as Record<string, any>;
const sentSteps = () =>
  (vi.mocked(submitWorkflow).mock.calls[0][0].body!.steps as any[]).map((step) => ({
    system: step.input.messages[0].content as string,
    user: step.input.messages[1].content as string,
  }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getActiveTextScanPrompts).mockResolvedValue(PROMPTS);
  vi.mocked(getTextScanConfig).mockResolvedValue(CONFIG);
});

describe('text-scan harness with segmented text', () => {
  it('quotes the characters of every segment, each with its own system prompt', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue({ data: { id: 'q', cost: { total: 3 } } } as never);
    const res = await run({ action: 'quoteEntities', entityType: 'Post', entityIds: [1] });
    const steps = sentSteps();
    expect(steps.length).toBeGreaterThan(1);
    const expected = steps.reduce((sum, s) => sum + s.system.length + s.user.length, 0);
    expect(res.results[0]).toMatchObject({ ok: true, segments: steps.length, chars: expected });
  });

  it('names the unfinished step of a failed workflow, not the first one', async () => {
    const step = (segment: number, status: string, error?: string) => ({
      $type: 'chatCompletion',
      name: segment ? `textScan${segment}` : 'textScan',
      metadata: { segment },
      status,
      ...(error ? { error } : {}),
      output:
        status === 'succeeded'
          ? {
              choices: [{ message: { content: '{}' }, finishReason: 'stop' }],
              parsed: { nsfw: { level: 'none', reason: 'clean' } },
            }
          : null,
    });
    vi.mocked(submitWorkflow).mockResolvedValue({
      data: {
        id: 'wf-1',
        status: 'failed',
        steps: [
          step(0, 'succeeded'),
          step(1, 'failed', 'segment one blew up'),
          step(2, 'succeeded'),
        ],
      },
    } as never);
    const res = await run({ action: 'scanEntity', entityType: 'Post', entityId: 1 });
    expect(sentSteps().length).toBeGreaterThan(2);
    expect(res).toMatchObject({ ok: false, workflowId: 'wf-1', workflowStatus: 'failed' });
    expect(res.error).toContain('segment one blew up');
  });

  it('does not report a long, unedited text as changed since its scan', async () => {
    const PROMPT_IDS = { base: 1, nsfw: 2 };
    const subject = (await getTextScanProfile('Post')!.load([1])).get(1)!;
    const user = composeUserText(subject);
    expect(user.length).toBeGreaterThan(CONFIG.maxInputChars);
    vi.mocked(dbMock.dbRead.$queryRaw).mockResolvedValue([
      {
        entityId: 1,
        workflowId: 'wf-1',
        triggeredLabels: [],
        nsfwLevel: 1,
        result: {
          version: 1,
          labels: { nsfw: { level: 'none', reason: 'clean' } },
          promptIds: PROMPT_IDS,
          model: 'air:test',
        },
        contentHash: textScanContentHash({
          user,
          promptIds: PROMPT_IDS,
          model: 'air:test',
          thinking: false,
          segmentBudget: CONFIG,
        }),
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      },
    ] as never);
    const res = await run({ action: 'sampleShadow', entityType: 'Post', label: 'nsfw' });
    expect(res.items.map((i: any) => i.textChangedSinceScan)).toEqual([false]);
  });
});

describe('a labels override', () => {
  const scanTexts = (extra: Record<string, unknown>) =>
    run({
      action: 'scanTexts',
      entityType: 'Post',
      texts: [{ key: 'a', fields: [{ heading: 'Title', text: 'placeholder' }] }],
      ...extra,
    });

  it('scans the requested labels instead of the profile labels', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue({
      data: {
        id: 'wf-1',
        status: 'succeeded',
        steps: [
          {
            $type: 'chatCompletion',
            name: 'textScan',
            metadata: { segment: 0 },
            status: 'succeeded',
            output: {
              choices: [{ message: { content: '{}' }, finishReason: 'stop' }],
              parsed: { csam: { detected: true, reason: 'test' } },
            },
          },
        ],
      },
    } as never);
    const res = await scanTexts({
      labels: ['csam'],
      promptOverrides: { 'label:csam': 'CSAM DEF' },
    });
    expect(res.results[0]).toMatchObject({
      ok: true,
      labels: ['csam'],
      outcome: { triggeredLabels: ['csam'] },
    });
    expect(sentSteps()[0].system).toContain('CSAM DEF');
    expect(sentSteps()[0].system).not.toContain('NSFW DEF');
  });

  it('fails the item when a requested label has no prompt', async () => {
    const res = await scanTexts({ labels: ['csam'] });
    expect(res.results[0]).toMatchObject({ ok: false, missingPrompts: ['label:csam'] });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('rejects an unknown, empty or repeated label list', () => {
    const parse = (labels: unknown) =>
      textScanHarnessSchema.safeParse({
        action: 'batchEntities',
        entityType: 'Post',
        entityIds: [1],
        labels,
      }).success;
    expect(parse(['csam'])).toBe(true);
    expect(parse(['hate'])).toBe(false);
    expect(parse([])).toBe(false);
    expect(parse(['csam', 'csam'])).toBe(false);
  });
});

describe('the csam gate in the harness', () => {
  const ok = { data: { id: 'wf-1', status: 'succeeded', steps: [] } } as never;
  const scanTexts = (extra: Record<string, unknown> = {}) =>
    run({
      action: 'scanTexts',
      entityType: 'Comment',
      texts: [{ key: 'a', fields: [{ heading: 'Body', text: 'placeholder' }] }],
      promptOverrides: { 'label:csam': 'CSAM DEF' },
      ...extra,
    });
  const csamMode = (value?: string) => {
    redisMock.sysRedis.hGetAll.mockResolvedValue((value ? { csam: value } : {}) as never);
    resetTextScanRolloutCache();
  };

  beforeEach(() => {
    registerTextScanProfile({
      entityType: 'Comment',
      labels: ['nsfw', 'csam'],
      load: async () => new Map(),
    });
    vi.mocked(submitWorkflow).mockResolvedValue(ok);
  });

  it('scans a profile without csam while the gate is off, as production would', async () => {
    csamMode();
    await scanTexts();
    expect(sentSteps()[0].system).toContain('NSFW DEF');
    expect(sentSteps()[0].system).not.toContain('CSAM DEF');
  });

  it('scans csam from the profile once the gate is review', async () => {
    csamMode('review');
    await scanTexts();
    expect(sentSteps()[0].system).toContain('CSAM DEF');
  });

  it('never filters an explicit labels override', async () => {
    csamMode();
    await scanTexts({ labels: ['csam'] });
    expect(sentSteps()[0].system).toContain('CSAM DEF');
  });
});

describe('putLabelModes', () => {
  const parse = (extra: Record<string, unknown> = {}) =>
    textScanHarnessSchema.parse({
      action: 'putLabelModes',
      label: 'minor',
      mode: 'review',
      ...extra,
    });
  beforeEach(() => {
    vi.mocked(setTextScanLabelMode).mockReset();
    vi.mocked(setTextScanCsamMode).mockReset();
  });

  it('sets one label mode as the authenticated moderator and returns the stored modes', async () => {
    vi.mocked(setTextScanLabelMode).mockResolvedValue({ minor: 'review' });
    const res = await runTextScanHarnessAction(parse(), { moderatorId: 5 });
    expect(setTextScanLabelMode).toHaveBeenCalledWith('minor', 'review', { moderatorId: 5 });
    expect(res).toEqual({ kind: 'json', body: { labelModes: { minor: 'review' } } });
  });

  it('ignores a moderator id asserted in the body', async () => {
    vi.mocked(setTextScanLabelMode).mockResolvedValue({});
    await runTextScanHarnessAction(parse({ moderatorId: 99 }), { moderatorId: 5 });
    expect(setTextScanLabelMode).toHaveBeenCalledWith('minor', 'review', { moderatorId: 5 });
  });

  it('is refused without an authenticated moderator, even when the body names one', async () => {
    await expect(runTextScanHarnessAction(parse({ moderatorId: 5 }), {})).rejects.toThrow(
      'moderator id is required'
    );
    expect(setTextScanLabelMode).not.toHaveBeenCalled();
  });

  it('sets csam to off or review, and refuses auto for csam and off for poi/minor', async () => {
    vi.mocked(setTextScanCsamMode).mockResolvedValue('off');
    const res = await runTextScanHarnessAction(parse({ label: 'csam', mode: 'off' }), {
      moderatorId: 5,
    });
    expect(setTextScanCsamMode).toHaveBeenCalledWith('off', { moderatorId: 5 });
    expect(setTextScanLabelMode).not.toHaveBeenCalled();
    expect(res).toEqual({ kind: 'json', body: { csamMode: 'off' } });
    expect(parse({ label: 'csam', mode: 'review' })).toMatchObject({ label: 'csam' });
    const auto = textScanHarnessSchema.safeParse({
      action: 'putLabelModes',
      label: 'csam',
      mode: 'auto',
    });
    expect(auto.success).toBe(false);
    expect(JSON.stringify(auto.error?.issues)).toContain('csam has no auto mode');
    expect(
      textScanHarnessSchema.safeParse({ action: 'putLabelModes', label: 'minor', mode: 'off' })
        .success
    ).toBe(false);
  });

  it('rejects a label that has no mode and a mode that does not exist', () => {
    expect(
      textScanHarnessSchema.safeParse({ action: 'putLabelModes', label: 'nsfw', mode: 'review' })
        .success
    ).toBe(false);
    expect(
      textScanHarnessSchema.safeParse({ action: 'putLabelModes', label: 'minor', mode: 'hold' })
        .success
    ).toBe(false);
  });
});

describe('text-scan harness with the retired ModelRules type', () => {
  it.each([
    { action: 'sampleShadow', label: 'nsfw' },
    { action: 'quoteEntities', entityIds: [1] },
  ])('refuses $action for ModelRules instead of reading its leftover rows', async (rest) => {
    await expect(run({ ...rest, entityType: 'ModelRules' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('no profile registered'),
    });
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });
});
