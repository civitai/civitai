import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The training wizard's auto-label upload URL is a consumer upload of the user's own media, so it is
 * minted with the requesting user's orchestrator token, like the generator's source-image uploads.
 * The upload is then attributed to and processed for that user. A presign minted with the shared
 * system client carries no user, so the upload is processed as a system upload instead.
 *
 * The heavy training.service import graph is stubbed the way
 * `training.orchestrator-error-mapping.test.ts` does it. The orchestrator client module is replaced
 * so the test can tell the system client from a client built for one user's token.
 */

const h = vi.hoisted(() => ({
  internalClient: { kind: 'internal' },
  presign: vi.fn(),
  getUserToken: vi.fn(async () => USER_TOKEN),
}));
const USER_TOKEN = 'orchestrator-token-of-the-requesting-user';

vi.mock('@civitai/orchestration-client', () => ({
  getConsumerBlobUploadUrl: h.presign,
  handleError: vi.fn((e: unknown) => (typeof e === 'string' ? e : undefined)),
  submitWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/client', () => ({
  internalOrchestratorClient: h.internalClient,
  createOrchestratorClient: vi.fn((token: string) => ({ kind: 'user', token })),
}));
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

import { getAutoLabelUploadUrl } from '~/server/services/training.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Pairwise distinct, so a swapped or hardcoded id cannot pass.
const MODEL_ID = 991;
const USER_ID = 42;
const OTHER_USER_ID = 7;

const ownModel = (userId: number) =>
  dbMock.dbRead.model.findUnique.mockResolvedValue({
    id: MODEL_ID,
    userId,
    deletedAt: null,
    uploadType: 'Trained',
  } as never);

const request = () =>
  getAutoLabelUploadUrl({
    modelId: MODEL_ID,
    userId: USER_ID,
    getUserToken: h.getUserToken,
  } as Parameters<typeof getAutoLabelUploadUrl>[0]);

beforeEach(() => {
  vi.clearAllMocks();
  h.presign.mockResolvedValue({
    data: { uploadUrl: 'https://upload.example/u?sig=1', expiresAt: '2026-01-01T00:00:00Z' },
    error: undefined,
    response: { status: 200 },
  });
});

describe('getAutoLabelUploadUrl', () => {
  it("mints the presign with the requesting user's orchestrator token, not the system client", async () => {
    ownModel(USER_ID);

    await expect(request()).resolves.toEqual({
      uploadUrl: 'https://upload.example/u?sig=1',
      expiresAt: '2026-01-01T00:00:00Z',
    });

    expect(h.getUserToken).toHaveBeenCalledTimes(1);
    expect(h.presign).toHaveBeenCalledTimes(1);
    const [{ client }] = h.presign.mock.calls[0] as [{ client: unknown }];
    expect(client).not.toBe(h.internalClient);
    expect(client).toEqual({ kind: 'user', token: USER_TOKEN });
  });

  // Invariant guard (holds before and after the change): no token is minted for, and no presign
  // requested by, someone who does not own the model.
  it('mints nothing for a caller who does not own the model', async () => {
    ownModel(OTHER_USER_ID);

    await expect(request()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(h.getUserToken).not.toHaveBeenCalled();
    expect(h.presign).not.toHaveBeenCalled();
  });
});
