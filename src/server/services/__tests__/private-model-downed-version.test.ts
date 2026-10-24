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
// FAILS is a version whose post fails, which sends the flow down its rollback.
const { postedTo, FAILS } = vi.hoisted(() => ({ postedTo: [] as number[], FAILS: 99 }));
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
    if (modelVersionId === FAILS) throw new Error('post failed');
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

  it.each([
    ['an owner', false],
    ['a moderator', true],
  ])('does not reset them to Draft when %s run fails', async (_label, asModerator) => {
    dbMock.dbWrite.model.update.mockResolvedValueOnce({
      id: MODEL,
      modelVersions: [
        { id: 10, status: 'Published' },
        { id: FAILS, status: 'Published' },
      ],
    } as never);
    await makePrivate(asModerator);

    expect(statusOf(10)).toBe('Draft');
    expect(statusOf(11)).toBe('UnpublishedViolation');
    expect(statusOf(12)).toBe('Deleted');
  });

  // Ruled by the Moderation Lead (hq:ky1cf68gw8ec): a moderator's run keeps them down too.
  // Restoring a taken-down version is its own explicit moderator action, not a side effect of this one.
  it('keeps them down when a moderator runs it', async () => {
    await makePrivate(true);

    expect(postedTo).toEqual([10]);
    expect(statusOf(10)).toBe('Published');
    expect(statusOf(11)).toBe('UnpublishedViolation');
    expect(statusOf(12)).toBe('Deleted');
  });
});
