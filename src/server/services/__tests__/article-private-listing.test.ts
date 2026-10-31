import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CosmeticService from '~/server/services/cosmetic.service';
import type * as CollectionService from '~/server/services/collection.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

// A private article is listed only for its owner and staff, whichever filter the list uses: a
// collection, a profile, ids. Lists without such a filter already drop it for everyone.

vi.mock('~/server/services/cosmetic.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticService>()),
  getEventDecorationsForEntity: vi.fn(async () => ({})),
  getCosmeticsForEntity: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCategoryTags: async () => [],
}));
vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getUserCollectionPermissionsById: vi.fn(async () => ({ read: true })),
}));

import { ArticleSort } from '~/server/common/enums';
import { getArticles } from '~/server/services/article.service';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

const AUTHOR = 10;
const STRANGER = 20;
const STAFF = 30;
const PUBLIC_ARTICLE = 1;
const PRIVATE_ARTICLE = 2;

const row = (id: number, availability: string) => ({
  id,
  userId: AUTHOR,
  availability,
  coverId: null,
  cursorV: id,
  tags: [],
  userCosmetics: [],
  user: { id: AUTHOR, username: 'author', profilePictureId: null },
});

const base = { limit: 10, sort: ArticleSort.Newest, period: MetricTimeframe.AllTime };

beforeEach(() => {
  vi.clearAllMocks();
  // The article read answers first; every later raw read (stats and the like) finds nothing.
  dbMock.dbRead.$queryRaw
    .mockResolvedValueOnce([row(PUBLIC_ARTICLE, 'Public'), row(PRIVATE_ARTICLE, 'Private')])
    .mockResolvedValue([]);
  dbMock.dbRead.image.findMany.mockResolvedValue([]);
  dbMock.dbRead.user.findUnique.mockResolvedValue({ id: AUTHOR } as never);
});

const listed = async (
  filter: { collectionId: number } | { username: string },
  sessionUser?: { id: number; isModerator?: boolean }
) =>
  (await getArticles({ ...base, ...filter, sessionUser } as never)).items.map(
    (a: { id: number }) => a.id
  );

describe.each([
  ['a collection', { collectionId: 5 }],
  ['a profile', { username: 'author' }],
])('getArticles listing %s', (_, filter) => {
  it('leaves a private article out for another viewer', async () => {
    expect(await listed(filter, { id: STRANGER })).toEqual([PUBLIC_ARTICLE]);
  });

  it('leaves a private article out when signed out', async () => {
    expect(await listed(filter)).toEqual([PUBLIC_ARTICLE]);
  });

  it('lists a private article for its owner', async () => {
    expect(await listed(filter, { id: AUTHOR })).toEqual([PUBLIC_ARTICLE, PRIVATE_ARTICLE]);
  });

  it('lists a private article for staff', async () => {
    expect(await listed(filter, { id: STAFF, isModerator: true })).toEqual([
      PUBLIC_ARTICLE,
      PRIVATE_ARTICLE,
    ]);
  });
});
