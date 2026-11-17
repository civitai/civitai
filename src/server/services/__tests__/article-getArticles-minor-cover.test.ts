import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CosmeticService from '~/server/services/cosmetic.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.mock('~/server/services/cosmetic.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticService>()),
  getEventDecorationsForEntity: vi.fn(async () => ({})),
  getCosmeticsForEntity: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCategoryTags: async () => [],
}));

import { ArticleSort } from '~/server/common/enums';
import { getArticles } from '~/server/services/article.service';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

const AUTHOR = 10;
const STRANGER = 20;
const COVER = 100;

const row = {
  id: 1,
  userId: AUTHOR,
  availability: 'Public',
  cover: 'cover-key',
  coverId: COVER,
  cursorV: 1,
  tags: [],
  userCosmetics: [],
  user: { id: AUTHOR, username: 'author', profilePictureId: null },
};

const coverImage = (minor: boolean) => ({
  id: COVER,
  userId: AUTHOR,
  url: 'cover-key',
  nsfwLevel: 4,
  minor,
  ingestion: 'Scanned',
  needsReview: null,
  tags: [],
});

const listedCover = async (minor: boolean, viewerId: number) => {
  dbMock.dbRead.image.findMany.mockResolvedValue([coverImage(minor)] as never);
  const { items } = await getArticles({
    limit: 10,
    sort: ArticleSort.Newest,
    period: MetricTimeframe.AllTime,
    sessionUser: { id: viewerId },
  } as never);
  return (items[0] as { cover: string | null }).cover;
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.$queryRaw.mockResolvedValueOnce([{ ...row }]).mockResolvedValue([]);
});

describe('getArticles and a restricted minor cover', () => {
  it('🔴 clears the legacy cover key for another viewer', async () => {
    expect(await listedCover(true, STRANGER)).toBeNull();
  });

  it('keeps it for the owner (control)', async () => {
    expect(await listedCover(true, AUTHOR)).toBe('cover-key');
  });

  it('keeps it for another viewer when the cover is not minor-flagged (control)', async () => {
    expect(await listedCover(false, STRANGER)).toBe('cover-key');
  });
});
