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
