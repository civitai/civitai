import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: { modelFile: { findMany: vi.fn(), findFirst: vi.fn() } },
}));
vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead }));

import {
  findOfficialFilesBySize,
  findOfficialFileByHash,
} from '~/server/services/official-file.service';
import { constants } from '~/server/common/constants';

const OFFICIAL = constants.system.officialUserId;

// A standalone VAE stores its bytes as a type='Model' file inside a VAE-type model.
const officialVaeRow = {
  id: 900,
  name: 'boogu.vae.safetensors',
  sizeKB: 300_000,
  type: 'Model',
  modelVersionId: 42,
  modelVersion: { name: 'v1', modelId: 7, model: { name: 'Boogu VAE', type: 'VAE' } },
};

// A text encoder bundled inside a checkpoint: the file's own type carries the role.
const officialBundledEncoderRow = {
  id: 901,
  name: 'qwen3.encoder.safetensors',
  sizeKB: 3_400_000,
  type: 'Text Encoder',
  modelVersionId: 43,
  modelVersion: { name: 'v1', modelId: 8, model: { name: 'Z Image Base', type: 'Checkpoint' } },
};

beforeEach(() => vi.clearAllMocks());

describe('findOfficialFilesBySize', () => {
  it('scopes to the official account and the exact sizeKB', async () => {
    mockDbRead.modelFile.findMany.mockResolvedValue([{ id: 900 }]);
    const rows = await findOfficialFilesBySize(300_000);
    expect(rows).toEqual([{ id: 900 }]);
    const arg = mockDbRead.modelFile.findMany.mock.calls[0][0];
    expect(arg.where.sizeKB).toBe(300_000);
    expect(arg.where.modelVersion.model.userId).toBe(OFFICIAL);
  });
});

describe('findOfficialFileByHash', () => {
  it('matches a canonical type="Model" file and derives componentType from the official model type', async () => {
    mockDbRead.modelFile.findFirst.mockResolvedValue(officialVaeRow);
    // Pass lowercase input (as computeBlobSha256 produces); query must uppercase it to match stored UPPERCASE hex
    const match = await findOfficialFileByHash({ sha256: 'abcdef' });
    expect(match).toEqual({
      versionId: 42,
      fileId: 900,
      modelId: 7,
      modelName: 'Boogu VAE',
      versionName: 'v1',
      fileName: 'boogu.vae.safetensors',
      sizeKB: 300_000,
      componentType: 'VAE',
    });
    // hash uppercased in the query (stored ModelFileHash.hash is UPPERCASE hex)
    const arg = mockDbRead.modelFile.findFirst.mock.calls[0][0];
    expect(arg.where.hashes.some.hash).toBe('ABCDEF');
    expect(arg.where.hashes.some.type).toBe('SHA256');
    expect(arg.where.modelVersion.model.userId).toBe(OFFICIAL);
  });

  it('derives componentType from the official file type for a bundled component', async () => {
    // Official text encoder bundled in a checkpoint — the file's own type carries the role.
    mockDbRead.modelFile.findFirst.mockResolvedValue(officialBundledEncoderRow);
    const match = await findOfficialFileByHash({ sha256: 'abcdef' });
    expect(match?.componentType).toBe('TextEncoder');
  });

  it('returns null when the official match is a checkpoint (not a linkable accessory)', async () => {
    mockDbRead.modelFile.findFirst.mockResolvedValue({
      id: 902,
      name: 'flux.safetensors',
      sizeKB: 10_000_000,
      type: 'Model',
      modelVersionId: 44,
      modelVersion: { name: 'v1', modelId: 9, model: { name: 'Flux', type: 'Checkpoint' } },
    });
    expect(await findOfficialFileByHash({ sha256: 'abcdef' })).toBeNull();
  });

  it('returns null for primary-weights file types (Diffusion Model / UNet), not just checkpoints', async () => {
    // Flux/Wan/ZImage main files are type 'Diffusion Model' / 'UNet' — primary weights,
    // never linkable accessories even though inferComponentType maps them to non-null.
    for (const type of ['Diffusion Model', 'UNet']) {
      mockDbRead.modelFile.findFirst.mockResolvedValue({
        id: 903,
        name: 'flux.safetensors',
        sizeKB: 12_000_000,
        type,
        modelVersionId: 45,
        modelVersion: { name: 'v1', modelId: 10, model: { name: 'Flux', type: 'Checkpoint' } },
      });
      expect(await findOfficialFileByHash({ sha256: 'abcdef' })).toBeNull();
    }
  });

  it('returns null when no official file has the hash', async () => {
    mockDbRead.modelFile.findFirst.mockResolvedValue(null);
    expect(await findOfficialFileByHash({ sha256: 'abc' })).toBeNull();
  });
});
