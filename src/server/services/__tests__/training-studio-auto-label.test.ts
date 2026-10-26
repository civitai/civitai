import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Training Studio's auto-label is advertised as free: it must submit on the system client with no
 * user currency, and stamp the caller into the metadata `getAutoLabelWorkflow` scopes the poll by.
 * Import graph stubbed as in `training-assert-safe-media-urls.test.ts`.
 */

const { SYSTEM_CLIENT } = vi.hoisted(() => ({ SYSTEM_CLIENT: { system: true } }));

vi.mock('@civitai/orchestration-client', () => ({
  handleError: vi.fn(),
  submitWorkflow: vi.fn(async () => ({ data: { id: 'wf-1' } })),
  getWorkflow: vi.fn(),
}));
vi.mock('@aws-sdk/lib-storage', () => {
  const Upload = class {};
  return { Upload, default: { Upload } };
});
vi.mock('~/server/db/db-lag-helpers', () => ({ preventModelVersionLag: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: {} }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/schema/training.schema', () => ({ trainingServiceStatusSchema: {} }));
vi.mock('~/server/services/orchestrator/client', () => ({
  internalOrchestratorClient: SYSTEM_CLIENT,
}));
vi.mock('~/utils/s3-utils', () => ({
  deleteObject: vi.fn(),
  getB2S3Client: vi.fn(),
  getGetUrl: vi.fn(),
  getPutUrl: vi.fn(),
  getS3Client: vi.fn(),
  isB2Url: vi.fn(),
  parseKey: vi.fn(),
}));
vi.mock('~/server/http/orchestrator/orchestrator.caller', () => ({
  getOrchestratorCaller: vi.fn(),
}));

import { getWorkflow, submitWorkflow } from '@civitai/orchestration-client';
import {
  getAutoLabelWorkflow,
  submitStudioAutoLabelWorkflow,
} from '~/server/services/training.service';

const USER_ID = 42;

beforeEach(() => vi.clearAllMocks());

describe('submitStudioAutoLabelWorkflow', () => {
  it('bills the system account and stamps the caller for the poll', async () => {
    await expect(
      submitStudioAutoLabelWorkflow({
        userId: USER_ID,
        mediaType: 'image',
        images: [{ mediaUrl: 'https://orchestration.civitai.com/v2/blob/a.png', filename: 'k0' }],
        params: { type: 'caption', temperature: 0.7, maxNewTokens: 300 },
      })
    ).resolves.toEqual({ workflowId: 'wf-1', stepCount: 1 });

    const [{ client, body }] = vi.mocked(submitWorkflow).mock.calls[0] as unknown as [
      {
        client: unknown;
        body: { currencies: unknown; metadata: unknown; steps: unknown[]; tags: string[] };
      }
    ];
    expect(client).toBe(SYSTEM_CLIENT);
    expect(body.currencies).toEqual([]);
    expect(body.metadata).toMatchObject({
      kind: 'auto-label',
      userId: USER_ID,
      source: 'training-studio',
    });
    expect(body.metadata).not.toHaveProperty('modelId');
    // Training lists match on `training`; a labelling batch must not show up as a run.
    expect(body.tags).not.toContain('training');
    expect(body.steps).toMatchObject([{ $type: 'mediaCaptioning', metadata: { filename: 'k0' } }]);
  });

  it("is readable by its owner's poll and not by another user's", async () => {
    vi.mocked(getWorkflow).mockResolvedValue({
      data: {
        id: 'wf-1',
        status: 'succeeded',
        metadata: { kind: 'auto-label', userId: USER_ID, source: 'training-studio' },
      },
    } as never);
    await expect(
      getAutoLabelWorkflow({ userId: USER_ID, workflowId: 'wf-1' })
    ).resolves.toMatchObject({ status: 'succeeded' });
    await expect(getAutoLabelWorkflow({ userId: 7, workflowId: 'wf-1' })).rejects.toThrow(
      'Workflow not found'
    );
  });
});
