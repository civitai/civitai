import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The Studio's auto-label is free to the user: it must be submitted with the system client, and
 *  a poll must never hand one user another user's workflow. */

const orch = vi.hoisted(() => ({ submitWorkflow: vi.fn(), getWorkflow: vi.fn() }));
vi.mock('@civitai/orchestration-client', () => ({
  submitWorkflow: orch.submitWorkflow,
  getWorkflow: orch.getWorkflow,
}));
vi.mock('~/server/services/orchestrator/client', () => ({
  internalOrchestratorClient: { system: true },
}));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import {
  pollStudioAutoLabel,
  STUDIO_AUTO_LABEL_DAILY_ITEMS,
  submitStudioAutoLabel,
} from '~/server/services/training-studio-auto-label.service';

const counters = new Map<string, number>();
const quotaKey = () =>
  `${REDIS_SYS_KEYS.TRAINING.STUDIO_AUTO_LABEL_DAILY}:7:${new Date().toISOString().slice(0, 10)}`;

const items = [{ mediaUrl: 'https://image.example.com/a.png', key: 'a.png' }];

describe('Training Studio auto-label', () => {
  beforeEach(() => {
    orch.submitWorkflow.mockReset().mockResolvedValue({ data: { id: 'wf-1' } });
    orch.getWorkflow.mockReset();
    counters.clear();
    redisMock.sysRedis.incrBy.mockImplementation(async (k: string, n: number) => {
      counters.set(k, (counters.get(k) ?? 0) + n);
      return counters.get(k)!;
    });
    redisMock.sysRedis.decrBy.mockImplementation(async (k: string, n: number) => {
      counters.set(k, (counters.get(k) ?? 0) - n);
      return counters.get(k)!;
    });
  });

  it('submits with the system client and stamps the submitting user', async () => {
    await expect(
      submitStudioAutoLabel({ userId: 7, mode: 'tag', media: 'image', items })
    ).resolves.toEqual({ workflowId: 'wf-1' });
    const call = orch.submitWorkflow.mock.calls[0][0];
    expect(call.client).toEqual({ system: true });
    expect(call.body.metadata).toEqual({ kind: 'studio-auto-label', userId: 7 });
    expect(call.body.steps).toHaveLength(1);
    expect(call.body.steps[0]).toMatchObject({ $type: 'wdTagging', metadata: { key: 'a.png' } });
  });

  it('refuses a media URL that is not public HTTPS before submitting', async () => {
    await expect(
      submitStudioAutoLabel({
        userId: 7,
        mode: 'tag',
        media: 'image',
        items: [{ mediaUrl: 'https://127.0.0.1/a.png', key: 'a' }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(orch.submitWorkflow).not.toHaveBeenCalled();
  });

  it("reads another user's workflow as missing", async () => {
    orch.getWorkflow.mockResolvedValue({
      data: { id: 'wf-1', status: 'succeeded', metadata: { kind: 'studio-auto-label', userId: 8 } },
    });
    await expect(pollStudioAutoLabel({ userId: 7, workflowId: 'wf-1' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('maps an owned workflow to per-key results', async () => {
    orch.getWorkflow.mockResolvedValue({
      data: {
        id: 'wf-1',
        status: 'succeeded',
        metadata: { kind: 'studio-auto-label', userId: 7 },
        steps: [
          {
            status: 'succeeded',
            metadata: { key: 'a.png' },
            output: { tags: { cat: 0.4, dog: 0.9 } },
          },
        ],
      },
    });
    await expect(pollStudioAutoLabel({ userId: 7, workflowId: 'wf-1' })).resolves.toEqual({
      done: true,
      results: [{ key: 'a.png', status: 'succeeded', tags: ['dog', 'cat'] }],
    });
  });

  it("refuses a batch past the user's daily item quota, and doesn't count it", async () => {
    counters.set(quotaKey(), STUDIO_AUTO_LABEL_DAILY_ITEMS - 1);
    const two = [
      { mediaUrl: 'https://image.example.com/a.png', key: 'a' },
      { mediaUrl: 'https://image.example.com/b.png', key: 'b' },
    ];
    await expect(
      submitStudioAutoLabel({ userId: 7, mode: 'tag', media: 'image', items: two })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(orch.submitWorkflow).not.toHaveBeenCalled();
    expect(counters.get(quotaKey())).toBe(STUDIO_AUTO_LABEL_DAILY_ITEMS - 1);
    // One more item still fits.
    await submitStudioAutoLabel({ userId: 7, mode: 'tag', media: 'image', items });
    expect(orch.submitWorkflow).toHaveBeenCalledTimes(1);
  });

  it('gives the items back when the submit fails', async () => {
    orch.submitWorkflow.mockResolvedValue({ data: undefined, error: { status: 500 } });
    await expect(
      submitStudioAutoLabel({ userId: 7, mode: 'tag', media: 'image', items })
    ).rejects.toBeDefined();
    expect(counters.get(quotaKey())).toBe(0);
  });
});
