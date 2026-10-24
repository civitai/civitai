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

import { previewTextScanNsfw } from '~/server/services/text-scan/preview';

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
