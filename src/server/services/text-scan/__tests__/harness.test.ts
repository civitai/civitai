import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromptModule from '~/server/services/text-scan/prompt';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

// @civitai/client is mocked globally in src/__tests__/setup.ts (submitWorkflow is a vi.fn()).
vi.mock('~/server/services/text-scan/profiles/index', () => ({}));
vi.mock('~/server/services/text-scan/prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof PromptModule>()),
  getActiveTextScanPrompts: vi.fn(),
  getTextScanConfig: vi.fn(),
}));

const { runTextScanHarnessAction, textScanHarnessSchema } = await import(
  '~/server/services/text-scan/harness'
);
const { getTextScanProfile, registerTextScanProfile } = await import(
  '~/server/services/text-scan/profiles'
);
const { textScanContentHash } = await import('~/server/services/text-scan/submit');
const { composeUserText } = await import('~/server/services/text-scan/segment');
const { submitWorkflow } = await import('@civitai/client');
const { getActiveTextScanPrompts, getTextScanConfig } = await import(
  '~/server/services/text-scan/prompt'
);

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

registerTextScanProfile({
  entityType: 'ModelRules',
  labels: ['modelRules'],
  load: async (ids) =>
    new Map(
      ids.map((id) => [id, { fields: [{ heading: 'Name', text: 'Some model' }], declared: {} }])
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

  describe('a ModelRules shadow row', () => {
    const PROMPT_IDS = { base: 1, modelRules: 5 };
    const row = (storedFingerprint: string, hashedFingerprint: string) => {
      const subject = getTextScanProfile('ModelRules')!.load([1]) as Promise<Map<number, any>>;
      return subject.then((subjects) => ({
        entityId: 1,
        workflowId: 'wf-1',
        triggeredLabels: [],
        nsfwLevel: null,
        result: {
          version: 1,
          labels: { modelRules: { matched: [] } },
          promptIds: PROMPT_IDS,
          model: 'air:test',
          modelRules: { fingerprint: storedFingerprint, snapshot: [], literalRuleIds: [] },
        },
        contentHash: textScanContentHash({
          user: composeUserText(subjects.get(1)),
          promptIds: PROMPT_IDS,
          model: 'air:test',
          thinking: false,
          rulesFingerprint: hashedFingerprint,
          segmentBudget: CONFIG,
        }),
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      }));
    };
    const changed = async (stored: string, hashed: string) => {
      vi.mocked(dbMock.dbRead.$queryRaw).mockResolvedValue([await row(stored, hashed)] as never);
      const res = await run({
        action: 'sampleShadow',
        entityType: 'ModelRules',
        label: 'modelRules',
      });
      return res.items.map((i: any) => i.textChangedSinceScan);
    };

    it('is not stale when the stored fingerprint is the one the row was hashed with', async () => {
      expect(await changed('fp-a', 'fp-a')).toEqual([false]);
    });

    it('is stale when the rule set the row was hashed with differs from the stored one', async () => {
      expect(await changed('fp-b', 'fp-a')).toEqual([true]);
    });
  });
});
