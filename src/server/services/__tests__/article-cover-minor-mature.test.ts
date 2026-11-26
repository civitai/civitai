import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as SystemCache from '~/server/services/system-cache';
import type * as UserService from '~/server/services/user.service';
import type * as FileService from '~/server/services/file.service';
import type * as CollectionCoverVisibility from '~/server/services/collection-cover-visibility';

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

vi.mock('~/server/services/collection-cover-visibility', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionCoverVisibility>()),
  getModelWithheldImageIds: vi.fn(async () => new Set<number>()),
}));

import { getArticleById, getArticles, getCivitaiNews } from '~/server/services/article.service';
import { getModelWithheldImageIds } from '~/server/services/collection-cover-visibility';
import { ArticleSort } from '~/server/common/enums';
import {
  ArticleIngestionStatus,
  ArticleStatus,
  Availability,
  MetricTimeframe,
} from '~/shared/utils/prisma/enums';

const OWNER = 10;
const STRANGER = 20;
const MOD = 30;
const COVER = 500;
const OTHER_IMAGE_OWNER = 40;

type Viewer = { id: number; isModerator?: boolean } | undefined;
const viewers: Record<string, Viewer> = {
  'a signed-out viewer': undefined,
  'a stranger': { id: STRANGER },
  'the owner': { id: OWNER },
  'a moderator': { id: MOD, isModerator: true },
};

const cover = (
  nsfwLevel: number,
  minor: boolean | null,
  imageOwner = OWNER,
  modelRestricted = false
) => ({
  id: COVER,
  userId: imageOwner,
  url: 'u',
  nsfwLevel,
  minor,
  modelRestricted,
  ingestion: 'Scanned',
  needsReview: null,
  meta: null,
  metadata: null,
  tags: [],
});

async function detailArticle(
  image: ReturnType<typeof cover>,
  viewer: Viewer,
  field: 'coverImage' | 'bannerImage'
) {
  // Answers only what the query selects, so an image read without `minor` comes back without it.
  dbMock.dbRead.article.findFirst.mockImplementation((async (args: {
    select?: Record<string, { select?: { minor?: boolean } } | undefined>;
  }) => {
    const { minor, ...unflagged } = image;
    return {
      id: 1,
      userId: OWNER,
      nsfwLevel: image.nsfwLevel,
      status: ArticleStatus.Published,
      ingestion: ArticleIngestionStatus.Scanned,
      tags: [],
      content: '',
      metadata: null,
      cover: 'cover-key',
      coverImage: null,
      bannerImage: null,
      [field]: args.select?.[field]?.select?.minor ? image : unflagged,
    };
  }) as never);
  dbMock.dbRead.imageConnection.findMany.mockResolvedValue([] as never);
  return getArticleById({
    id: 1,
    userId: viewer?.id,
    isModerator: viewer?.isModerator,
  });
}

const detailImage = async (
  image: ReturnType<typeof cover>,
  viewer: Viewer,
  field: 'coverImage' | 'bannerImage'
) => (await detailArticle(image, viewer, field))[field];

const detailCover = (image: ReturnType<typeof cover>, viewer: Viewer) =>
  detailImage(image, viewer, 'coverImage');
const detailBanner = (image: ReturnType<typeof cover>, viewer: Viewer) =>
  detailImage(image, viewer, 'bannerImage');

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
  ['getArticleById banner', detailBanner],
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

  it("leaves it out for the article's owner when someone else owns the image, and keeps it for that image's owner", async () => {
    const image = cover(4, true, OTHER_IMAGE_OWNER);
    expect(await coverFor(image, viewers['the owner'])).toBeUndefined();
    expect((await coverFor(image, { id: OTHER_IMAGE_OWNER }))?.id).toBe(COVER);
  });
});

