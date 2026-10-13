import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromptModule from '~/server/services/text-scan/prompt';
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
const { registerTextScanProfile } = await import('~/server/services/text-scan/profiles');
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
});
