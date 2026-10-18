import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `updateFile`'s lookup authorizes the file you may EDIT. It says nothing about a destination
 * version, so honouring a posted `modelVersionId` would attach your file to anyone's model version.
 */

vi.mock('~/server/services/model-version.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(() => Promise.resolve()),
}));

// A url change deletes the old object in the background; keep that off any real bucket.
vi.mock('~/utils/s3-utils', () => ({ deleteModelFileObject: vi.fn(() => Promise.resolve()) }));

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

  // The scan fallback job selects Pending files that are not tombstoned and not in flight; a new
  // url means new bytes, so every one of those fields must be reset or the new object is never scanned.
  it('puts the file back in the scan queue when its url changes', async () => {
    await updateFile({ id: 1, url: 'https://example.test/b.safetensors', userId: 7 });

    expect(writtenData()).toEqual({
      url: 'https://example.test/b.safetensors',
      metadata: undefined,
      exists: null,
      scannedAt: null,
      scanRequestedAt: null,
      rawScanResult: Prisma.JsonNull,
      virusScanResult: 'Pending',
      virusScanMessage: null,
      pickleScanResult: 'Pending',
      pickleScanMessage: null,
    });
  });

  it('leaves the scan state alone when the url is unchanged', async () => {
    await updateFile({ id: 1, url: FILE.url, overrideName: 'renamed', userId: 7 });

    expect(writtenData()).toEqual({ url: FILE.url, overrideName: 'renamed', metadata: undefined });
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
