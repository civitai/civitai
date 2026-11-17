import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The training wizard's auto-label submit runs on the system orchestrator token, so, like Training
 * Studio's (`training-studio-auto-label.test.ts`), it accepts only media hosted on Civitai's
 * orchestrator: the URLs the wizard's own uploads return.
 *
 * The heavy training.service import graph is stubbed the way
 * `training-assert-safe-media-urls.test.ts` does it.
 */

const h = vi.hoisted(() => ({
  submitWorkflow: vi.fn(),
  clientEnv: { NEXT_PUBLIC_ORCHESTRATOR_ENDPOINT: 'https://orchestration.civitai.com' },
}));

vi.mock('@civitai/orchestration-client', () => ({
  handleError: vi.fn((e: unknown) => (typeof e === 'string' ? e : undefined)),
  submitWorkflow: h.submitWorkflow,
}));
vi.mock('~/env/client', () => ({ env: h.clientEnv }));
// `default` is required for the pre-bundled CJS interop; its absence shows up as a
// near-empty collect rather than a failure.
vi.mock('@aws-sdk/lib-storage', () => {
  const Upload = class {};
  return { Upload, default: { Upload } };
});
vi.mock('~/server/db/db-lag-helpers', () => ({ preventModelVersionLag: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: {} }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/schema/training.schema', () => ({ trainingServiceStatusSchema: {} }));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/utils/s3-utils', () => ({
  deleteObject: vi.fn(),
  getB2S3Client: vi.fn(),
  getGetUrl: vi.fn(),
  getPutUrl: vi.fn(),
  getS3Client: vi.fn(),
  getUploadBucket: vi.fn(),
  isB2Url: vi.fn(),
  parseKey: vi.fn(),
}));
vi.mock('~/server/http/orchestrator/orchestrator.caller', () => ({
  getOrchestratorCaller: vi.fn(),
}));

import { submitAutoLabelWorkflow } from '~/server/services/training.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const MODEL_ID = 991;
const USER_ID = 42;

// The shape the orchestrator returns for a presigned consumer upload.
const UPLOADED =
  'https://orchestration.civitai.com/v2/consumer/blobs/E8S6FBPH50ENNVF2PD5-0.jpeg?sig=a1b2c3&exp=2026-11-08T19:00:00.0000000Z';
const EXTERNAL = 'https://example.com/a.png';

const submit = (...mediaUrls: string[]) =>
  submitAutoLabelWorkflow({
    userId: USER_ID,
    modelId: MODEL_ID,
    mediaType: 'image',
    images: mediaUrls.map((mediaUrl, i) => ({ mediaUrl, filename: `${i}.png` })),
    params: { type: 'tag', threshold: 0.4 },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.model.findUnique.mockResolvedValue({
    id: MODEL_ID,
    userId: USER_ID,
    deletedAt: null,
    uploadType: 'Trained',
  } as never);
  h.submitWorkflow.mockResolvedValue({ data: { id: 'wf-1' } });
});

describe('submitAutoLabelWorkflow media hosts', () => {
  it('refuses an external https media URL, and submits nothing', async () => {
    await expect(submit(EXTERNAL)).rejects.toThrow(/only accepts media uploaded to Civitai/);
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a batch when any one URL is external', async () => {
    await expect(submit(UPLOADED, EXTERNAL)).rejects.toThrow(
      /only accepts media uploaded to Civitai/
    );
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it("accepts the URL the wizard's own upload returns", async () => {
    await expect(submit(UPLOADED)).resolves.toEqual({ workflowId: 'wf-1', stepCount: 1 });
    expect(h.submitWorkflow).toHaveBeenCalledTimes(1);
  });
});
