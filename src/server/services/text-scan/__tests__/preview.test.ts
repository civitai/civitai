import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import type * as TextScanPrompt from '~/server/services/text-scan/prompt';

const { mockSubmitWorkflow } = vi.hoisted(() => ({ mockSubmitWorkflow: vi.fn() }));

// The package's ESM build can't be loaded by `importOriginal` here; every suite fakes it whole.
vi.mock('@civitai/orchestration-client', () => ({
  createCivitaiClient: vi.fn(() => ({})),
  submitWorkflow: mockSubmitWorkflow,
}));

vi.mock('~/server/services/text-scan/prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanPrompt>()),
  getActiveTextScanPrompts: vi.fn(async () => ({
    base: { id: 1, key: 'base', content: 'BASE PROMPT' },
    'label:nsfw': { id: 2, key: 'label:nsfw', content: 'NSFW DEF' },
  })),
  getTextScanConfig: vi.fn(async () => ({
    model: 'civitai/test-model',
    maxInputChars: 200000,
    maxSegments: 10,
    thinking: false,
  })),
}));

import {
  previewComFaceIntent,
  previewTextScanEach,
  previewTextScanNsfw,
} from '~/server/services/text-scan/preview';
import { getActiveTextScanPrompts } from '~/server/services/text-scan/prompt';

const reply = (content: unknown, status = 'succeeded') => ({
  data: {
    id: 'wf',
    status,
    steps: [
      {
        $type: 'chatCompletion',
        name: 'textScan',
        status,
        output: { choices: [{ message: { content: JSON.stringify(content) } }] },
      },
    ],
  },
});

const fields = [{ heading: 'Name', text: 'Lingerie Pinup Pack' }];

describe('previewTextScanNsfw', () => {
  beforeEach(() => {
    mockSubmitWorkflow.mockReset();
  });

  it("returns the classifier's level and reason for the text", async () => {
    mockSubmitWorkflow.mockResolvedValue(reply({ nsfw: { level: 'x', reason: 'names nudity' } }));
    await expect(previewTextScanNsfw({ fields, waitSeconds: 10 })).resolves.toEqual({
      status: 'ok',
      level: NsfwLevel.X,
      reason: 'names nudity',
    });
  });

  it("scans with production's model and only the nsfw label, and registers no callback", async () => {
    mockSubmitWorkflow.mockResolvedValue(reply({ nsfw: { level: 'none', reason: 'clean' } }));
    await previewTextScanNsfw({ fields, waitSeconds: 10 });

    const { body, query } = mockSubmitWorkflow.mock.calls[0][0];
    expect(query).toEqual({ wait: 10 });
    expect(body.callbacks).toBeUndefined();
    expect(body.steps[0].input.model).toBe('civitai/test-model');
    expect(body.steps[0].input.messages[0].content).toContain('NSFW DEF');
    expect(body.steps[0].input.messages[1].content).toContain('Lingerie Pinup Pack');
  });

  it('is unavailable when the workflow does not finish or the answer does not parse', async () => {
    mockSubmitWorkflow.mockResolvedValueOnce(reply({}, 'processing'));
    expect(await previewTextScanNsfw({ fields, waitSeconds: 10 })).toEqual({
      status: 'unavailable',
    });

    mockSubmitWorkflow.mockResolvedValueOnce(reply('not json at all'));
    expect(await previewTextScanNsfw({ fields, waitSeconds: 10 })).toEqual({
      status: 'unavailable',
    });
  });
});

describe('previewComFaceIntent', () => {
  beforeEach(() => {
    mockSubmitWorkflow.mockReset();
  });

  it('reports unavailable without submitting when the prompt row is missing', async () => {
    await expect(previewComFaceIntent({ fields, waitSeconds: 10 })).resolves.toEqual({
      status: 'unavailable',
    });
    expect(mockSubmitWorkflow).not.toHaveBeenCalled();
  });

  it("returns the label's verdict when its prompt row exists", async () => {
    vi.mocked(getActiveTextScanPrompts).mockResolvedValueOnce({
      base: { id: 1, key: 'base', content: 'BASE PROMPT' },
      'label:model-com-face-intent': { id: 3, key: 'label:model-com-face-intent', content: 'STUB' },
    });
    mockSubmitWorkflow.mockResolvedValue(
      reply({ 'model-com-face-intent': { detected: true, reason: 'stub reason' } })
    );
    await expect(previewComFaceIntent({ fields, waitSeconds: 10 })).resolves.toEqual({
      status: 'ok',
      output: { detected: true, reason: 'stub reason' },
    });
  });
});

