import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromptModule from '~/server/services/text-scan/prompt';
import '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

vi.mock('~/server/services/text-scan/profiles/index', () => ({}));
vi.mock('~/server/services/text-scan/prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof PromptModule>()),
  getTextScanConfig: vi.fn(),
}));

const { runTextScanHarnessAction, textScanHarnessSchema } = await import(
  '~/server/services/text-scan/harness'
);
const { getTextScanConfig } = await import('~/server/services/text-scan/prompt');
const { submitWorkflow } = await import('@civitai/orchestration-client');

const CONFIG = { model: 'air:test', maxInputChars: 1000, maxSegments: 10, thinking: false };
const INPUT = {
  action: 'suggestModelRuleAliases',
  subject: 'Alpha Beta',
  description: 'A description',
  existingAliases: ['Gamma Delta'],
};

const run = async (input: Record<string, unknown> = INPUT) =>
  ((await runTextScanHarnessAction(textScanHarnessSchema.parse(input), { moderatorId: 1 })) as any)
    .body as Record<string, any>;

const reply = (content: unknown, status = 'succeeded', finishReason = 'stop') => ({
  data: {
    id: 'wf-1',
    status,
    cost: { total: 5 },
    steps: [
      {
        $type: 'chatCompletion',
        status,
        output: {
          choices: [
            {
              message: { content: typeof content === 'string' ? content : JSON.stringify(content) },
              finishReason,
            },
          ],
        },
      },
    ],
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTextScanConfig).mockResolvedValue(CONFIG);
});

describe('suggestModelRuleAliases schema', () => {
  it('accepts a rule and defaults the existing aliases', () => {
    expect(
      textScanHarnessSchema.parse({ action: 'suggestModelRuleAliases', subject: ' Alpha ' })
    ).toMatchObject({ subject: 'Alpha', description: '', existingAliases: [] });
  });

  it.each([
    ['no subject', { subject: ' ' }],
    ['subject over the word cap', { subject: 'a b c d e f g h i' }],
    ['alias over the cap', { existingAliases: ['a b c d e f g h i'] }],
    ['too many aliases', { existingAliases: Array.from({ length: 101 }, (_, i) => `alias ${i}`) }],
  ])('rejects %s', (_, patch) => {
    expect(textScanHarnessSchema.safeParse({ ...INPUT, ...patch }).success).toBe(false);
  });
});

describe('suggestModelRuleAliases', () => {
  it('runs one web-search chat completion and returns the filtered suggestions', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue(
      reply({
        suggestions: [
          { alias: 'alpha_beta', kind: 'other', note: null, source: null },
          {
            alias: 'Delta Sigma',
            kind: 'stage_name',
            note: 'a note',
            source: 'https://example.com',
          },
        ],
      }) as never
    );

    const body = await run();

    expect(submitWorkflow).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(submitWorkflow).mock.calls[0][0] as any;
    expect(sent.body.steps).toHaveLength(1);
    const step = sent.body.steps[0];
    expect(step.$type).toBe('chatCompletion');
    expect(step.input.model).toBe('air:test');
    expect(step.input.tools).toEqual([{ type: 'civitai:web_search' }]);
    expect(step.input.responseFormat.type).toBe('json_schema');
    expect(body).toEqual({
      ok: true,
      suggestions: [
        { alias: 'Delta Sigma', kind: 'stage_name', note: 'a note', source: 'https://example.com' },
      ],
      costTotal: 5,
    });
  });

  it('reports a malformed model answer instead of guessing', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue(reply('Sure, here you go') as never);
    const body = await run();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/unreadable|not valid/i);
  });

  it('reports a workflow that failed or is still running, and does not retry', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue(reply('', 'failed') as never);
    expect((await run()).ok).toBe(false);
    vi.mocked(submitWorkflow).mockResolvedValue(reply('', 'processing') as never);
    const body = await run();
    expect(body).toMatchObject({ ok: false });
    expect(body.error).toMatch(/still processing/);
    expect(submitWorkflow).toHaveBeenCalledTimes(2);
  });

  it('reports a submit error', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue({ data: undefined, error: 'boom' } as never);
    expect(await run()).toMatchObject({ ok: false, error: 'boom' });
  });
});
