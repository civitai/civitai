import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ModelService from '~/server/services/model.service';

/**
 * `training.getModelBasic` returns Training Data file urls, which are storage locations. It is a
 * public procedure, so the handler must refuse a caller who is neither the model owner nor a
 * moderator — before the fix any logged-out caller could read any model's dataset urls by id.
 */

const { getModel } = vi.hoisted(() => ({ getModel: vi.fn() }));
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getModel,
}));

import { getModelData } from '~/server/controllers/training.controller';

const OWNER = 7;
const MODEL = {
  id: 1,
  userId: OWNER,
  name: 'm',
  status: 'Draft',
  type: 'LORA',
  uploadType: 'Trained',
  availability: 'Public',
  modelVersions: [
    {
      id: 10,
      name: 'v',
      baseModel: 'SDXL',
      trainingStatus: 'Pending',
      trainingDetails: null,
      trainedWords: [],
      files: [
        {
          id: 100,
          name: 'd.zip',
          url: 'training-images/7/d.zip',
          type: 'Training Data',
          metadata: {},
          sizeKB: 1,
          visibility: 'Private',
        },
      ],
    },
  ],
};

function call(user: { id: number; isModerator: boolean } | undefined) {
  return getModelData({ input: { id: 1 }, ctx: { user } as never });
}

beforeEach(() => {
  vi.clearAllMocks();
  getModel.mockResolvedValue(JSON.parse(JSON.stringify(MODEL)));
  dbMock.dbWrite.modelFile.findMany.mockResolvedValue([]);
});

describe('training.getModelData owner gate', () => {
  it('returns the dataset (with its url) to the owner', async () => {
    const result = await call({ id: OWNER, isModerator: false });
    expect(result.modelVersions[0].files[0].url).toBe('training-images/7/d.zip');
  });

  it('returns it to a moderator', async () => {
    const result = await call({ id: 999, isModerator: true });
    expect(result.modelVersions[0].files[0].url).toBe('training-images/7/d.zip');
  });

  it.each([
    ['a signed-in non-owner', { id: 999, isModerator: false }],
    ['an anonymous caller', undefined],
  ])('refuses %s with NOT_FOUND', async (_label, user) => {
    const err = await call(user as never).then(
      () => {
        throw new Error('expected a refusal');
      },
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('NOT_FOUND');
  });
});

describe('training.getModelData and a Training Studio dataset', () => {
  const stored = {
    ownRights: true,
    shareDataset: true,
    selectedEpochUrl: 'https://example.test/epoch',
    datasetArchive: { status: 'archived', complete: true },
    nsfwLevel: 1,
    fullyRated: true,
  };

  beforeEach(() => {
    dbMock.dbWrite.modelFile.findMany.mockResolvedValue([{ id: 100, metadata: stored }] as never);
  });

  it('gives the owner the sharing choice without the server-only keys', async () => {
    const result = await call({ id: OWNER, isModerator: false });
    expect(result.modelVersions[0].files[0].metadata).toEqual({
      ownRights: true,
      shareDataset: true,
      selectedEpochUrl: 'https://example.test/epoch',
    });
  });

  it('gives a moderator the stored metadata', async () => {
    const result = await call({ id: 999, isModerator: true });
    expect(result.modelVersions[0].files[0].metadata).toEqual(stored);
  });
});

describe('training.getModelData on a deleted or taken-down model', () => {
  const EPOCH_URL = 'https://orchestration.example.test/blobs/epoch-3.safetensors';
  function givenModel(state: { status: string; mode: string | null }) {
    const model = JSON.parse(JSON.stringify(MODEL));
    model.modelVersions[0].files[0].metadata = {
      selectedEpochUrl: EPOCH_URL,
      trainingResults: { version: 2, epochs: [{ epochNumber: 3, modelUrl: EPOCH_URL }] },
    };
    // The model's state comes back only when the read selects it, as in prod.
    getModel.mockImplementation((async (args: {
      select?: { status?: boolean; mode?: boolean };
    }) => ({
      ...model,
      ...(args.select?.status ? { status: state.status } : {}),
      ...(args.select?.mode ? { mode: state.mode } : {}),
    })) as never);
  }
  const metadataOf = (result: Awaited<ReturnType<typeof call>>) =>
    result.modelVersions[0].files[0].metadata as Record<string, any>;

  it.each([
    ['taken down', { status: 'Published', mode: 'TakenDown' }],
    ['deleted', { status: 'Deleted', mode: null }],
  ])('withholds the epoch urls from the owner when %s', async (_s, state) => {
    givenModel(state);

    const metadata = metadataOf(await call({ id: OWNER, isModerator: false }));

    expect(metadata.selectedEpochUrl).toBeUndefined();
    expect(metadata.trainingResults.epochs).toEqual([{ epochNumber: 3 }]);
  });

  it('gives a moderator the epoch urls', async () => {
    givenModel({ status: 'Published', mode: 'TakenDown' });

    expect(metadataOf(await call({ id: 1, isModerator: true })).selectedEpochUrl).toBe(EPOCH_URL);
  });

  it('keeps them for the owner of a model that is neither', async () => {
    givenModel({ status: 'Published', mode: null });

    const metadata = metadataOf(await call({ id: OWNER, isModerator: false }));

    expect(metadata.trainingResults.epochs[0].modelUrl).toBe(EPOCH_URL);
  });
});
