import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { buildBaseModelAttestation } from '~/shared/constants/base-model-attestation.constants';

// The private publish of a trained version is a publish too: H3 needs the attestation there as well.
// Scaffold mirrors model-version.controller.publish-guards.test.ts.

const { mockGetVersionById } = vi.hoisted(() => ({ mockGetVersionById: vi.fn() }));

vi.mock('~/server/services/model-version.service', () => ({
  getVersionById: mockGetVersionById,
  publishModelVersionById: vi.fn(),
  updateModelVersionById: vi.fn(),
}));
vi.mock('~/server/services/model.service', () => ({
  getModel: vi.fn(),
  queueModelEarlyAccessReindex: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/training.service', () => ({}));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: { refresh: vi.fn() } }));

import { publishPrivateModelVersionHandler } from '~/server/controllers/model-version.controller';

const H3 = 'MiniMax H3';
const VERSION_ID = 100;
const OWNER_ID = 7;

const callPrivate = ({ baseModel = H3, meta = {} as unknown } = {}) => {
  mockGetVersionById.mockResolvedValue({
    id: VERSION_ID,
    status: 'Draft',
    uploadType: 'Trained',
    baseModel,
    publishedAt: null,
    meta,
    model: {
      id: 42,
      type: 'LORA',
      publishedAt: new Date(),
      availability: 'Private',
      userId: OWNER_ID,
      status: 'Published',
      meta: {},
    },
    files: [{ id: 1, metadata: {} }],
    posts: [{ id: 5 }],
  });

  return publishPrivateModelVersionHandler({
    input: { id: VERSION_ID },
    ctx: { user: { id: OWNER_ID, isModerator: false } },
  } as never);
};

beforeEach(() => {
  vi.clearAllMocks();
  // The epoch-file read is the step after the gate.
  dbMock.dbWrite.modelFile.findMany.mockRejectedValue(new Error('reached the file check'));
});

describe('publishPrivateModelVersionHandler — H3 attestation', () => {
  it('refuses an unattested H3 LoRA before reading its files', async () => {
    await expect(callPrivate()).rejects.toThrowError(/right to train and share/);
    expect(dbMock.dbWrite.modelFile.findMany).not.toHaveBeenCalled();
  });

  it('lets an attested one through', async () => {
    await expect(
      callPrivate({ meta: { baseModelAttestation: buildBaseModelAttestation(OWNER_ID, H3) } })
    ).rejects.toThrowError('reached the file check');
  });

  it('lets a non-H3 LoRA through without one (control)', async () => {
    await expect(callPrivate({ baseModel: 'SDXL 1.0' })).rejects.toThrowError(
      'reached the file check'
    );
  });
});
