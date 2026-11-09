import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ModelService from '~/server/services/model.service';

/**
 * The owner's training lists (`model.getMyTrainingModels`, `modelFile.getRecentTrainingData`) show
 * a dataset's sharing choice but not the keys the server writes for its own decisions, as every
 * other owner read does: a share kept Private reads the same whatever kept it there.
 */

const { getTrainingModelsByUserId } = vi.hoisted(() => ({ getTrainingModelsByUserId: vi.fn() }));
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getTrainingModelsByUserId,
}));
vi.mock('~/server/services/model-version-count.service', () => ({
  getModelVersionCountsByModelId: vi.fn().mockResolvedValue(new Map()),
}));

import { getMyTrainingModelsHandler } from '~/server/controllers/model.controller';
import { getRecentTrainingData } from '~/server/services/model-file.service';

const stored = {
  ownRights: true,
  shareDataset: true,
  selectedEpochUrl: 'https://example.test/epoch',
  datasetArchive: { status: 'archived', complete: true },
  nsfwLevel: 1,
  fullyRated: true,
};
const ownerView = {
  ownRights: true,
  shareDataset: true,
  selectedEpochUrl: 'https://example.test/epoch',
};

beforeEach(() => vi.clearAllMocks());

describe("the owner's training lists and a Training Studio dataset", () => {
  it('model.getMyTrainingModels leaves out the server-only keys', async () => {
    getTrainingModelsByUserId.mockResolvedValue({
      items: [
        {
          id: 10,
          trainingStatus: 'InReview',
          model: { id: 1, name: 'm', status: 'Draft' },
          files: [{ id: 2, type: 'Training Data', metadata: stored }],
        },
      ],
    });
    const result = await getMyTrainingModelsHandler({
      input: {} as never,
      ctx: { user: { id: 7 }, features: {} } as never,
    });
    expect(result.items[0].files[0].metadata).toEqual(ownerView);
  });

  it('modelFile.getRecentTrainingData leaves out the server-only keys', async () => {
    dbMock.dbWrite.modelFile.findMany.mockResolvedValue([{ id: 2, metadata: stored }] as never);
    const result = await getRecentTrainingData({
      limit: 20,
      cursor: 0,
      hasLabels: null,
      labelType: null,
      statuses: [],
      types: [],
      mediaTypes: [],
      baseModels: [],
      userId: 7,
    } as Parameters<typeof getRecentTrainingData>[0]);
    expect(result.items[0].metadata).toEqual(ownerView);
  });
});