describe("getArticleById and a withheld cover's legacy key", () => {
  const legacyCover = async (image: ReturnType<typeof cover>, viewer: Viewer) =>
    (await detailArticle(image, viewer, 'coverImage')).cover;
  const withheldByItsModel = () =>
    vi.mocked(getModelWithheldImageIds).mockResolvedValue(new Set([COVER]));

  beforeEach(() => {
    vi.mocked(getModelWithheldImageIds).mockResolvedValue(new Set());
  });

  it.each(['a signed-out viewer', 'a stranger'])(
    '🔴 clears it for %s when the cover is a restricted minor image',
    async (who) => {
      expect(await legacyCover(cover(4, true), viewers[who])).toBeNull();
    }
  );

  it.each(['a signed-out viewer', 'a stranger'])(
    '🔴 clears it for %s when its model withholds the cover',
    async (who) => {
      withheldByItsModel();
      expect(await legacyCover(cover(1, null), viewers[who])).toBeNull();
    }
  );

  it.each(['a signed-out viewer', 'a stranger'])(
    '🔴 clears it for %s when the cover is restricted by its base model',
    async (who) => {
      expect(await legacyCover(cover(4, false, OWNER, true), viewers[who])).toBeNull();
    }
  );

  it.each(['the owner', 'a moderator'])('keeps it for %s (control)', async (who) => {
    expect(await legacyCover(cover(4, false, OWNER, true), viewers[who])).toBe('cover-key');
    expect(await legacyCover(cover(4, true), viewers[who])).toBe('cover-key');
    withheldByItsModel();
    expect(await legacyCover(cover(1, null), viewers[who])).toBe('cover-key');
  });

  it.each(Object.keys(viewers))(
    'keeps it for %s when the cover is not withheld (control)',
    async (who) => {
      expect(await legacyCover(cover(4, null), viewers[who])).toBe('cover-key');
    }
  );
});

describe('getCivitaiNews, a public list with no viewer', () => {
  async function newsCover(image: ReturnType<typeof cover>) {
    (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { collection: 'Newsroom', id: 1, coverId: COVER, content: '', userId: OWNER, summary: 's' },
    ]);
    dbMock.dbRead.user.findMany.mockResolvedValue([] as never);
    dbMock.dbRead.image.findMany.mockImplementation((async (args: {
      select?: { minor?: boolean };
    }) => (args.select?.minor ? [image] : [])) as never);
    dbMock.dbRead.pressMention.findMany.mockResolvedValue([] as never);
    const { articles } = await getCivitaiNews();
    return articles[0]?.coverImage;
  }

  it('leaves out a minor-flagged cover rated R or above', async () => {
    expect(await newsCover(cover(4, true))).toBeUndefined();
  });

  it('keeps a minor-flagged cover rated PG-13, without the flag', async () => {
    const shown = await newsCover(cover(2, true));
    expect(shown?.id).toBe(COVER);
    expect(shown).not.toHaveProperty('minor');
  });
});

describe('getArticleById body images', () => {
  const BODY_UUID = '0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
  const bodyImage = (nsfwLevel: number, minor: boolean | null) => ({
    id: 600,
    url: BODY_UUID,
    nsfwLevel,
    minor,
    modelRestricted: false,
    userId: OWNER,
    ingestion: 'Scanned',
    needsReview: null,
    tosViolation: false,
    hash: null,
    width: 10,
    height: 10,
  });

  async function bodyFor(image: ReturnType<typeof bodyImage>, viewer: Viewer) {
    dbMock.dbRead.article.findFirst.mockResolvedValue({
      id: 1,
      userId: OWNER,
      nsfwLevel: 1,
      status: ArticleStatus.Published,
      ingestion: ArticleIngestionStatus.Scanned,
      tags: [],
      content: `<p>x</p><img src="https://image.civitai.com/abc/${BODY_UUID}/width=450">`,
      metadata: null,
      coverImage: null,
      bannerImage: null,
    } as never);
    // Answers only what the query selects, so a body image read without `minor` comes back without it.
    dbMock.dbRead.imageConnection.findMany.mockImplementation((async (args: {
      include?: { image?: { select?: { minor?: boolean } } };
    }) => {
      const { minor, ...unflagged } = image;
      return [{ image: args.include?.image?.select?.minor ? image : unflagged }];
    }) as never);
    const article = await getArticleById({
      id: 1,
      userId: viewer?.id,
      isModerator: viewer?.isModerator,
    });
    return {
      ids: article.contentImages.map((i) => i.id),
      inBody: !!article.content?.includes(BODY_UUID),
      images: article.contentImages,
    };
  }

  it.each([['a signed-out viewer'], ['a stranger']] as const)(
    'withholds a minor-flagged body image rated R or above from %s, list and body',
    async (who) => {
      expect(await bodyFor(bodyImage(4, true), viewers[who])).toMatchObject({
        ids: [],
        inBody: false,
      });
    }
  );

  it('serves an unflagged R body image to a stranger (control)', async () => {
    expect(await bodyFor(bodyImage(4, false), viewers['a stranger'])).toMatchObject({
      ids: [600],
      inBody: true,
    });
  });

  it.each([['the owner'], ['a moderator']] as const)(
    'keeps the restricted body image for %s (control)',
    async (who) => {
      expect(await bodyFor(bodyImage(4, true), viewers[who])).toMatchObject({
        ids: [600],
        inBody: true,
      });
    }
  );

  it('does not add the flag to the body images it returns', async () => {
    const { images } = await bodyFor(bodyImage(2, true), viewers['a stranger']);
    expect(images).toHaveLength(1);
    expect(images[0]).not.toHaveProperty('minor');
  });
});

