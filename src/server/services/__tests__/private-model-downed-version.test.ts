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
// Stands in for the real post path: publishing onto a taken-down version is refused there, except for
// a moderator.
const { postedTo } = vi.hoisted(() => ({ postedTo: [] as number[] }));
vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionService>()),
  createModelVersionPostFromTraining: async ({
    modelVersionId,
    user,
  }: {
    modelVersionId: number;
    user: { isModerator: boolean };
  }) => {
    postedTo.push(modelVersionId);
    if (modelVersionId !== 10 && !user.isModerator) throw new Error('refused: taken down');
  },
  bustMvCache: async () => undefined,
}));

const { privateModelFromTraining } = await import('~/server/services/model.service');

const MODEL = 1;
type Version = { id: number; modelId: number; status: string; availability: string };
let versions: Version[];

beforeEach(() => {
  postedTo.length = 0;
  versions = [
    { id: 10, modelId: MODEL, status: 'Published', availability: 'Public' },
    { id: 11, modelId: MODEL, status: 'UnpublishedViolation', availability: 'Public' },
    { id: 12, modelId: MODEL, status: 'Deleted', availability: 'Public' },
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
    modelVersions: versions.map(({ id, status }) => ({ id, status })),
  } as never);
  // Applies the filter it is given, so a publish that forgets the status condition reaches row 11.
  dbMock.dbWrite.modelVersion.updateMany.mockImplementation((async ({
    where,
    data,
  }: {
    where: { modelId: number; status?: { notIn: string[] } };
    data: { status?: string; availability?: string };
  }) => {
    const hit = versions.filter(
      (v) => v.modelId === where.modelId && !where.status?.notIn.includes(v.status)
    );
    if (data.status) hit.forEach((v) => (v.status = data.status as string));
    if (data.availability) hit.forEach((v) => (v.availability = data.availability as string));
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

    // Posting to them would fail, and the failure path used to reset every version to a Draft.
    expect(postedTo).toEqual([10]);
    expect(statusOf(10)).toBe('Published');
    expect(statusOf(11)).toBe('UnpublishedViolation');
    expect(statusOf(12)).toBe('Deleted');
  });

  it('makes the taken-down versions private with the rest', async () => {
    await makePrivate();

    expect(versions.map((v) => v.availability)).toEqual(['Private', 'Private', 'Private']);
  });

  it('does not reset them to Draft when the flow fails', async () => {
    dbMock.dbWrite.model.update.mockResolvedValueOnce({
      id: MODEL,
      modelVersions: [
        { id: 10, status: 'Published' },
        { id: 99, status: 'Published' },
      ],
    } as never);
    await makePrivate();

    expect(statusOf(10)).toBe('Draft');
    expect(statusOf(11)).toBe('UnpublishedViolation');
    expect(statusOf(12)).toBe('Deleted');
  });

  it('lets a moderator publish them', async () => {
    await makePrivate(true);

    expect(postedTo).toEqual([10, 11, 12]);
    expect(statusOf(11)).toBe('Published');
    expect(statusOf(12)).toBe('Published');
  });
});
