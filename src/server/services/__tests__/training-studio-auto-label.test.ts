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

import {
  pollStudioAutoLabel,
  submitStudioAutoLabel,
} from '~/server/services/training-studio-auto-label.service';

const items = [{ mediaUrl: 'https://image.example.com/a.png', key: 'a.png' }];

describe('Training Studio auto-label', () => {
  beforeEach(() => {
    orch.submitWorkflow.mockReset().mockResolvedValue({ data: { id: 'wf-1' } });
    orch.getWorkflow.mockReset();
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
});