// Article reads follow the article availability rule: the owner and moderators read, any other
// viewer gets the not-found answer.
describe('getArticleById follows the article availability rule', () => {
  const read = (availability: Availability, viewer: Viewer) => {
    dbMock.dbRead.article.findFirst.mockResolvedValue({
      id: 1,
      userId: OWNER,
      availability,
      nsfwLevel: 1,
      status: ArticleStatus.Published,
      ingestion: ArticleIngestionStatus.Scanned,
      tags: [],
      content: '',
      metadata: null,
      cover: null,
      coverImage: null,
      bannerImage: null,
    } as never);
    dbMock.dbRead.imageConnection.findMany.mockResolvedValue([] as never);
    return getArticleById({ id: 1, userId: viewer?.id, isModerator: viewer?.isModerator });
  };

  it.each(['a signed-out viewer', 'a stranger'] as const)(
    'follows the article availability rule for %s: not found',
    async (who) => {
      await expect(read(Availability.Private, viewers[who])).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    }
  );

  it.each(['the owner', 'a moderator'] as const)(
    'follows the article availability rule for %s: readable',
    async (who) => {
      await expect(read(Availability.Private, viewers[who])).resolves.toMatchObject({ id: 1 });
    }
  );

  it('follows the article availability rule for a public article, signed out', async () => {
    await expect(read(Availability.Public, undefined)).resolves.toMatchObject({ id: 1 });
  });
});

describe('the article page under the report-listed rule', () => {
  // The rule's per-viewer answer is pinned on real SQL in article-card-cover.behavior.test.ts;
  // here the database names the image as hidden, and the page must drop it.
  beforeEach(() => {
    (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: COVER },
    ]);
  });

  async function detail(field: 'coverImage' | 'bannerImage', seesReportListed: boolean) {
    dbMock.dbRead.article.findFirst.mockResolvedValue({
      id: 1,
      userId: OWNER,
      nsfwLevel: 1,
      status: ArticleStatus.Published,
      ingestion: ArticleIngestionStatus.Scanned,
      tags: [],
      content: '',
      metadata: null,
      cover: 'cover-key',
      coverImage: null,
      bannerImage: null,
      [field]: cover(1, false),
    } as never);
    dbMock.dbRead.imageConnection.findMany.mockResolvedValue([] as never);
    return getArticleById({
      id: 1,
      userId: STRANGER,
      reportListedViewer: { seesReportListed },
    });
  }

  it.each(['coverImage', 'bannerImage'] as const)('drops a hidden %s', async (field) => {
    expect((await detail(field, false))[field]).toBeUndefined();
  });

  it('drops the legacy cover key with a hidden cover', async () => {
    expect((await detail('coverImage', false)).cover).toBeNull();
  });

  it.each(['coverImage', 'bannerImage'] as const)(
    'keeps the %s for a viewer who sees report-listed images',
    async (field) => {
      expect((await detail(field, true))[field]).toMatchObject({ id: COVER });
    }
  );
});

