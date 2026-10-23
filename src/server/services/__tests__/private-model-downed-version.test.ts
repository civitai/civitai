import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ModelVersionService from '~/server/services/model-version.service';
import type * as Subscriptions from '~/server/services/subscriptions.service';

/**
 * Making a model private published EVERY one of its versions, so a version a moderator took down came
 * back Published, and publishPrivateModel then made it public again with its posts.
 */

vi.mock('~/server/services/subscriptions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Subscriptions>()),
  getHighestTierSubscription: async () => ({ tier: 'founder' }),
}));
vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionService>()),
  createModelVersionPostFromTraining: async () => undefined,
  bustMvCache: async () => undefined,
}));

const { privateModelFromTraining } = await import('~/server/services/model.service');

const MODEL = 1;
type Version = { id: number; modelId: number; status: string };
let versions: Version[];

beforeEach(() => {
  versions = [
    { id: 10, modelId: MODEL, status: 'Published' },
    { id: 11, modelId: MODEL, status: 'UnpublishedViolation' },
    { id: 12, modelId: MODEL, status: 'Deleted' },
  ];
  dbMock.dbWrite.model.findUnique.mockResolvedValue({
    userId: 5,
    lockedProperties: [],
    meta: {},
    status: 'Published',
    availability: 'Public',
  } as never);
  dbMock.dbRead.model.count.mockResolvedValue(0 as never);
  dbMock.dbWrite.model.update.mockResolvedValue({
    id: MODEL,
    modelVersions: versions.map(({ id }) => ({ id })),
  } as never);
  // Applies the filter it is given, so a publish that forgets the status condition reaches row 11.
  dbMock.dbWrite.modelVersion.updateMany.mockImplementation((async ({
    where,
    data,
  }: {
    where: { modelId: number; status?: { notIn: string[] } };
    data: { status?: string };
  }) => {
    const hit = versions.filter(
      (v) => v.modelId === where.modelId && !where.status?.notIn.includes(v.status)
    );
    if (data.status) hit.forEach((v) => (v.status = data.status as string));
    return { count: hit.length };
  }) as never);
});

const makePrivate = (isModerator = false) =>
  privateModelFromTraining({
    id: MODEL,
    user: { id: isModerator ? 9 : 5, isModerator },
  } as never).catch(() => undefined);

const statusOf = (id: number) => versions.find((v) => v.id === id)?.status;

describe('making a model with a taken-down version private', () => {
  it('leaves the taken-down and deleted versions down for the owner', async () => {
    await makePrivate();

    expect(statusOf(10)).toBe('Published');
    expect(statusOf(11)).toBe('UnpublishedViolation');
    expect(statusOf(12)).toBe('Deleted');
  });

  it('lets a moderator publish them', async () => {
    await makePrivate(true);

    expect(statusOf(11)).toBe('Published');
  });
});
