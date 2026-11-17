import { describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/env.mock';

vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(async () => []),
}));
vi.mock('~/server/redis/caches', () => ({
  modelTagCache: { fetch: vi.fn(async () => ({})) },
}));

import { modelWebhooks } from '~/server/webhooks/model.webooks';

const EPOCH_URL = 'https://orchestration.example.test/blobs/epoch-3.safetensors';

const model = () => ({
  id: 1,
  name: 'm',
  user: { username: 'u', image: null },
  modelVersions: [
    {
      id: 10,
      files: [
        {
          id: 5,
          type: 'Model',
          visibility: 'Public',
          url: 'https://storage.example.test/model/7/m.safetensors',
          metadata: {
            format: 'SafeTensor',
            size: 'full',
            fp: 'fp16',
            quantType: 'Q4_K_M',
            isRequired: true,
            selectedEpochUrl: EPOCH_URL,
            trainingResults: { epochs: [{ modelUrl: EPOCH_URL }] },
          },
        },
      ],
    },
  ],
});

describe.each(['new-model', 'updated-model'] as const)('%s webhook payload', (event) => {
  it("carries a file's metadata without its training epoch URLs", async () => {
    const [payload] = await modelWebhooks[event].getData({
      lastSent: new Date(0),
      prisma: { model: { findMany: vi.fn(async () => [model()]) } },
    } as never);

    expect(payload.modelVersions[0]?.files[0].metadata).toEqual({
      format: 'SafeTensor',
      size: 'full',
      fp: 'fp16',
      quantType: 'Q4_K_M',
      isRequired: true,
    });
  });

  it('sends a file with no metadata', async () => {
    const withoutMetadata = model();
    (withoutMetadata.modelVersions[0].files[0] as { metadata: unknown }).metadata = null;
    const [payload] = await modelWebhooks[event].getData({
      lastSent: new Date(0),
      prisma: { model: { findMany: vi.fn(async () => [withoutMetadata]) } },
    } as never);

    expect(payload.modelVersions[0]?.files[0].metadata).toBeNull();
  });
});
