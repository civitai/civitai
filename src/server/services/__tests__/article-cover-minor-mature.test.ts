import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as SystemCache from '~/server/services/system-cache';
import type * as UserService from '~/server/services/user.service';
import type * as FileService from '~/server/services/file.service';

/**
 * An article's cover that is minor-flagged and rated R or above reaches only the image's owner and
 * moderators, on the article page and in article lists.
 */

vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  getDbWithoutLag: vi.fn(async () => dbMock.dbRead),
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getCategoryTags: vi.fn(async () => []),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  amIBlockedByUser: vi.fn(async () => false),
}));
vi.mock('~/server/services/file.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FileService>()),
  getFilesByEntity: vi.fn(async () => []),
}));

import { getArticleById, getArticles } from '~/server/services/article.service';
import { ArticleSort } from '~/server/common/enums';
import {
  ArticleIngestionStatus,
  ArticleStatus,
  MetricTimeframe,
} from '~/shared/utils/prisma/enums';

const OWNER = 10;
const STRANGER = 20;
const MOD = 30;
const COVER = 500;

const viewers = {
  'a signed-out viewer': undefined,
  'a stranger': { id: STRANGER },
  'the owner': { id: OWNER },
  'a moderator': { id: MOD, isModerator: true },
};
type Viewer = (typeof viewers)[keyof typeof viewers];

const cover = (nsfwLevel: number, minor: boolean | null) => ({
  id: COVER,
  userId: OWNER,
  url: 'u',
  nsfwLevel,
  minor,
  ingestion: 'Scanned',
  needsReview: null,
  meta: null,
  metadata: null,
  tags: [],
});

async function detailCover(image: ReturnType<typeof cover>, viewer: Viewer) {
  dbMock.dbRead.article.findFirst.mockResolvedValue({
    id: 1,
    userId: OWNER,
    nsfwLevel: image.nsfwLevel,
    status: ArticleStatus.Published,
    ingestion: ArticleIngestionStatus.Scanned,
    tags: [],
    content: '',
    metadata: null,
    coverImage: image,
  } as never);
  dbMock.dbRead.imageConnection.findMany.mockResolvedValue([] as never);
  const article = await getArticleById({
    id: 1,
    userId: viewer?.id,
    isModerator: viewer?.isModerator,
  });
  return article.coverImage;
}

async function listCover(image: ReturnType<typeof cover>, viewer: Viewer) {
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
    {
      id: 1,
      userId: OWNER,
      coverId: COVER,
      nsfwLevel: image.nsfwLevel,
      availability: 'Public',
      tags: [],
      user: { id: OWNER, profilePictureId: null },
      userCosmetics: [],
      cursorV: 1,
    },
  ]);
  dbMock.dbRead.image.findMany.mockImplementation((async (args: { select?: { minor?: boolean } }) =>
    args.select?.minor ? [image] : []) as never);
  const { items } = await getArticles({
    limit: 10,
    browsingLevel: 31,
    period: MetricTimeframe.AllTime,
    sort: ArticleSort.Newest,
    sessionUser: viewer,
  } as Parameters<typeof getArticles>[0]);
  return items[0]?.coverImage;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each([
  ['getArticleById', detailCover],
  ['getArticles', listCover],
] as const)('%s', (_label, coverFor) => {
  it.each([['a signed-out viewer'], ['a stranger']] as const)(
    'leaves out a minor-flagged cover rated R or above for %s',
    async (who) => {
      expect(await coverFor(cover(4, true), viewers[who])).toBeUndefined();
      expect(await coverFor(cover(16, true), viewers[who])).toBeUndefined();
    }
  );

  it.each([['the owner'], ['a moderator']] as const)('keeps it for %s', async (who) => {
    expect((await coverFor(cover(4, true), viewers[who]))?.id).toBe(COVER);
  });

  it('keeps a minor-flagged cover rated PG-13, and an R cover with the flag unset, for a stranger', async () => {
    expect((await coverFor(cover(2, true), viewers['a stranger']))?.id).toBe(COVER);
    expect((await coverFor(cover(4, null), viewers['a stranger']))?.id).toBe(COVER);
  });

  it('does not add the flag to the cover it returns', async () => {
    expect(await coverFor(cover(2, true), viewers['a stranger'])).not.toHaveProperty('minor');
  });
});
