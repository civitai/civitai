import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A vault item stores a version's model files only, never its training data. */

vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(async () => []),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { getModelVersionDataForVault } from '~/server/services/vault.service';

const file = (id: number, type: string, format?: string) => ({
  id,
  type,
  name: `${id}.zip`,
  url: `https://example.invalid/${id}`,
  sizeKB: 10,
  visibility: 'Public',
  metadata: format ? { format } : {},
  hashes: [],
});

const versionWith = (files: object[]) =>
  dbMock.dbRead.modelVersion.findUnique.mockResolvedValue({
    id: 9,
    status: 'Published',
    files,
    model: { id: 1, type: 'Workflows', tagsOnModels: [], user: { id: 7 } },
  } as never);

beforeEach(() => vi.clearAllMocks());

describe('getModelVersionDataForVault', () => {
  it('never stores training data as the main file', async () => {
    versionWith([file(1, 'Training Data'), file(2, 'Archive', 'Other')]);

    const { files } = await getModelVersionDataForVault({ modelVersionId: 9 });
    expect(files.map((f) => f.id)).toEqual([2]);
  });

  it('refuses a version whose only file is training data', async () => {
    versionWith([file(1, 'Training Data')]);

    await expect(getModelVersionDataForVault({ modelVersionId: 9 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('stores the model file and its config, as before (control)', async () => {
    versionWith([file(3, 'Model', 'SafeTensor'), file(4, 'Config'), file(1, 'Training Data')]);

    const { files } = await getModelVersionDataForVault({ modelVersionId: 9 });
    expect(files.map((f) => f.id)).toEqual([3, 4]);
  });
});
