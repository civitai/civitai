import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as ModelRulesModule from '~/server/services/text-scan/model-rules';
import type * as PromptModule from '~/server/services/text-scan/prompt';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

vi.mock('~/server/services/text-scan/profiles/index', () => ({}));
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  readTextScanRollouts: vi.fn(async () => ({})),
  readTextScanLabelModes: vi.fn(async () => ({ minor: 'review' })),
  readTextScanCsamMode: vi.fn(async () => 'review'),
}));
vi.mock('~/server/services/text-scan/prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof PromptModule>()),
  getActiveTextScanPrompts: vi.fn(),
  getTextScanConfig: vi.fn(),
  insertTextScanPrompt: vi.fn(),
}));
vi.mock('~/server/services/text-scan/model-rules', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelRulesModule>()),
  getEnabledModelRules: vi.fn(),
}));

const { runTextScanHarnessAction, textScanHarnessSchema } = await import(
  '~/server/services/text-scan/harness'
);
const { registerTextScanProfile } = await import('~/server/services/text-scan/profiles');
const { submitWorkflow } = await import('@civitai/orchestration-client');
const { getActiveTextScanPrompts, getTextScanConfig, insertTextScanPrompt } = await import(
  '~/server/services/text-scan/prompt'
);
const { applyModelRuleOverrides, getEnabledModelRules } = await import(
  '~/server/services/text-scan/model-rules'
);

registerTextScanProfile({
  entityType: 'CommentV2',
  labels: ['scam'],
  load: async () => new Map(),
});

const PROMPTS = {
  base: { id: 1, key: 'base', content: 'BASE PROMPT' },
  'label:scam': { id: 6, key: 'label:scam', content: 'SCAM DEF' },
};
const CONFIG = { model: 'air:test', maxInputChars: 1000, thinking: false };
const LIVE = [
  { id: 3, subject: 'Example', description: 'Desc', aliases: [], updatedAt: 1 },
  { id: 8, subject: 'Other', description: '', aliases: [], updatedAt: 2 },
];
const override = (id: number, subject: string, enabled = true) => ({
  id,
  subject,
  description: '',
  aliases: [],
  enabled,
});
const workflow = (parsed: unknown) => ({
  data: {
    id: 'wf-1',
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
const run = (body: Record<string, unknown>, moderatorId = 5) =>
  runTextScanHarnessAction(textScanHarnessSchema.parse(body), { moderatorId });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getActiveTextScanPrompts).mockResolvedValue(PROMPTS);
  vi.mocked(getTextScanConfig).mockResolvedValue(CONFIG);
  vi.mocked(getEnabledModelRules).mockResolvedValue(LIVE);
});

describe('applyModelRuleOverrides', () => {
  it('replaces a rule in place, drops a disabled one and appends new ones', () => {
    expect(
      applyModelRuleOverrides(LIVE, [
        override(8, 'Other', false),
        override(3, 'Example edited'),
        override(-1, 'Brand new'),
      ]).map((r) => [r.id, r.subject])
    ).toEqual([
      [3, 'Example edited'],
      [-1, 'Brand new'],
    ]);
  });

  it('appends a saved rule that is not live (disabled, now enabled in the draft)', () => {
    expect(applyModelRuleOverrides(LIVE, [override(12, 'Re-enabled')]).map((r) => r.id)).toEqual([
      3, 8, 12,
    ]);
  });

  it('returns the live list untouched without overrides', () => {
    expect(applyModelRuleOverrides(LIVE, undefined)).toBe(LIVE);
    expect(applyModelRuleOverrides(LIVE, [])).toBe(LIVE);
  });
});