describe('previewTextScanEach', () => {
  beforeEach(() => {
    mockSubmitWorkflow.mockReset();
  });

  const strings = ['alpha', 'beta', 'gamma', 'delta'].map((text) => ({ heading: 'Word', text }));
  const step = (segment: number, choice: Record<string, unknown>, status = 'succeeded') => ({
    $type: 'chatCompletion',
    name: segment ? `textScan${segment}` : 'textScan',
    metadata: { segment },
    status,
    output: { choices: [choice] },
  });
  const answer = (level: string) => ({
    message: { content: JSON.stringify({ nsfw: { level, reason: '' } }) },
  });

  it('submits one step per string, each holding only its own string', async () => {
    mockSubmitWorkflow.mockResolvedValue({ data: { status: 'succeeded', steps: [] } });
    await previewTextScanEach({ labels: ['nsfw'], fields: strings, waitSeconds: 10 });

    const { steps } = mockSubmitWorkflow.mock.calls[0][0].body;
    expect(
      steps.map((s: { input: { messages: { content: string }[] } }) => s.input.messages[1].content)
    ).toEqual([
      expect.stringContaining('alpha'),
      expect.stringContaining('beta'),
      expect.stringContaining('gamma'),
      expect.stringContaining('delta'),
    ]);
    expect(steps[0].input.messages[1].content).not.toContain('beta');
  });

  it('reads each step on its own: a refusal, a bad answer or a missing step affects only its string', async () => {
    mockSubmitWorkflow.mockResolvedValue({
      data: {
        status: 'failed',
        steps: [
          step(3, answer('x')),
          step(1, { message: { content: '' }, finishReason: 'content_filter' }),
          step(0, answer('none')),
          step(2, { message: { content: 'not json' } }),
        ],
      },
    });
    const results = await previewTextScanEach({
      labels: ['nsfw'],
      fields: strings,
      waitSeconds: 10,
    });
    expect(results).toEqual([
      { status: 'ok', output: { nsfw: { level: 'none', reason: '' } } },
      { status: 'refused' },
      { status: 'unavailable' },
      { status: 'ok', output: { nsfw: { level: 'x', reason: '' } } },
    ]);

    mockSubmitWorkflow.mockResolvedValue({
      data: {
        status: 'processing',
        steps: [step(0, answer('none')), step(1, answer('none'), 'processing')],
      },
    });
    expect(
      await previewTextScanEach({ labels: ['nsfw'], fields: strings.slice(0, 3), waitSeconds: 10 })
    ).toEqual([
      { status: 'ok', output: { nsfw: { level: 'none', reason: '' } } },
      { status: 'unavailable' },
      { status: 'unavailable' },
    ]);
  });

  it('marks a string too long for one step as too-long and still rates the others', async () => {
    mockSubmitWorkflow.mockResolvedValue({
      data: { status: 'succeeded', steps: [step(0, answer('none'))] },
    });
    const results = await previewTextScanEach({
      labels: ['nsfw'],
      fields: [{ heading: 'Word', text: 'x'.repeat(200_001) }, strings[0]],
      waitSeconds: 10,
    });
    expect(results).toEqual([
      { status: 'too-long' },
      { status: 'ok', output: { nsfw: { level: 'none', reason: '' } } },
    ]);
    expect(mockSubmitWorkflow.mock.calls[0][0].body.steps).toHaveLength(1);
  });

  it('gives no verdict to any string when a requested label has no prompt', async () => {
    const results = await previewTextScanEach({
      labels: ['nsfw', 'csam'],
      fields: strings.slice(0, 2),
      waitSeconds: 10,
    });
    expect(results).toEqual([{ status: 'unavailable' }, { status: 'unavailable' }]);
    expect(mockSubmitWorkflow).not.toHaveBeenCalled();
  });
});
