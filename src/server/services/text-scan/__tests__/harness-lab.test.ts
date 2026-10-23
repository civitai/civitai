import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as ModelProfileModule from '~/server/services/text-scan/profiles/model.profile';
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
  getModelRulesForPrompt: vi.fn(),
}));
vi.mock('~/server/services/text-scan/profiles/model.profile', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelProfileModule>()),
  loadModelScanSubjects: vi.fn(),
}));

const { runTextScanHarnessAction, textScanHarnessSchema } = await import(
  '~/server/services/text-scan/harness'
);
await import('~/server/services/text-scan/profiles/model-rules.profile');
const { registerTextScanProfile, getTextScanProfile } = await import(
  '~/server/services/text-scan/profiles'
);
const { submitWorkflow } = await import('@civitai/orchestration-client');
const { getActiveTextScanPrompts, getTextScanConfig, insertTextScanPrompt } = await import(
  '~/server/services/text-scan/prompt'
);
const { applyModelRuleOverrides, getModelRulesForPrompt } = await import(
  '~/server/services/text-scan/model-rules'
);
const { loadModelScanSubjects } = await import(
  '~/server/services/text-scan/profiles/model.profile'
);

registerTextScanProfile({
  entityType: 'CommentV2',
  labels: ['scam'],
  load: async () => new Map(),
});

const PROMPTS = {
  base: { id: 1, key: 'base', content: 'BASE PROMPT' },
  'label:modelRules': { id: 5, key: 'label:modelRules', content: 'RULES DEF' },
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
  vi.mocked(getModelRulesForPrompt).mockResolvedValue(LIVE);
  vi.mocked(submitWorkflow).mockResolvedValue(
    workflow({ modelRules: { matched: [{ ruleId: -1, reason: 'named' }] } }) as never
  );
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

describe('scanTexts with rule overrides', () => {
  const texts = [{ key: 'a', fields: [{ heading: 'Name', text: 'a model by Brand new' }] }];

  it('lists the merged rules once per request, with literal hits per text', async () => {
    const { body } = (await run({
      action: 'scanTexts',
      entityType: 'ModelRules',
      texts,
      ruleOverrides: [
        override(3, 'Example edited'),
        override(8, 'Other', false),
        override(-1, 'Brand new'),
      ],
    })) as { body: Record<string, unknown> & { results: Record<string, unknown>[] } };

    expect(body.rules).toEqual([
      { id: 3, subject: 'Example edited' },
      { id: -1, subject: 'Brand new' },
    ]);
    expect(body.system).toContain('[3] Example edited');
    expect(body.system).toContain('[-1] Brand new');
    expect(body.system).not.toContain('Other');
    expect(body.results[0]).toMatchObject({ key: 'a', ok: true, literalRuleIds: [-1] });
    expect(body.results[0]).not.toHaveProperty('system');
    expect(body.results[0]).not.toHaveProperty('rules');
  });

  it('lists the live rules without overrides', async () => {
    const { body } = (await run({ action: 'scanTexts', entityType: 'ModelRules', texts })) as {
      body: { rules: unknown };
    };
    expect(body.rules).toEqual([
      { id: 3, subject: 'Example' },
      { id: 8, subject: 'Other' },
    ]);
  });

  it('returns a system prompt and no rule list for a profile without modelRules', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue(
      workflow({ scam: { detected: false, reason: '' } }) as never
    );
    const { body } = (await run({
      action: 'scanTexts',
      entityType: 'CommentV2',
      texts: [{ key: 'c', fields: [{ heading: 'Comment', text: 'hello there' }] }],
    })) as { body: { system: string; rules: unknown; results: Record<string, unknown>[] } };
    expect(body.system).toContain('BASE PROMPT');
    expect(body.system).toContain('SCAM DEF');
    expect(body.rules).toBeNull();
    expect(body.results[0]).not.toHaveProperty('literalRuleIds');
  });

  it('refuses duplicate rule ids and id 0', () => {
    for (const ruleOverrides of [[override(-1, 'A'), override(-1, 'B')], [override(0, 'Zero')]])
      expect(
        textScanHarnessSchema.safeParse({
          action: 'scanTexts',
          entityType: 'ModelRules',
          texts,
          ruleOverrides,
        }).success
      ).toBe(false);
  });

  it('refuses more than 500 overrides', () => {
    const ruleOverrides = Array.from({ length: 501 }, (_, i) => override(-(i + 1), `R${i}`));
    expect(
      textScanHarnessSchema.safeParse({
        action: 'scanTexts',
        entityType: 'ModelRules',
        texts,
        ruleOverrides,
      }).success
    ).toBe(false);
  });
});

describe('model visibility', () => {
  beforeEach(() => {
    vi.mocked(loadModelScanSubjects).mockResolvedValue(
      new Map([[7, { fields: [{ heading: 'Name', text: 'Some model' }], declared: {} }]])
    );
  });

  it('composeEntities for ModelRules reads the model whatever its visibility', async () => {
    await run({ action: 'composeEntities', entityType: 'ModelRules', entityIds: [7] });
    expect(vi.mocked(loadModelScanSubjects).mock.calls).toEqual([[[7]]]);
  });

  it('the production ModelRules profile still loads public text only', async () => {
    await getTextScanProfile('ModelRules')!.load([7]);
    expect(loadModelScanSubjects).toHaveBeenCalledWith([7], { publicOnly: true });
  });

  it('scanEntity carries the system prompt, rule list and literal hits on its result', async () => {
    const { body } = (await run({
      action: 'scanEntity',
      entityType: 'ModelRules',
      entityId: 7,
    })) as {
      body: Record<string, unknown>;
    };
    expect(body).toMatchObject({
      entityId: 7,
      ok: true,
      rules: [
        { id: 3, subject: 'Example' },
        { id: 8, subject: 'Other' },
      ],
      literalRuleIds: [],
    });
    expect(body.system).toContain('RULES DEF');
  });
});

describe('batchEntities', () => {
  it('sends the system prompt and rule list once, with literal hits per entity', async () => {
    vi.mocked(loadModelScanSubjects).mockImplementation(
      async (ids: number[]) =>
        new Map(
          ids.map((id) => [id, { fields: [{ heading: 'Name', text: 'Some model' }], declared: {} }])
        )
    );
    const { body } = (await run({
      action: 'batchEntities',
      entityType: 'ModelRules',
      entityIds: [7, 9],
    })) as { body: Record<string, unknown> & { results: Record<string, unknown>[] } };

    expect(body.system).toContain('RULES DEF');
    expect(body.rules).toEqual([
      { id: 3, subject: 'Example' },
      { id: 8, subject: 'Other' },
    ]);
    expect(body.results).toHaveLength(2);
    for (const result of body.results) {
      expect(result).not.toHaveProperty('system');
      expect(result).not.toHaveProperty('rules');
      expect(result).toHaveProperty('literalRuleIds');
    }
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
