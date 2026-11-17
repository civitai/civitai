import { describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { mockBustFile } = vi.hoisted(() => ({
  mockBustFile: vi.fn((_file: unknown) => Promise.resolve()),
}));
vi.mock('~/server/services/orchestrator/models', () => ({
  bustOrchestratorScannedFileCache: mockBustFile,
}));

import { bustVersionScannedFileAirs } from '~/server/services/orchestrator/scanned-file-airs';

const version = { modelId: 5, baseModel: 'SDXL 1.0', model: { type: 'LORA' as const } };

describe('bustVersionScannedFileAirs', () => {
  // A replaced or moved file no longer has a row on the version, but its AIR under it is cached.
  it("busts the version's current files and the gone ones, each once", async () => {
    dbMock.dbWrite.modelFile.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }] as never);

    await bustVersionScannedFileAirs(10, version, [2, 3]);

    expect(mockBustFile.mock.calls.map(([file]) => file)).toEqual(
      [1, 2, 3].map((fileId) =>
        expect.objectContaining({ fileId, modelVersionId: 10, modelId: 5, baseModel: 'SDXL 1.0' })
      )
    );
  });
});
