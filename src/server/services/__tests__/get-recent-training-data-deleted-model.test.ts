import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { getRecentTrainingData } from '~/server/services/model-file.service';

// getRecentTrainingData backs the trainer's "Re-use a dataset" picker. It must not surface Training
// Data from models the owner already deleted — there is no owner-facing way to remove such an entry,
// so a missing deletedAt filter leaves the picker showing datasets the user cannot get rid of.

const baseInput = {
  limit: 20,
  cursor: 0,
  hasLabels: null,
  labelType: null,
  statuses: [],
  types: [],
  mediaTypes: [],
  baseModels: [],
} as Parameters<typeof getRecentTrainingData>[0];

describe('getRecentTrainingData', () => {
  beforeEach(() => {
    dbMock.dbWrite.modelFile.findMany.mockResolvedValue([]);
  });

  it('excludes Training Data on deleted models via a deletedAt filter on the owner model', async () => {
    await getRecentTrainingData({ ...baseInput, userId: 123 });

    const call = dbMock.dbWrite.modelFile.findMany.mock.calls[0]?.[0];
    const and = (call?.where?.AND ?? []) as Prisma.ModelFileWhereInput[];
    const modelClause = and
      .map((clause) => {
        const modelVersion = clause.modelVersion as
          | { model?: Prisma.ModelWhereInput }
          | undefined;
        return modelVersion?.model;
      })
      .find(Boolean);

    expect(modelClause).toEqual({ userId: 123, deletedAt: null });
  });
});
