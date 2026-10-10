import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromptModule from '~/server/services/text-scan/prompt';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as AdaptersModule from '~/server/services/moderation-adapters';
import type * as ModelRulesModule from '~/server/services/text-scan/model-rules';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

// @civitai/client is mocked globally in src/__tests__/setup.ts (submitWorkflow/getWorkflow are vi.fn()).
vi.mock('~/server/services/text-scan/profiles/index', () => ({}));
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(),
}));
vi.mock('~/server/services/moderation-adapters', async (importOriginal) => ({
  ...(await importOriginal<typeof AdaptersModule>()),
  getModerationAdapter: vi.fn(),
}));
vi.mock('~/server/services/text-scan/prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof PromptModule>()),
  getActiveTextScanPrompts: vi.fn(),
  getTextScanConfig: vi.fn(),
}));
vi.mock('~/server/services/text-scan/model-rules', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelRulesModule>()),
  getModelRulesForPrompt: vi.fn(),
  getModelRuleSnapshots: vi.fn(),
}));

const { scanEntity, scanModelAndRules, textScanContentHash } = await import(
  '~/server/services/text-scan/submit'
);
const { handleTextScanCallback } = await import('~/server/services/text-scan/callback');
const { registerTextScanProfile } = await import('~/server/services/text-scan/profiles');
const { submitWorkflow, getWorkflow } = await import('@civitai/client');
const { getModerationAdapter } = await import('~/server/services/moderation-adapters');
const { getTextScanMode } = await import('~/server/services/text-scan/mode');
const { getActiveTextScanPrompts, getTextScanConfig } = await import(
  '~/server/services/text-scan/prompt'
);
const { getModelRulesForPrompt, getModelRuleSnapshots, modelRulesFingerprint } = await import(
  '~/server/services/text-scan/model-rules'
);

const PROMPTS = {
  base: { id: 1, key: 'base', content: 'BASE PROMPT' },
  'label:modelRules': { id: 5, key: 'label:modelRules', content: 'RULES DEF' },
};
const CONFIG = { model: 'air:test', maxInputChars: 1000, thinking: false };
const RULES = [
  { id: 3, subject: 'Example', description: 'Desc', aliases: [], updatedAt: 1 },
  { id: 8, subject: 'Other', description: '', aliases: [], updatedAt: 2 },
];
const load = vi.fn();
registerTextScanProfile({ entityType: 'ModelRules', labels: ['modelRules'], load });

const adapter = { resolveContent: vi.fn(), submit: vi.fn(), applyTextScan: vi.fn() };
const em = dbMock.dbWrite.entityModeration;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTextScanMode).mockResolvedValue('active');
  vi.mocked(getActiveTextScanPrompts).mockResolvedValue(PROMPTS);
  vi.mocked(getTextScanConfig).mockResolvedValue(CONFIG);
  vi.mocked(getModelRulesForPrompt).mockResolvedValue(RULES);
  vi.mocked(getModerationAdapter).mockReturnValue(adapter as any);
  load.mockResolvedValue(
    new Map([[7, { fields: [{ heading: 'Name', text: 'Some model' }], declared: {} }]])
  );
  em.findUnique.mockResolvedValue(null);
  em.upsert.mockResolvedValue({} as any);
  em.updateMany.mockResolvedValue({ count: 1 });
  vi.mocked(submitWorkflow).mockResolvedValue({ data: { id: 'wf-1' } } as any);
  redisMock.redis.set.mockResolvedValue('OK');
});

