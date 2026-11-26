import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads12 from '@civitai/db-queries/hot-reads-12';

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFliptSync: vi.fn(),
  getFliptClientSync: vi.fn(() => ({})),
  ensureFliptInitialized: vi.fn(async () => undefined),
}));
vi.mock('@civitai/db-queries/hot-reads-12', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads12>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});

import * as queries from '@civitai/db-queries/hot-reads-12';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { kyselyRead } from '~/server/db/kyselyDb';
import { isFliptSync } from '~/server/flipt/client';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { resetHotReads12GateForTests } from '~/server/services/hot-reads-12.reads';
import { getResourceReviewsInfinite } from '~/server/services/resourceReview.service';

/**
 * `getResourceReviewsInfinite` (resourceReview.getInfinite) reads its page through the
 * `kysely-hot-reads-12` switch: OFF, the reviews with their user nested, as before; ON, the reviews
 * with `userId` and their users from the one Kysely statement, so the user the page returns can
 * only have come from the Kysely row. Before this change the nested Prisma read ran whatever the
 * flag said, so the ON case fails there.
 */

const flag = vi.mocked(isFliptSync);
const usersRows = vi.mocked(queries.listUsersWithCosmeticsRows);
const MODEL = 15101;
const REVIEWER = 15201;
const REVIEW = 15301;
const NEXT = 15302;

const review = (id: number) => ({
  id,
  modelId: MODEL,
  modelVersionId: 15401,
  details: 'text',
  createdAt: new Date('2026-11-02T03:04:05.006Z'),
  rating: 4,
  recommended: true,
});

beforeEach(() => {
  resetSharedMocks();
  resetHotReads12GateForTests();
  usersRows.mockReset();
  flag.mockReset().mockReturnValue(false);
});

describe('getResourceReviewsInfinite', () => {
  it('OFF: the nested Prisma read, as before', async () => {
    const user = {
      id: REVIEWER,
      username: 'prisma',
      deletedAt: null,
      image: null,
      profilePicture: null,
      cosmetics: [],
    };
    dbMock.dbRead.resourceReview.findMany.mockResolvedValue([{ ...review(REVIEW), user }] as never);
    const { items } = await getResourceReviewsInfinite({ limit: 1, modelId: MODEL });
    expect(items.map((item) => item.user)).toStrictEqual([user]);
    const [[args]] = dbMock.dbRead.resourceReview.findMany.mock.calls as unknown as [
      [{ take: number; select: Record<string, unknown> }]
    ];
    expect(args.take).toBe(2);
    expect(args.select.user).toStrictEqual({ select: userWithCosmeticsSelect });
    expect(usersRows).not.toHaveBeenCalled();
  });

  it('ON: the users come from the one Kysely statement, and the cursor logic is unchanged', async () => {
    flag.mockReturnValue(true);
    dbMock.dbRead.resourceReview.findMany.mockResolvedValue([
      { ...review(REVIEW), userId: REVIEWER },
      { ...review(NEXT), userId: REVIEWER },
    ] as never);
    usersRows.mockResolvedValue([
      {
        id: REVIEWER,
        username: 'kysely',
        deletedAt: null,
        image: null,
        profilePictureId: null,
        profilePictureName: null,
        profilePictureUrl: null,
        profilePictureNsfwLevel: null,
        profilePictureHash: null,
        profilePictureUserId: null,
        profilePictureIngestion: null,
        profilePictureNeedsReview: null,
        profilePictureType: null,
        profilePictureWidth: null,
        profilePictureHeight: null,
        profilePictureMetadata: null,
        cosmetics: [],
      },
    ] as never);
    const { items, nextCursor } = await getResourceReviewsInfinite({ limit: 1, modelId: MODEL });
    expect(nextCursor).toBe(NEXT);
    expect(items).toStrictEqual([
      {
        ...review(REVIEW),
        user: {
          id: REVIEWER,
          username: 'kysely',
          deletedAt: null,
          image: null,
          profilePicture: null,
          cosmetics: [],
        },
        thread: { commentCount: 0 },
      },
    ]);
    const [[args]] = dbMock.dbRead.resourceReview.findMany.mock.calls as unknown as [
      [{ select: Record<string, unknown> }]
    ];
    expect(args.select.user).toBeUndefined();
    expect(args.select.userId).toBe(true);
    expect(usersRows.mock.calls).toEqual([[kyselyRead, [REVIEWER]]]);
  });
});
