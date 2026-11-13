import { beforeEach, describe, expect, it, vi } from 'vitest';
import { calledHybridNodes } from '~/__tests__/mocks/hybrid';
import type * as FliptClient from '~/server/flipt/client';

// The shadow verdict is routed by the marker the submit puts on the workflow. If the real submit
// drops or reshapes it, every shadow callback falls into the ordinary path and nothing is recorded.

const { mockSubmitWorkflow, isFlipt } = vi.hoisted(() => ({
  mockSubmitWorkflow: vi.fn(),
  isFlipt: vi.fn(),
}));

vi.mock('@civitai/orchestration-client', async () => ({
  ...(await import('./civitai-client.stub')).civitaiClientStub(),
  submitWorkflow: mockSubmitWorkflow,
  WorkflowStatus: {},
  TimeSpan: { fromDays: vi.fn(), fromHours: vi.fn() },
}));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt,
}));

const { readShadowSexualPromptMetadata, submitShadowSexualPromptScan } = await import(
  '~/server/services/shadow-sexual-prompt.service'
);

beforeEach(() => {
  vi.clearAllMocks();
  isFlipt.mockResolvedValue(true);
  mockSubmitWorkflow.mockResolvedValue({ data: { id: 'wf-1' }, response: { status: 200 } });
});

describe('the shadow submit, through the real XGuard request', () => {
  it('posts a workflow whose metadata the callback reads back as the shadow, with no entity', async () => {
    await submitShadowSexualPromptScan({
      id: 31,
      type: 'image',
      nsfwLevel: 2,
      meta: { prompt: 'a lighthouse at dusk', negativePrompt: 'blurry' },
    });

    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
    const { body } = mockSubmitWorkflow.mock.calls[0][0];
    expect(readShadowSexualPromptMetadata(body.metadata)).toMatchObject({
      kind: 'sexual-prompt',
      imageId: 31,
      currentNsfwLevel: 2,
      onSite: false,
    });
    expect(body.metadata).toMatchObject({ mode: 'prompt', recordForReview: false });
    expect(body.metadata).not.toHaveProperty('entityType');
    expect(body.metadata).not.toHaveProperty('entityId');
    expect(body.steps[0].input).toMatchObject({
      labels: ['Sexual'],
      positivePrompt: 'a lighthouse at dusk',
    });
    expect(calledHybridNodes(['dbRead', 'dbWrite'])).toEqual([]);
  });
});
