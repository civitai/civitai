import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(async () => []),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { getModelVersionDataForVault } from '~/server/services/vault.service';
import { getFileDisplayName } from '~/server/utils/model-helpers';

const file = (id: number, type: string, metadata: Record<string, unknown> = {}) => ({
  id,
  type,
  name: `${id}.zip`,
  url: `https://bucket/${id}.zip`,
  sizeKB: 10,
  metadata,
  hashes: [],
  visibility: 'Public',
});

const version = (files: ReturnType<typeof file>[]) =>
  dbMock.dbRead.modelVersion.findUnique.mockResolvedValue({
    id: 5,
    status: 'Published',
    files,
    model: { tagsOnModels: [], user: { id: 1 } },
  } as never);

// The vault serves its file straight from storage, past the download route's scan gate.
describe('the file a vault stores', () => {
  beforeEach(() => {
    dbMock.dbRead.modelVersion.findUnique.mockReset();
  });

  it('is never the training data, even where it would rank first', async () => {
    version([file(1, 'Archive', { format: 'Other' }), file(2, 'Training Data')]);

    const { files } = await getModelVersionDataForVault({ modelVersionId: 5 });

    expect(files.map((f) => f.id)).toEqual([1]);
  });

  // The vault download refuses a training data entry whose row is gone by this stored name.
  it('was stored, before it was excluded, under the name "Training Data"', () => {
    expect(
      getFileDisplayName({
        file: { type: 'Training Data', metadata: {} },
        modelType: 'LORA' as never,
      })
    ).toBe('Training Data');
  });

  it('is none for a version with only training data', async () => {
    version([file(2, 'Training Data')]);

    await expect(getModelVersionDataForVault({ modelVersionId: 5 })).rejects.toThrow(
      'Model version has no primary file.'
    );
  });
});
