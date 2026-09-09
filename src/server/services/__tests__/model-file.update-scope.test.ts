import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `updateFile`'s lookup authorizes the file you may EDIT. It says nothing about a destination
 * version, so honouring a posted `modelVersionId` would attach your file to anyone's model version.
 */

vi.mock('~/server/services/model-version.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(() => Promise.resolve()),
}));

import { updateFile } from '~/server/services/model-file.service';

const FILE = {
  id: 1,
  url: 'https://example.test/a.safetensors',
  metadata: {},
  modelVersionId: 10,
  sizeKB: 1,
  modelVersion: { modelId: 5 },
};

beforeEach(() => {
  dbMock.dbWrite.modelFile.findUnique.mockResolvedValue(FILE);
  dbMock.dbWrite.modelFile.updateMany.mockResolvedValue({ count: 1 });
});

const writtenData = () =>
  (dbMock.dbWrite.modelFile.updateMany.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> })
    .data;

describe('updateFile', () => {
  it('never writes modelVersionId, so a file cannot be moved onto another version', async () => {
    await updateFile({ id: 1, modelVersionId: 999, userId: 7 });

    expect(writtenData()).not.toHaveProperty('modelVersionId');
  });

  it('still writes the fields an owner may legitimately change', async () => {
    await updateFile({ id: 1, overrideName: 'renamed', userId: 7 });

    expect(writtenData()).toMatchObject({ overrideName: 'renamed' });
  });

  it('scopes the lookup to the caller unless they are a moderator', async () => {
    await updateFile({ id: 1, overrideName: 'x', userId: 7 });
    expect(dbMock.dbWrite.modelFile.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1, modelVersion: { model: { userId: 7 } } },
      })
    );

    dbMock.dbWrite.modelFile.findUnique.mockClear();
    await updateFile({ id: 1, overrideName: 'x', userId: 7, isModerator: true });
    expect(dbMock.dbWrite.modelFile.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1, modelVersion: { model: undefined } },
      })
    );
  });
});
