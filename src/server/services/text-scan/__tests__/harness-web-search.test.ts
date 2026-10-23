import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromptModule from '~/server/services/text-scan/prompt';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

vi.mock('~/server/services/text-scan/profiles/index', () => ({}));
vi.mock('~/server/services/text-scan/prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof PromptModule>()),
  getActiveTextScanPrompts: vi.fn(),
  getTextScanConfig: vi.fn(),
}));

const { runTextScanHarnessAction, textScanHarnessSchema } = await import(
  '~/server/services/text-scan/harness'
);
const { registerTextScanProfile } = await import('~/server/services/text-scan/profiles');
const { buildTextScanSteps, planTextScanPasses } = await import(
  '~/server/services/text-scan/submit'
);
const { composeTextScanMessages, getActiveTextScanPrompts, getTextScanConfig } = await import(
  '~/server/services/text-scan/prompt'
);
const { submitWorkflow } = await import('@civitai/orchestration-client');

const PROMPTS = {
  base: { id: 1, key: 'base', content: 'BASE PROMPT' },
  'label:nsfw': { id: 2, key: 'label:nsfw', content: 'NSFW DEF' },
  'label:poi': { id: 3, key: 'label:poi', content: 'POI DEF' },
  'label:minor': { id: 4, key: 'label:minor', content: 'MINOR DEF' },
};
const CONFIG = { model: 'air:test', maxInputChars: 1000, maxSegments: 10, thinking: false };
const SUBJECT = {
  fields: [{ heading: 'Name', text: 'A character model with enough text to scan' }],
  declared: {},
};

registerTextScanProfile({
  entityType: 'Model',
  labels: ['nsfw', 'poi', 'minor'],
  load: async (ids) => new Map(ids.map((id) => [id, SUBJECT])),
});
registerTextScanProfile({
  entityType: 'Post',
  labels: ['nsfw'],
  load: async (ids) => new Map(ids.map((id) => [id, SUBJECT])),
});

const run = async (input: Record<string, unknown>) =>
  ((await runTextScanHarnessAction(textScanHarnessSchema.parse(input), { moderatorId: 1 })) as any)
    .body as Record<string, any>;
const sentSteps = () => vi.mocked(submitWorkflow).mock.calls[0][0].body!.steps as any[];

const succeeded = (parsed: unknown) => ({
  data: {
    id: 'wf-1',
    status: 'succeeded',
    cost: { total: 7 },
    steps: [
      {
        $type: 'chatCompletion',
        name: 'textScan',
        status: 'succeeded',
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

describe('text-scan harness web-search pass', () => {
  it('builds the steps production builds for its web-search pass', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue(succeeded({}) as never);
    await run({
      action: 'scanEntity',
      entityType: 'Model',
      entityId: 1,
      pass: 'web-search',
      promptOverrides: { 'label:minor': 'OVERRIDDEN MINOR DEF' },
    });

    const searchPass = planTextScanPasses(['nsfw', 'poi', 'minor'], 'active', 'active').find(
      (p) => p.variant === 'web-search'
    )!;
    const composed = composeTextScanMessages({
      prompts: { ...PROMPTS, 'label:minor': { id: 0, key: 'label:minor', content: 'OVERRIDDEN' } },
      labels: searchPass.labels,
      subject: SUBJECT,
      maxInputChars: CONFIG.maxInputChars,
      maxSegments: CONFIG.maxSegments,
    });
    const steps = sentSteps();
    expect(steps[0].input.tools).toEqual([{ type: 'civitai:web_search' }]);
    expect(steps[0].input.model).toBe(CONFIG.model);
    expect(steps[0].input.responseFormat).toEqual(
      buildTextScanSteps({
        system: composed.system,
        segments: composed.segments,
        model: CONFIG.model,
        labels: searchPass.labels,
        thinking: false,
        webSearch: true,
      })[0].input.responseFormat
    );
    expect(steps[0].input.messages[0].content).toContain('OVERRIDDEN MINOR DEF');
    expect(steps[0].input.messages[0].content).toContain('POI DEF');
    expect(steps[0].input.messages[0].content).not.toContain('NSFW DEF');
  });

  it('keeps the main pass free of the tool and of the search-only narrowing', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue(succeeded({}) as never);
    const res = await run({ action: 'scanEntity', entityType: 'Model', entityId: 1 });
    expect(sentSteps()[0].input.tools).toBeUndefined();
    expect(sentSteps()[0].input.messages[0].content).toContain('NSFW DEF');
    expect(res).toMatchObject({ pass: 'main', labels: ['nsfw', 'poi', 'minor'] });
  });

  it('returns the pass, its labels, the per-label verdicts and the cost', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue(
      succeeded({
        poi: { detected: true, reason: 'a real person', names: ['Some Person'] },
        minor: { detected: false, reason: 'adult', names: [] },
      }) as never
    );
    const res = await run({
      action: 'scanEntity',
      entityType: 'Model',
      entityId: 1,
      pass: 'web-search',
    });
    expect(res).toMatchObject({
      ok: true,
      pass: 'web-search',
      labels: ['poi', 'minor'],
      costTotal: 7,
      parse: {
        ok: true,
        output: {
          poi: { detected: true, reason: 'a real person', names: ['Some Person'] },
          minor: { detected: false },
        },
      },
    });
  });

  it('adds the tool to the quote so pricing reflects the search pass', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue({ data: { id: 'q', cost: { total: 3 } } } as never);
    const res = await run({
      action: 'quoteEntities',
      entityType: 'Model',
      entityIds: [1],
      pass: 'web-search',
    });
    expect(sentSteps()[0].input.tools).toEqual([{ type: 'civitai:web_search' }]);
    expect(res.results[0]).toMatchObject({ ok: true, pass: 'web-search', costTotal: 3 });
  });

  it('applies to free text scans', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue(succeeded({}) as never);
    await run({
      action: 'scanTexts',
      entityType: 'Model',
      texts: [{ key: 'a', fields: [{ heading: 'Name', text: 'A character model' }] }],
      pass: 'web-search',
    });
    expect(sentSteps()[0].input.tools).toEqual([{ type: 'civitai:web_search' }]);
  });

  it('refuses the pass for an entity type that has none, before submitting', async () => {
    await expect(
      run({ action: 'scanEntity', entityType: 'Post', entityId: 1, pass: 'web-search' })
    ).rejects.toThrow(/no web-search pass/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('never writes an EntityModeration row', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue(succeeded({}) as never);
    await run({ action: 'scanEntity', entityType: 'Model', entityId: 1, pass: 'web-search' });
    const em = dbMock.dbWrite.entityModeration;
    for (const method of ['create', 'upsert', 'update', 'updateMany', 'createMany'] as const)
      expect(em[method]).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});
