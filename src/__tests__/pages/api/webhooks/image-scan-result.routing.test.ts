import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageScanningResultService from '~/server/services/image-scanning-result.service';

const mocks = vi.hoisted(() => ({
  getWorkflow: vi.fn(),
  captureJobFailureReason: vi.fn(),
  processImageScanWorkflow: vi.fn(),
  processImageScanningWorkflow: vi.fn(),
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));
vi.mock('@civitai/client', () => ({ getWorkflow: mocks.getWorkflow }));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlagsLazy: () => ({ articleImageScanning: true }),
}));
vi.mock('~/server/prom/client', () => ({ imageScanWebhookCounter: { inc: vi.fn() } }));
// Both pipelines import the whole ingestion stack; this suite pins only the routing between them.
vi.mock('~/server/services/image-scan-pipeline', () => ({
  captureJobFailureReason: mocks.captureJobFailureReason,
  LEGACY_SCAN_LOG: { name: 'image-scan-result', source: 'image-scan-result.service' },
}));
vi.mock('~/server/services/image-scan-result.service', () => ({
  processImageScanWorkflow: mocks.processImageScanWorkflow,
}));
// The real `isImageScanningWorkflow` makes the routing decision under test.
vi.mock('~/server/services/image-scanning-result.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageScanningResultService>()),
  processImageScanningWorkflow: mocks.processImageScanningWorkflow,
}));
vi.mock('~/server/services/scanner-audit.service', () => ({ recordImageScanningResult: vi.fn() }));
vi.mock('~/server/services/job-queue.service', () => ({ removeImageScanJobQueue: vi.fn() }));
vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  computePerceptualHash: vi.fn(),
}));
vi.mock('~/server/utils/webhook-debounce', () => ({ fanOutArticleImageUpdates: vi.fn() }));

import handler from '~/pages/api/webhooks/image-scan-result';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const call = async (body: unknown) => {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  await (handler as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
    { method: 'POST', body } as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return res;
};
const deliver = (status: string, steps: unknown[]) => {
  mocks.getWorkflow.mockResolvedValue({
    data: { metadata: { imageId: 7 }, startedAt: 'start', completedAt: 'end', steps },
  });
  return call({ workflowId: 'wf', status });
};
const pipelineInput = (status: string, steps: unknown[]) => ({
  workflowId: 'wf',
  status,
  steps,
  imageId: 7,
  articleImageScanning: true,
  startedAt: 'start',
  completedAt: 'end',
});

describe('image-scan-result webhook routing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stashes a job failure reason without fetching the workflow', async () => {
    const event = { workflowId: 'wf', jobId: 'job', reason: 'timed out' };
    const res = await call(event);

    expect(mocks.captureJobFailureReason).toHaveBeenCalledWith(event);
    expect(mocks.getWorkflow).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('sends an imageScanning workflow to the imageScanning pipeline, failed or not', async () => {
    const steps = [{ $type: 'imageScanning', status: 'failed' }];
    await deliver('failed', steps);

    expect(mocks.processImageScanningWorkflow).toHaveBeenCalledTimes(1);
    expect(mocks.processImageScanningWorkflow).toHaveBeenCalledWith(pipelineInput('failed', steps));
    expect(mocks.processImageScanWorkflow).not.toHaveBeenCalled();
  });

  it('sends a wdTagging + mediaRating workflow to the legacy pipeline', async () => {
    const steps = [
      { $type: 'wdTagging', output: { tags: {} } },
      { $type: 'mediaRating', output: { nsfwLevel: 'pg' } },
    ];
    await deliver('succeeded', steps);

    expect(mocks.processImageScanWorkflow).toHaveBeenCalledTimes(1);
    expect(mocks.processImageScanWorkflow).toHaveBeenCalledWith(pipelineInput('succeeded', steps));
    expect(mocks.processImageScanningWorkflow).not.toHaveBeenCalled();
  });

  it('rejects a workflow it cannot load or that carries no imageId', async () => {
    mocks.getWorkflow.mockResolvedValueOnce({ data: undefined });
    const missing = await call({ workflowId: 'wf', status: 'succeeded' });
    expect(missing.status).toHaveBeenCalledWith(400);
    expect(missing.send).toHaveBeenCalledWith({ error: 'could not find workflow: wf' });

    mocks.getWorkflow.mockResolvedValueOnce({ data: { metadata: {}, steps: [] } });
    const noImage = await call({ workflowId: 'wf', status: 'succeeded' });
    expect(noImage.send).toHaveBeenCalledWith({
      error: 'missing workflow metadata.imageId - wf',
    });
  });

  it.each([
    ['imageScanning', [{ $type: 'imageScanning' }], 'image-scanning-result'],
    ['legacy', [{ $type: 'wdTagging' }, { $type: 'mediaRating' }], 'image-scan-result'],
  ])('logs a %s pipeline failure under its own name', async (_, steps, name) => {
    const pipeline =
      name === 'image-scanning-result'
        ? mocks.processImageScanningWorkflow
        : mocks.processImageScanWorkflow;
    pipeline.mockRejectedValueOnce(new Error('boom'));
    const res = await deliver('succeeded', steps);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name, type: 'error', message: 'boom' })
    );
  });

  it('acknowledges a result for an image deleted since the scan was submitted', async () => {
    mocks.processImageScanningWorkflow.mockRejectedValueOnce(new Error('image not found: 7'));
    const res = await deliver('succeeded', [{ $type: 'imageScanning', output: {} }]);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, skipped: 'deleted' });
  });
});
