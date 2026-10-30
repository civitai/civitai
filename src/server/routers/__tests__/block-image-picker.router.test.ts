import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';

vi.mock('~/env/client', () => ({
  env: { NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA' },
}));

const { blockImagePickerRouter } = await import('~/server/routers/block-image-picker.router');

/**
 * Where `blockImagePicker.getPosted` gets the level it filters by: the session user's own setting
 * and the request's domain, through the real router and service down to the query arguments.
 */

type Viewer = { showNsfw: boolean; browsingLevel: number };

const caller = (viewer: Viewer | null, features: { canViewNsfw: boolean }) =>
  blockImagePickerRouter.createCaller({
    user: viewer && {
      id: 8123,
      isModerator: false,
      muted: false,
      onboarding: OnboardingSteps.Buzz,
      ...viewer,
    },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features,
  } as never);

const queriedWhere = () => dbMock.dbRead.image.findMany.mock.calls[0][0].where;

describe('blockImagePicker.getPosted', () => {
  beforeEach(() => {
    dbMock.dbRead.image.findMany.mockReset();
    dbMock.dbRead.image.findMany.mockResolvedValue([]);
    dbMock.dbRead.image.findFirst.mockReset();
  });

  it("filters by the session user's own browsing level where the domain caps nothing", async () => {
    await caller({ showNsfw: true, browsingLevel: 12 }, { canViewNsfw: true }).getPosted({});

    expect(queriedWhere().userId).toBe(8123);
    expect(queriedWhere().nsfwLevel).toEqual({ in: [4, 8] });
  });

  it('caps the level on a domain that does not serve mature content', async () => {
    await caller({ showNsfw: true, browsingLevel: 28 }, { canViewNsfw: false }).getPosted({});

    expect(queriedWhere().nsfwLevel).toEqual({ in: [1, 2] });
  });

  it('lists PG only for a viewer who has mature content turned off', async () => {
    await caller({ showNsfw: false, browsingLevel: 31 }, { canViewNsfw: true }).getPosted({});

    expect(queriedWhere().nsfwLevel).toEqual({ in: [1] });
  });

  it('ignores a browsing level sent in the input', async () => {
    await caller({ showNsfw: true, browsingLevel: 3 }, { canViewNsfw: true }).getPosted({
      browsingLevel: 31,
    } as never);

    expect(queriedWhere().nsfwLevel).toEqual({ in: [1, 2] });
  });

  it('lists only posts that are not Private when the picker asks for publicOnly', async () => {
    await caller({ showNsfw: true, browsingLevel: 3 }, { canViewNsfw: true }).getPosted({
      publicOnly: true,
    });

    expect(queriedWhere().post.availability).toEqual({ not: 'Private' });
    expect(queriedWhere().post.publishedAt.lte).toBeInstanceOf(Date);
  });

  it('lists Private posts as before when publicOnly is absent or false', async () => {
    const viewer = { showNsfw: true, browsingLevel: 3 };
    await caller(viewer, { canViewNsfw: true }).getPosted({});
    await caller(viewer, { canViewNsfw: true }).getPosted({ publicOnly: false });

    for (const [args] of dbMock.dbRead.image.findMany.mock.calls) {
      expect(Object.keys(args.where.post)).toEqual(['publishedAt']);
    }
    expect(dbMock.dbRead.image.findMany).toHaveBeenCalledTimes(2);
  });

  it('rejects a publicOnly that is not a boolean', async () => {
    await expect(
      caller({ showNsfw: true, browsingLevel: 3 }, { canViewNsfw: true }).getPosted({
        publicOnly: 'true',
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(dbMock.dbRead.image.findMany).not.toHaveBeenCalled();
  });

  it('keeps publicOnly when it jumps to a date', async () => {
    dbMock.dbRead.image.findFirst.mockResolvedValue({ id: 9000 });
    await caller({ showNsfw: true, browsingLevel: 3 }, { canViewNsfw: true }).getPosted({
      toDate: new Date('2024-06-30T23:59:59.999Z'),
      publicOnly: true,
    });

    expect(queriedWhere().id).toEqual({ lte: 9000 });
    expect(queriedWhere().post.availability).toEqual({ not: 'Private' });
  });

  it('passes a jump-to date through to the query, as an id bound', async () => {
    dbMock.dbRead.image.findFirst.mockResolvedValue({ id: 9000 });
    const toDate = new Date('2024-06-30T23:59:59.999Z');
    await caller({ showNsfw: true, browsingLevel: 3 }, { canViewNsfw: true }).getPosted({ toDate });

    expect(dbMock.dbRead.image.findFirst.mock.calls[0][0].where).toEqual({
      createdAt: { lte: toDate },
    });
    expect(queriedWhere().id).toEqual({ lte: 9000 });
    expect(queriedWhere()).not.toHaveProperty('createdAt');
  });

  it.each([
    ['a string', '2024-06-30'],
    ['an invalid Date', new Date('nope')],
    ['a day before 2000 (what a half-typed year reads as)', new Date('0202-06-30T23:59:59.999Z')],
  ])('rejects a jump-to date that is %s, without querying', async (_name, toDate) => {
    await expect(
      caller({ showNsfw: true, browsingLevel: 3 }, { canViewNsfw: true }).getPosted({
        toDate,
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(dbMock.dbRead.image.findMany).not.toHaveBeenCalled();
  });

  it('refuses a signed-out caller without querying', async () => {
    await expect(caller(null, { canViewNsfw: true }).getPosted({})).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(dbMock.dbRead.image.findMany).not.toHaveBeenCalled();
  });
});