describe('scanEntity — ModelRules', () => {
  it('submits the rule list and records which rules the prompt carried', async () => {
    await expect(scanEntity({ entityType: 'ModelRules', entityId: 7 })).resolves.toEqual({
      status: 'submitted',
      workflowId: 'wf-1',
    });
    const body = vi.mocked(submitWorkflow).mock.calls[0][0].body!;
    expect(body.metadata).toMatchObject({
      emEntityType: 'ModelRules',
      labels: ['modelRules'],
      ruleIds: [3, 8],
      rulesFingerprint: modelRulesFingerprint(RULES),
    });
    const system = (body.steps[0] as any).input.messages[0].content as string;
    expect(system).toContain('### Rules\n[3] Example — Desc\n[8] Other');
  });

  it('does not submit while no rule is enabled', async () => {
    vi.mocked(getModelRulesForPrompt).mockResolvedValue([]);
    await expect(scanEntity({ entityType: 'ModelRules', entityId: 7 })).resolves.toEqual({
      status: 'skipped',
      reason: 'missing-prompt',
    });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('skips a model the profile does not load (not public)', async () => {
    load.mockResolvedValue(new Map());
    await expect(scanEntity({ entityType: 'ModelRules', entityId: 7 })).resolves.toEqual({
      status: 'skipped',
      reason: 'missing',
    });
  });
});

describe('scanEntity — ModelRules stale verdict', () => {
  it('clears a match when the text left to scan is empty', async () => {
    load.mockResolvedValue(
      new Map([[7, { fields: [{ heading: 'Name', text: ' ' }], declared: {} }]])
    );
    em.findUnique.mockResolvedValue({
      workflowId: 'wf-0',
      status: 'Succeeded',
      nsfwLevel: null,
      triggeredLabels: ['modelRules'],
      result: { version: 1 },
    } as any);
    await expect(scanEntity({ entityType: 'ModelRules', entityId: 7 })).resolves.toEqual({
      status: 'skipped',
      reason: 'too-short',
    });
    const { data } = em.updateMany.mock.calls[0][0];
    expect(data.triggeredLabels).toEqual([]);
    expect(data.result.labels).toEqual({ modelRules: { matched: [] } });
  });
});

describe('textScanContentHash', () => {
  const base = { user: 'u', promptIds: { base: 1 }, model: 'm', thinking: false };

  it('is unchanged for scans without rules, and moves with the rule set', () => {
    const plain = textScanContentHash(base);
    expect(textScanContentHash({ ...base, rulesFingerprint: undefined })).toBe(plain);
    const a = textScanContentHash({ ...base, rulesFingerprint: 'a' });
    expect(a).not.toBe(plain);
    expect(textScanContentHash({ ...base, rulesFingerprint: 'b' })).not.toBe(a);
  });
});

describe('handleTextScanCallback — ModelRules', () => {
  const metadata = {
    entityType: 'ModelRules',
    entityId: 7,
    emEntityType: 'ModelRules',
    mode: 'active',
    externalId: 'ts-ModelRules-7-abc-0-0',
    labels: ['modelRules'],
    promptIds: { base: 1, modelRules: 5 },
    model: 'air:test',
    ruleIds: [3, 8],
    rulesFingerprint: 'fp',
  };
  const workflow = (parsed: unknown) => ({
    data: {
      metadata,
      tags: ['text-scan', 'ModelRules', 'active'],
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

  it('acts only on rules the prompt listed, and stores the matched rules as they read', async () => {
    vi.mocked(getModelRuleSnapshots).mockResolvedValue([
      { id: 3, subject: 'Example', description: 'Desc', aliases: [] },
    ]);
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow({
        modelRules: {
          matched: [
            { ruleId: 3, reason: 'Names the subject.' },
            { ruleId: 42, reason: 'Invented.' },
          ],
        },
      }) as any
    );

    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });

    expect(getModelRuleSnapshots).toHaveBeenCalledWith([3]);
    const { data } = em.updateMany.mock.calls[0][0];
    expect(data.triggeredLabels).toEqual(['modelRules']);
    expect(data.result).toMatchObject({
      labels: { modelRules: { matched: [{ ruleId: 3, reason: 'Names the subject.' }] } },
      modelRules: {
        fingerprint: 'fp',
        snapshot: [{ id: 3, subject: 'Example', description: 'Desc', aliases: [] }],
      },
    });
    expect(adapter.applyTextScan).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: expect.objectContaining({
          modelRules: { matched: [{ ruleId: 3, reason: 'Names the subject.' }] },
        }),
      })
    );
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'scan-verdict', tags: 'modelRules,modelRules:3' })
    );
  });

  it('acts on nothing for a workflow submitted before rule ids were recorded', async () => {
    vi.mocked(getModelRuleSnapshots).mockResolvedValue([]);
    const { ruleIds: _ruleIds, ...legacy } = metadata;
    vi.mocked(getWorkflow).mockResolvedValue({
      ...workflow({ modelRules: { matched: [{ ruleId: 3, reason: 'r' }] } }),
      data: {
        ...workflow({ modelRules: { matched: [{ ruleId: 3, reason: 'r' }] } }).data,
        metadata: legacy,
      },
    } as any);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(em.updateMany.mock.calls[0][0].data.triggeredLabels).toEqual([]);
  });

  it('drops a match on a rule disabled since the submit', async () => {
    vi.mocked(getModelRuleSnapshots).mockResolvedValue([]);
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow({ modelRules: { matched: [{ ruleId: 3, reason: 'Names the subject.' }] } }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    const { data } = em.updateMany.mock.calls[0][0];
    expect(data.triggeredLabels).toEqual([]);
    expect(data.result.labels.modelRules.matched).toEqual([]);
  });

  it('treats a verdict whose only match was invented as clean', async () => {
    // Echoes whatever it is asked for, so only the prompt-id filter can drop the invented id.
    vi.mocked(getModelRuleSnapshots).mockImplementation(async (ids) =>
      ids.map((id) => ({ id, subject: 'S', description: '', aliases: [] }))
    );
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow({ modelRules: { matched: [{ ruleId: 42, reason: 'Invented.' }] } }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(em.updateMany.mock.calls[0][0].data.triggeredLabels).toEqual([]);
  });
});

describe('scanModelAndRules', () => {
  it('queues both scans, and the rules scan only when asked', async () => {
    vi.mocked(getTextScanMode).mockResolvedValue('off');
    scanModelAndRules(9);
    await vi.waitFor(() => expect(getTextScanMode).toHaveBeenCalledTimes(2));
    expect(vi.mocked(getTextScanMode).mock.calls).toEqual([
      ['Model', 9],
      ['ModelRules', 9],
    ]);

    vi.mocked(getTextScanMode).mockClear();
    scanModelAndRules(9, { rules: false });
    await vi.waitFor(() => expect(getTextScanMode).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(vi.mocked(getTextScanMode).mock.calls).toEqual([['Model', 9]]);
  });
});
