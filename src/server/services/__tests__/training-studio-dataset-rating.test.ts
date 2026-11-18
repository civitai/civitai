import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The Studio's dataset rating is free to the user: it must be submitted with the system client and
 *  no currency, and refuse before submitting past the user's daily quota or for media that is not an
 *  orchestrator-hosted image. */

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

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_KEYS } from '~/server/redis/client';
import {
  rateStudioDatasetImages,
  STUDIO_DATASET_RATING_DAILY_IMAGES,
} from '~/server/services/training-studio-dataset-rating.service';

const counters = new Map<string, number>();
const quotaKey = () =>
  `${REDIS_KEYS.TRAINING_STUDIO.DATASET_RATING_DAILY}:7:${new Date().toISOString().slice(0, 10)}`;
const signed =
  'https://orchestration.civitai.com/v2/consumer/blobs/E8S6FBPH50ENNVF2PD5-0.jpeg?sig=a1b2&exp=2026-11-18T19:00:00.0000000Z';
const ratingV2 = { status: 'ok', sexual: { label: 'S1' }, restricted: false };

describe('Training Studio dataset rating', () => {
  beforeEach(() => {
    orch.submitWorkflow.mockReset().mockResolvedValue({
      data: {
        id: 'wf-1',
        steps: [{ name: '0', status: 'succeeded', output: { ratingV2 } }],
      },
    });
    counters.clear();
    redisMock.redis.incrBy.mockImplementation(async (k: string, n: number) => {
      counters.set(k, (counters.get(k) ?? 0) + n);
      return counters.get(k)!;
    });
    redisMock.redis.decrBy.mockImplementation(async (k: string, n: number) => {
      counters.set(k, (counters.get(k) ?? 0) - n);
      return counters.get(k)!;
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
    expect(call.body.metadata).toEqual({ kind: 'studio-dataset-rating', userId: 7 });
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
    expect(counters.get(quotaKey()) ?? 0).toBe(0);
  });

  it("past today's quota: refuses with 0 submits and gives the slot back", async () => {
    counters.set(quotaKey(), STUDIO_DATASET_RATING_DAILY_IMAGES);
    await expect(
      rateStudioDatasetImages({ userId: 7, items: [{ mediaUrl: signed, key: 'k' }] })
    ).rejects.toThrow(/limit/);
    expect(orch.submitWorkflow).not.toHaveBeenCalled();
    expect(counters.get(quotaKey())).toBe(STUDIO_DATASET_RATING_DAILY_IMAGES);
  });

  it('a submit that throws gives its images back to the quota', async () => {
    orch.submitWorkflow.mockRejectedValueOnce(new Error('down'));
    await expect(
      rateStudioDatasetImages({ userId: 7, items: [{ mediaUrl: signed, key: 'k' }] })
    ).rejects.toThrow('down');
    expect(counters.get(quotaKey())).toBe(0);
  });
});