describe('literalModelRules', () => {
  const texts = [
    { key: 'a', fields: [{ heading: 'Name', text: 'a model by Brand new' }] },
    { key: 'b', fields: [{ heading: 'Name', text: 'nothing to see' }] },
  ];

  it('lists the rules in force once and the matches per text, with where they sit', async () => {
    const { body } = (await run({
      action: 'literalModelRules',
      texts,
      ruleOverrides: [
        override(3, 'Example edited'),
        override(8, 'Other', false),
        override(-1, 'Brand new'),
      ],
    })) as { body: Record<string, any> };

    expect(body.rules).toEqual([
      { id: 3, subject: 'Example edited' },
      { id: -1, subject: 'Brand new' },
    ]);
    expect(body.results).toEqual([
      {
        key: 'a',
        matches: [
          { ruleId: -1, term: 'Brand new', field: 'Name', fieldIndex: 0, start: 11, end: 20 },
        ],
      },
      { key: 'b', matches: [] },
    ]);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('judges against the saved rules without overrides', async () => {
    vi.mocked(getEnabledModelRules).mockResolvedValue([
      { id: 3, subject: 'Other', description: '', aliases: ['Brand new'], updatedAt: 1 },
    ]);
    const { body } = (await run({ action: 'literalModelRules', texts })) as {
      body: Record<string, any>;
    };
    expect(body.results[0].matches).toMatchObject([{ ruleId: 3, term: 'Brand new' }]);
  });

  it('drops ruleOverrides from every other action instead of acting on them', () => {
    const parsed = textScanHarnessSchema.parse({
      action: 'scanTexts',
      entityType: 'CommentV2',
      texts,
      ruleOverrides: [override(-1, 'Brand new')],
    });
    expect(parsed).not.toHaveProperty('ruleOverrides');
  });

  it('refuses duplicate rule ids, id 0 and more than 500 overrides', () => {
    for (const ruleOverrides of [
      [override(-1, 'A'), override(-1, 'B')],
      [override(0, 'Zero')],
      Array.from({ length: 501 }, (_, i) => override(-(i + 1), `R${i}`)),
    ])
      expect(
        textScanHarnessSchema.safeParse({ action: 'literalModelRules', texts, ruleOverrides })
          .success
      ).toBe(false);
  });
});

describe('scanTexts', () => {
  it('sends the system prompt once and leaves it off each result', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue(
      workflow({ scam: { detected: false, reason: '' } }) as never
    );
    const { body } = (await run({
      action: 'scanTexts',
      entityType: 'CommentV2',
      texts: [{ key: 'c', fields: [{ heading: 'Comment', text: 'hello there' }] }],
    })) as { body: { system: string; results: Record<string, unknown>[] } };
    expect(body.system).toContain('BASE PROMPT');
    expect(body.system).toContain('SCAM DEF');
    expect(body.results[0]).not.toHaveProperty('system');
  });

  it('no longer scans the retired ModelRules type', async () => {
    await expect(
      run({
        action: 'scanTexts',
        entityType: 'ModelRules',
        texts: [{ key: 'c', fields: [{ heading: 'Name', text: 'hello there' }] }],
      })
    ).rejects.toThrow(/no profile registered/);
  });
});

describe('putPrompt', () => {
  it('passes no note and the base version through', async () => {
    vi.mocked(insertTextScanPrompt).mockResolvedValue({ id: 4, key: 'base' });
    await run({ action: 'putPrompt', key: 'base', content: 'X', baseId: 3 });
    await run({ action: 'putPrompt', key: 'base', content: 'X', note: '   ', baseId: null });
    expect(vi.mocked(insertTextScanPrompt).mock.calls).toEqual([
      [{ key: 'base', content: 'X', note: undefined, createdById: 5, baseId: 3 }],
      [{ key: 'base', content: 'X', note: undefined, createdById: 5, baseId: null }],
    ]);
  });
});

describe('getPrompts', () => {
  it('reports when each key was last saved, read from the primary', async () => {
    const createdAt = new Date('2026-10-01T00:00:00.000Z');
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ key: 'base', id: 3, createdAt, createdById: 5 }]);
    const { body } = (await run({ action: 'getPrompts' })) as { body: { latest: unknown } };
    expect(body.latest).toEqual({ base: { id: 3, createdAt, createdById: 5 } });
  });

  it('returns the per-label modes beside the rollouts', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
    const { body } = (await run({ action: 'getPrompts' })) as { body: { labelModes: unknown } };
    expect(body.labelModes).toEqual({ minor: 'review' });
  });

  it('returns the csam mode beside the poi/minor label modes', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
    const { body } = (await run({ action: 'getPrompts' })) as { body: { csamMode: unknown } };
    expect(body.csamMode).toBe('review');
  });
});
