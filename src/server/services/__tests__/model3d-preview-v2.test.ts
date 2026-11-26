import { beforeEach, describe, expect, it, vi } from 'vitest';

const orch = vi.hoisted(() => ({ submitWorkflow: vi.fn(), getWorkflow: vi.fn() }));
vi.mock('@civitai/orchestration-client', async () => ({
  ...(
    await import('~/server/services/orchestrator/__tests__/civitai-client.stub')
  ).civitaiClientStub(),
  // A client per token, so the system client is told apart from a user's.
  createCivitaiClient: ({ auth }: { auth: string }) => ({ auth }),
  submitWorkflow: orch.submitWorkflow,
  getWorkflow: orch.getWorkflow,
}));

import {
  Model3dPreviewRejectedError,
  readModel3DPreview,
  submitModel3DPreview,
} from '~/server/services/model3d-rating-v2.service';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';

const mesh = {
  url: 'https://orchestration.civitai.com/v2/consumer/blobs/MESH-0.glb',
  format: 'glb',
};
const image = (i: number) => ({
  url: `https://orchestration.civitai.com/v2/consumer/blobs/P${i}-0.png`,
});

describe('the four-angle render on the orchestrator', () => {
  beforeEach(() => {
    orch.submitWorkflow.mockReset();
    orch.getWorkflow.mockReset();
  });

  it('is asked for on the system token, free to the user, with four explicit poses', async () => {
    orch.submitWorkflow.mockResolvedValue({
      data: { id: 'pv-1', status: 'processing', steps: [] },
    });
    expect(await submitModel3DPreview(mesh, { kind: 'test' })).toEqual({
      workflowId: 'pv-1',
      state: { status: 'running' },
    });
    const call = orch.submitWorkflow.mock.calls[0][0];
    expect(call.client).toBe(internalOrchestratorClient);
    expect(call.body.currencies).toEqual([]);
    expect(call.body.steps).toHaveLength(1);
    expect(call.body.steps[0]).toMatchObject({
      $type: 'model3DPreview',
      input: { model: mesh.url, format: 'glb' },
    });
    const poses = call.body.steps[0].input.cameraPoses as { yaw: number }[];
    expect(new Set(poses.map((p) => p.yaw)).size).toBe(4);
  });

  it('a finished render answers the urls it returned; a failed one answers none', async () => {
    orch.getWorkflow.mockResolvedValue({
      data: {
        status: 'succeeded',
        steps: [{ $type: 'model3DPreview', output: { images: [image(0), null, image(2)] } }],
      },
    });
    expect(await readModel3DPreview('pv-1')).toEqual({
      status: 'done',
      urls: [image(0).url, image(2).url],
    });
    orch.getWorkflow.mockResolvedValue({ data: { status: 'failed', steps: [] } });
    expect(await readModel3DPreview('pv-1')).toEqual({ status: 'done', urls: [] });
    orch.getWorkflow.mockResolvedValue({ data: { status: 'scheduled', steps: [] } });
    expect(await readModel3DPreview('pv-1')).toEqual({ status: 'running' });
  });

  it('a 4xx answer is a rejection; a 5xx may follow an accepted submit, so it is not', async () => {
    orch.submitWorkflow.mockResolvedValue({
      data: undefined,
      error: {},
      response: { status: 400 },
    });
    await expect(submitModel3DPreview(mesh, { kind: 'test' })).rejects.toBeInstanceOf(
      Model3dPreviewRejectedError
    );
    orch.submitWorkflow.mockResolvedValue({
      data: undefined,
      error: {},
      response: { status: 504 },
    });
    const lost = await submitModel3DPreview(mesh, { kind: 'test' }).catch((e) => e);
    expect(lost).toBeInstanceOf(Error);
    expect(lost).not.toBeInstanceOf(Model3dPreviewRejectedError);
  });

  it('an orchestrator error throws instead of answering a state', async () => {
    orch.getWorkflow.mockResolvedValue({ data: undefined, error: { status: 500 } });
    await expect(readModel3DPreview('pv-1')).rejects.toThrow();
  });
});
