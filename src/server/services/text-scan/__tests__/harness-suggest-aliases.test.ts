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
const { submitWorkflow, getWorkflow } = await import('@civitai/orchestration-client');

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

const WORKFLOW_ID = 'wf_0123456789abcdef';
const reply = (
  content: unknown,
  status = 'succeeded',
  finishReason = 'stop',
  tags = ['model-rule-aliases']
) => ({
  data: {
    id: WORKFLOW_ID,
    status,
    tags,
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

const RESULT_INPUT = {
  action: 'aliasSuggestionResult',
  workflowId: WORKFLOW_ID,
  subject: 'Alpha Beta',
  existingAliases: ['Gamma Delta'],
};
const answer = {
  suggestions: [
    { alias: 'alpha_beta', kind: 'other', note: null, source: null },
    { alias: 'Delta Sigma', kind: 'stage_name', note: 'a note', source: 'https://example.com' },
  ],
};

describe('aliasSuggestionResult schema', () => {
  it('accepts a workflow id and the rule it was submitted for', () => {
    expect(textScanHarnessSchema.parse(RESULT_INPUT)).toMatchObject({ workflowId: WORKFLOW_ID });
  });

  it.each([
    ['empty', ''],
    ['a path', '../x'],
    ['spaces', 'a b c d e f g h'],
    ['too long', 'a'.repeat(129)],
  ])('rejects a workflow id that is %s', (_, workflowId) => {
    expect(textScanHarnessSchema.safeParse({ ...RESULT_INPUT, workflowId }).success).toBe(false);
  });
});

describe('suggestModelRuleAliases', () => {
  it('submits one tagged web-search chat completion and returns pending with the workflow id', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue(reply('', 'processing') as never);

    const body = await run();

    expect(submitWorkflow).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(submitWorkflow).mock.calls[0][0] as any;
    expect(sent.query.wait).toBeLessThanOrEqual(10);
    expect(sent.body.tags).toContain('model-rule-aliases');
    expect(sent.body.steps).toHaveLength(1);
    const step = sent.body.steps[0];
    expect(step.$type).toBe('chatCompletion');
    expect(step.input.model).toBe('air:test');
    expect(step.input.tools).toEqual([{ type: 'civitai:web_search' }]);
    expect(step.input.responseFormat.type).toBe('json_schema');
    expect(body).toEqual({ ok: true, status: 'pending', workflowId: WORKFLOW_ID });
  });

  it('returns the filtered suggestions when the workflow finished within the short wait', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue(reply(answer) as never);
    expect(await run()).toEqual({
      ok: true,
      status: 'done',
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

  it('reports a workflow that already failed, and does not retry', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue(reply('', 'failed') as never);
    expect(await run()).toMatchObject({ ok: false, workflowId: WORKFLOW_ID });
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
  });

  it('reports a submit error', async () => {
    vi.mocked(submitWorkflow).mockResolvedValue({ data: undefined, error: 'boom' } as never);
    expect(await run()).toMatchObject({ ok: false, error: 'boom' });
  });
});

describe('aliasSuggestionResult', () => {
  const poll = () => run(RESULT_INPUT);

  it('is pending while the workflow runs, without submitting anything', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(reply('', 'processing') as never);
    expect(await poll()).toEqual({ ok: true, status: 'pending', workflowId: WORKFLOW_ID });
    expect(submitWorkflow).not.toHaveBeenCalled();
    expect((vi.mocked(getWorkflow).mock.calls[0][0] as any).path).toEqual({
      workflowId: WORKFLOW_ID,
    });
  });

  it('is pending while the workflow is queued', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(reply('', 'unassigned') as never);
    expect(await poll()).toMatchObject({ ok: true, status: 'pending' });
  });

  it('returns the suggestions filtered against the rule once it finished', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(reply(answer) as never);
    expect(await poll()).toEqual({
      ok: true,
      status: 'done',
      suggestions: [
        { alias: 'Delta Sigma', kind: 'stage_name', note: 'a note', source: 'https://example.com' },
      ],
      costTotal: 5,
    });
  });

  it('reports a failed workflow with a readable error', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(reply('', 'failed') as never);
    const body = await poll();
    expect(body).toMatchObject({ ok: true, status: 'failed' });
    expect(body.error).toMatch(/failed/);
  });

  it('reports a malformed answer as failed', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(reply('Sure, here you go') as never);
    expect(await poll()).toMatchObject({ ok: true, status: 'failed' });
  });

  it('refuses a workflow this feature did not create', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(
      reply(answer, 'succeeded', 'stop', ['text-scan']) as never
    );
    const body = await poll();
    expect(body).toMatchObject({ ok: false });
    expect(body).not.toHaveProperty('suggestions');
  });

  it('reports a workflow that cannot be read', async () => {
    vi.mocked(getWorkflow).mockResolvedValue({ data: undefined, error: 'nope' } as never);
    expect(await poll()).toMatchObject({ ok: false });
  });
});
