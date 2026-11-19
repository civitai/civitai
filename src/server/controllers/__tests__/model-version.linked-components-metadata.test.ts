import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/env.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * A version's linked components name files of other models. Their metadata comes back with the
 * version to any viewer, so it carries only the basic fields, never the linked file's training
 * epoch URLs.
 */

const { getVersionByIdWithGenerationChildren } = vi.hoisted(() => ({
  getVersionByIdWithGenerationChildren: vi.fn(),
}));

vi.mock('~/server/services/model-version-generation-children.service', () => ({
  getVersionByIdWithGenerationChildren,
}));
vi.mock('~/server/services/generation/generation.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getResourceData: vi.fn(async () => []),
  resolveCanGenerateForVersions: vi.fn(async () => new Map()),
}));
vi.mock('~/server/services/generation/coverage-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  coverageAudience: vi.fn(async () => ({ next: false, member: false })),
  coveragePairForUser: vi.fn(() => ({})),
}));
vi.mock('~/server/services/paid-access.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getViewerMonetization: vi.fn(async () => ({
    10: { paidAccess: null, licensingFee: null, sale: null },
  })),
}));
vi.mock('~/server/services/creator-membership.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOwnerMetricPrivacyDefaultsForEditor: vi.fn(async () => null),
}));

import { getModelVersionHandler } from '~/server/controllers/model-version.controller';

const EPOCH_URL = 'https://orchestration.example.test/blobs/epoch-3.safetensors';
const LINKED_FILE = 55;

beforeEach(() => {
  vi.clearAllMocks();
  getVersionByIdWithGenerationChildren.mockResolvedValue({
    id: 10,
    status: 'Published',
    availability: 'Public',
    baseModel: 'Flux.1 D',
    flags: 0,
    meta: null,
    model: {
      id: 1,
      name: 'm',
      sfwName: null,
      type: 'Checkpoint',
      status: 'Published',
      mode: null,
      poi: false,
      user: { id: 7 },
      meta: null,
    },
    recommendedResources: [
      {
        id: 3,
        resource: { id: 20 },
        settings: { isLinkedComponent: true, fileId: LINKED_FILE, componentType: 'VAE' },
      },
    ],
  });
  dbMock.dbRead.modelFile.findMany.mockResolvedValue([
    {
      id: LINKED_FILE,
      name: 'vae.safetensors',
      sizeKB: 1,
      type: 'VAE',
      metadata: {
        format: 'SafeTensor',
        size: 'full',
        fp: 'fp16',
        quantType: 'Q4_K_M',
        selectedEpochUrl: EPOCH_URL,
        trainingResults: { epochs: [{ modelUrl: EPOCH_URL }] },
      },
    },
  ] as never);
});

describe('getModelVersionHandler linked components', () => {
  it('returns only the basic metadata of a linked file to an anonymous caller', async () => {
    const version = await getModelVersionHandler({
      input: { id: 10 } as never,
      ctx: { user: undefined, features: {} } as never,
    });

    expect(version.linkedComponents).toHaveLength(1);
    expect(version.linkedComponents[0].fileMetadata).toEqual({
      format: 'SafeTensor',
      size: 'full',
      fp: 'fp16',
      quantType: 'Q4_K_M',
    });
  });
});
