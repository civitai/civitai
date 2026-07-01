// src/server/services/__tests__/official-file.service.test.ts
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
  modelVersionId: 42,
  modelVersion: { name: 'v1', modelId: 7, model: { name: 'Boogu VAE' } },
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
  it('matches a canonical file that is itself type="Model" and derives componentType from the host', async () => {
    mockDbRead.modelFile.findFirst.mockResolvedValue(officialVaeRow);
    // Pass lowercase input (as computeBlobSha256 produces); query must uppercase it to match stored UPPERCASE hex
    const match = await findOfficialFileByHash({ sha256: 'abcdef', hostType: 'VAE' });
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

  it('returns null for a primary-weights host without querying', async () => {
    expect(await findOfficialFileByHash({ sha256: 'abc', hostType: 'Model' })).toBeNull();
    expect(await findOfficialFileByHash({ sha256: 'abc', hostType: 'Pruned Model' })).toBeNull();
    expect(mockDbRead.modelFile.findFirst).not.toHaveBeenCalled();
  });

  it('returns null when no official file has the hash', async () => {
    mockDbRead.modelFile.findFirst.mockResolvedValue(null);
    expect(await findOfficialFileByHash({ sha256: 'abc', hostType: 'VAE' })).toBeNull();
  });
});
