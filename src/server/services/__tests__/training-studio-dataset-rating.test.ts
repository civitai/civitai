import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The Studio's dataset rating is free to the user: it must be submitted with the system client and
 *  no currency, and refuse media that is not an orchestrator-hosted image before submitting. */

const orch = vi.hoisted(() => ({ submitWorkflow: vi.fn() }));
vi.mock('@civitai/orchestration-client', async () => ({
  ...(
    await import('~/server/services/orchestrator/__tests__/civitai-client.stub')
  ).civitaiClientStub(),
  submitWorkflow: orch.submitWorkflow,
}));
vi.mock('~/server/services/orchestrator/client', () => ({
  internalOrchestratorClient: { system: true },
}));
const clientEnv = vi.hoisted(() => ({
  NEXT_PUBLIC_ORCHESTRATOR_ENDPOINT: 'https://orchestration.civitai.com',
}));
vi.mock('~/env/client', () => ({ env: clientEnv }));

import { rateStudioDatasetImages } from '~/server/services/training-studio-dataset-rating.service';

const signed =
  'https://orchestration.civitai.com/v2/consumer/blobs/E8S6FBPH50ENNVF2PD5-0.jpeg?sig=a1b2&exp=2026-11-18T19:00:00.0000000Z';
const ratingV2 = { status: 'ok', sexual: { label: 'S1' }, restricted: false };

describe('Training Studio dataset rating', () => {
  beforeEach(() => {
    orch.submitWorkflow.mockReset().mockResolvedValue({
      data: { id: 'wf-1', steps: [{ name: '0', status: 'succeeded', output: { ratingV2 } }] },
    });
  });

  it('submits on the system client with no currency, so the user is never charged', async () => {
    const out = await rateStudioDatasetImages({
      userId: 7,
      items: [{ mediaUrl: signed, key: 'e8s6.jpeg' }],
    });
    const call = orch.submitWorkflow.mock.calls[0][0];
    expect(call.client).toEqual({ system: true });
    expect(call.body.currencies).toEqual([]);
    expect(call.body.steps[0]).toMatchObject({
      $type: 'imageScanning',
      input: { image: signed, 'rater-model': 'radio-alpha' },
    });
    expect(out).toEqual({ results: [{ key: 'e8s6.jpeg', output: { ratingV2 } }] });
  });

  it('a step that has not succeeded answers no output', async () => {
    orch.submitWorkflow.mockResolvedValueOnce({
      data: { id: 'wf-1', steps: [{ name: '0', status: 'processing', output: null }] },
    });
    const out = await rateStudioDatasetImages({
      userId: 7,
      items: [{ mediaUrl: signed, key: 'k' }],
    });
    expect(out).toEqual({ results: [{ key: 'k', output: null }] });
  });

  it('an orchestrator error response is a retryable 503, not an answer of no rating', async () => {
    orch.submitWorkflow.mockResolvedValueOnce({ data: undefined, error: { status: 500 } });
    await expect(
      rateStudioDatasetImages({ userId: 7, items: [{ mediaUrl: signed, key: 'k' }] })
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it.each([
    ['another host', 'https://example.com/v2/consumer/blobs/a.png'],
    ['audio', 'https://orchestration.civitai.com/v2/consumer/blobs/a.wav'],
    ['video', 'https://orchestration.civitai.com/v2/consumer/blobs/a.mp4'],
    ['no extension', 'https://orchestration.civitai.com/v2/consumer/blobs/abc'],
  ])('refuses %s before submitting', async (_name, mediaUrl) => {
    await expect(
      rateStudioDatasetImages({ userId: 7, items: [{ mediaUrl, key: 'k' }] })
    ).rejects.toThrow();
    expect(orch.submitWorkflow).not.toHaveBeenCalled();
  });
});
