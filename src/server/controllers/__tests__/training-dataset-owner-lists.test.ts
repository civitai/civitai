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
    dbMock.dbWrite.modelFile.findMany.mockResolvedValue([
      { id: 2, metadata: stored, modelVersion: { model: { status: 'Draft', mode: null } } },
    ] as never);
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

describe("the owner's training lists on a deleted or taken-down model", () => {
  const EPOCH_URL = 'https://orchestration.example.test/blobs/epoch-3.safetensors';
  const withEpochs = () => ({
    selectedEpochUrl: EPOCH_URL,
    trainingResults: { version: 2, epochs: [{ epochNumber: 3, modelUrl: EPOCH_URL }] },
  });
  const withheld = { trainingResults: { version: 2, epochs: [{ epochNumber: 3 }] } };
  const STATES = [
    ['taken down', { status: 'Published', mode: 'TakenDown' }],
    ['deleted', { status: 'Deleted', mode: null }],
  ] as const;

  async function myTrainingModels(
    state: { status: string; mode: string | null },
    user: { id: number; isModerator?: boolean }
  ) {
    // The model's state comes back only when the read selects it, as in prod.
    getTrainingModelsByUserId.mockImplementation((async (args: any) => ({
      items: [
        {
          id: 10,
          trainingStatus: 'InReview',
          model: {
            id: 1,
            name: 'm',
            ...(args.select?.model?.select?.status ? { status: state.status } : {}),
            ...(args.select?.model?.select?.mode ? { mode: state.mode } : {}),
          },
          files: [{ id: 2, type: 'Training Data', metadata: withEpochs() }],
        },
      ],
    })) as never);
    const result = await getMyTrainingModelsHandler({
      input: {} as never,
      ctx: { user, features: {} } as never,
    });
    return result.items[0].files[0].metadata;
  }

  async function recentTrainingData(
    state: { status: string; mode: string | null },
    isModerator = false
  ) {
    dbMock.dbWrite.modelFile.findMany.mockImplementation((async (args: any) => [
      {
        id: 2,
        metadata: withEpochs(),
        modelVersion: {
          model: {
            // The model's state comes back only when the read selects it, as in prod.
            ...(args.select?.modelVersion?.select?.model?.select?.status
              ? { status: state.status }
              : {}),
            ...(args.select?.modelVersion?.select?.model?.select?.mode ? { mode: state.mode } : {}),
          },
        },
      },
    ]) as never);
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
      isModerator,
    } as Parameters<typeof getRecentTrainingData>[0]);
    return result.items[0].metadata;
  }

  it.each(STATES)(
    'model.getMyTrainingModels withholds the epoch urls when %s',
    async (_s, state) => {
      expect(await myTrainingModels(state, { id: 7 })).toEqual(withheld);
    }
  );

  it.each(STATES)(
    'modelFile.getRecentTrainingData withholds the epoch urls when %s',
    async (_s, state) => {
      expect(await recentTrainingData(state)).toEqual(withheld);
    }
  );

  it('both give a moderator the epoch urls', async () => {
    const state = { status: 'Published', mode: 'TakenDown' };

    expect(await myTrainingModels(state, { id: 7, isModerator: true })).toEqual(withEpochs());
    expect(await recentTrainingData(state, true)).toEqual(withEpochs());
  });

  it('both keep them on a model that is neither', async () => {
    const state = { status: 'Published', mode: null };

    expect(await myTrainingModels(state, { id: 7 })).toEqual(withEpochs());
    expect(await recentTrainingData(state)).toEqual(withEpochs());
  });
});