describe('the article page body under the report-listed rule', () => {
  // Body image ids, each listed on a report: one the article's owner uploaded, one someone else did.
  const OWN_BODY = 601;
  const OTHERS_BODY = 602;
  const CLEAN_BODY = 603;
  const uuid = (id: number) => `${id}${id}${id}aaaa-bbbb-4ccc-8ddd-${String(id).repeat(4)}`;
  const body = (id: number, userId: number) => ({
    id,
    url: uuid(id),
    nsfwLevel: 1,
    minor: false,
    modelRestricted: false,
    userId,
    ingestion: 'Scanned',
    needsReview: null,
    tosViolation: false,
    hash: null,
    width: 10,
    height: 10,
  });
  const images = [
    body(OWN_BODY, OWNER),
    body(OTHERS_BODY, OTHER_IMAGE_OWNER),
    body(CLEAN_BODY, OWNER),
  ];

  let pg: PGlite;
  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL);
      CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, images jsonb);
      INSERT INTO "Image" (id, "userId") VALUES
        (${OWN_BODY}, ${OWNER}), (${OTHERS_BODY}, ${OTHER_IMAGE_OWNER}), (${CLEAN_BODY}, ${OWNER}),
        (${COVER}, ${OWNER});
      INSERT INTO "CsamReport" (images) VALUES ('[${OWN_BODY}, {"id": ${OTHERS_BODY}}, ${COVER}]');
    `);
  });
  afterAll(() => pg?.close());

  beforeEach(() => {
    dbMock.dbRead.$queryRaw.mockImplementation((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const sql = Prisma.sql(strings, ...(values as never[]));
      return sql.text.includes('"CsamReport"') ? (await pg.query(sql.text, sql.values)).rows : [];
    }) as never);
    dbMock.dbRead.article.findFirst.mockResolvedValue({
      id: 1,
      userId: OWNER,
      nsfwLevel: 1,
      status: ArticleStatus.Published,
      ingestion: ArticleIngestionStatus.Scanned,
      tags: [],
      content: images
        .map((i) => `<img src="https://image.civitai.com/abc/${i.url}/width=450">`)
        .join(''),
      metadata: null,
      coverImage: null,
      bannerImage: null,
    } as never);
    dbMock.dbRead.imageConnection.findMany.mockResolvedValue(
      images.map((image) => ({ image })) as never
    );
  });

  const shownTo = async (
    viewer: Viewer,
    reportListedViewer: { seesReportListed: boolean; ownerSeesReportListed?: boolean }
  ) => {
    const article = await getArticleById({
      id: 1,
      userId: viewer?.id,
      isModerator: viewer?.isModerator,
      reportListedViewer,
    });
    const ids = article.contentImages.map((i) => i.id);
    for (const image of images)
      expect(article.content?.includes(image.url), `image ${image.id} in the body`).toBe(
        ids.includes(image.id)
      );
    return ids;
  };
  const SESSION = { seesReportListed: false, ownerSeesReportListed: true };

  it.each<[string, Viewer]>([
    ['a signed-out viewer', undefined],
    ['a stranger', { id: STRANGER }],
    ['a moderator without the grant', { id: MOD, isModerator: true }],
  ])('🔴 withholds every listed body image from %s', async (_, viewer) => {
    expect(await shownTo(viewer, SESSION)).toEqual([CLEAN_BODY]);
  });

  it("🔴 withholds from the article's owner a listed body image someone else uploaded", async () => {
    expect(await shownTo({ id: OWNER }, SESSION)).toEqual([OWN_BODY, CLEAN_BODY]);
  });

  it('🔴 withholds from the uploader on a scoped key', async () => {
    expect(
      await shownTo({ id: OWNER }, { seesReportListed: false, ownerSeesReportListed: false })
    ).toEqual([CLEAN_BODY]);
  });

  it('keeps every body image for a held-media viewer (control)', async () => {
    expect(
      await shownTo(
        { id: MOD, isModerator: true },
        { seesReportListed: true, ownerSeesReportListed: true }
      )
    ).toEqual([OWN_BODY, OTHERS_BODY, CLEAN_BODY]);
  });

  it.each<[string, Viewer, typeof SESSION, boolean]>([
    ['its uploader', { id: OWNER }, SESSION, true],
    ['a stranger', { id: STRANGER }, SESSION, false],
    [
      'its uploader on a scoped key',
      { id: OWNER },
      { ...SESSION, ownerSeesReportListed: false },
      false,
    ],
  ])('a listed cover and %s', async (_, viewer, reportListedViewer, shown) => {
    dbMock.dbRead.article.findFirst.mockResolvedValue({
      id: 1,
      userId: OWNER,
      nsfwLevel: 1,
      status: ArticleStatus.Published,
      ingestion: ArticleIngestionStatus.Scanned,
      tags: [],
      content: '',
      metadata: null,
      cover: 'cover-key',
      coverImage: cover(1, false),
      bannerImage: null,
    } as never);
    dbMock.dbRead.imageConnection.findMany.mockResolvedValue([] as never);
    const article = await getArticleById({
      id: 1,
      userId: viewer?.id,
      isModerator: viewer?.isModerator,
      reportListedViewer,
    });
    expect(article.coverImage?.id).toBe(shown ? COVER : undefined);
  });
});
