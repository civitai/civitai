import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { WITHHELD_MEDIA_TYPE } from '~/shared/constants/withheld-media.constants';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as SystemCache from '~/server/services/system-cache';
import type * as UserService from '~/server/services/user.service';
import type * as FileService from '~/server/services/file.service';
import { ArticleIngestionStatus, ArticleStatus } from '~/shared/utils/prisma/enums';

/**
 * The article banner is a second image stored on the `Article` row, beside the cover. Each test
 * here fails if the banner is left out of the path it covers: an X banner on a PG article, an
 * unscanned banner publishing the article, or a pending banner shown to a reader.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn(async () => undefined) },
  bountiesSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  comicsSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
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

const { updateArticleNsfwLevels } = await import('~/server/services/nsfwLevels.service');
const { recomputeArticleIngestionInTx, getArticleById } = await import(
  '~/server/services/article.service'
);
const { computeArticleDerivedNsfwLevel, evaluateAutoApproveGate } = await import(
  '~/server/services/article-rating-review.helpers'
);

const ARTICLE_ID = 1;
const OWNER = 7;
const READER = 8;
const COVER = 10;
const BANNER = 11;

describe('article nsfwLevel recompute', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE TYPE "ReportReason" AS ENUM ('NSFW', 'TOSViolation');
      CREATE TYPE "ReportStatus" AS ENUM ('Pending', 'Actioned', 'Unactioned');
      CREATE TABLE "Image" (id int PRIMARY KEY, "nsfwLevel" int NOT NULL, ingestion text NOT NULL);
      CREATE TABLE "Article" (
        id int PRIMARY KEY, "coverId" int, "bannerId" int, "nsfwLevel" int NOT NULL DEFAULT 0,
        "userNsfwLevel" int NOT NULL DEFAULT 0, "moderatorNsfwLevel" int
      );
      CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
      CREATE TABLE "EntityModeration" (
        "entityType" text, "entityId" int, status text, blocked boolean, "nsfwLevel" int,
        result jsonb, "triggeredLabels" text[]
      );
      CREATE TABLE "Report" (id int PRIMARY KEY, reason "ReportReason", status "ReportStatus");
      CREATE TABLE "ArticleReport" ("articleId" int, "reportId" int);
    `);
    const raw = pgliteRaw(db);
    for (const client of [dbMock.dbWrite, dbMock.dbRead])
      (client.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(raw.queryRaw);
  });

  beforeEach(async () => {
    await db.exec(`TRUNCATE "Image", "Article";`);
  });

  const levelAfterRecompute = async (banner: { nsfwLevel: number; ingestion: string }) => {
    await db.query(`INSERT INTO "Image" VALUES ($1, $2, 'Scanned'), ($3, $4, $5)`, [
      COVER,
      NsfwLevel.PG,
      BANNER,
      banner.nsfwLevel,
      banner.ingestion,
    ]);
    await db.query(
      `INSERT INTO "Article" (id, "coverId", "bannerId", "nsfwLevel", "userNsfwLevel") VALUES ($1, $2, $3, $4, $4)`,
      [ARTICLE_ID, COVER, BANNER, NsfwLevel.PG]
    );
    await updateArticleNsfwLevels([ARTICLE_ID]);
    const [row] = (
      await db.query<{ nsfwLevel: number }>(`SELECT "nsfwLevel" FROM "Article" WHERE id = $1`, [
        ARTICLE_ID,
      ])
    ).rows;
    return row.nsfwLevel;
  };

  it('raises a PG article with a PG cover to the rating of its scanned X banner', async () => {
    expect(await levelAfterRecompute({ nsfwLevel: NsfwLevel.X, ingestion: 'Scanned' })).toBe(
      NsfwLevel.X
    );
  });

  it("counts a scanned X banner in a rating dispute's derived level", async () => {
    await levelAfterRecompute({ nsfwLevel: NsfwLevel.X, ingestion: 'Scanned' });
    expect(await computeArticleDerivedNsfwLevel(ARTICLE_ID)).toBe(NsfwLevel.X);
  });

  it('takes a blocked banner to Blocked, as a blocked cover does', async () => {
    expect(await levelAfterRecompute({ nsfwLevel: NsfwLevel.Blocked, ingestion: 'Blocked' })).toBe(
      NsfwLevel.Blocked
    );
  });
});

describe('article ingestion recompute', () => {
  const recompute = async (bannerIngestion: string) => {
    const writes: Prisma.Sql[] = [];
    const tx = {
      $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        writes.push(Prisma.sql(strings, ...values));
        return 1;
      }),
      imageConnection: { findMany: vi.fn(async () => []) },
      article: {
        findUniqueOrThrow: vi.fn(async () => ({
          ingestion: ArticleIngestionStatus.Pending,
          status: ArticleStatus.Processing,
          publishedAt: null,
          userId: OWNER,
          title: '',
          content: '',
          coverId: COVER,
          bannerId: BANNER,
          moderatorNsfwLevel: null,
        })),
      },
      image: {
        findMany: vi.fn(async ({ where }: { where: { id: { in: number[] } } }) =>
          where.id.in.map((id) => ({
            ingestion: id === BANNER ? bannerIngestion : 'Scanned',
          }))
        ),
      },
      entityModeration: { findUnique: vi.fn(async () => null) },
      articleContentLinkHold: { findUnique: vi.fn(async () => null) },
      accessToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    const result = await recomputeArticleIngestionInTx(
      tx as unknown as Prisma.TransactionClient,
      ARTICLE_ID
    );
    const update = writes.find((w) => w.sql.includes('ingestion ='));
    return {
      ingestion: update?.values[0],
      published: result.publishedNotificationUserId != null,
      blockedImages: result.problemsNotification?.blockedImages ?? 0,
      revokedShareLinks: tx.accessToken.updateMany.mock.calls.length > 0,
    };
  };

  it('keeps an article Pending, and unpublished, while its banner is unscanned', async () => {
    expect(await recompute('Pending')).toEqual({
      ingestion: ArticleIngestionStatus.Pending,
      published: false,
      blockedImages: 0,
      revokedShareLinks: false,
    });
  });

  it('blocks the article, and tells the author, when its banner is blocked', async () => {
    expect(await recompute('Blocked')).toEqual({
      ingestion: ArticleIngestionStatus.Blocked,
      published: false,
      blockedImages: 1,
      revokedShareLinks: false,
    });
  });

  it('publishes once the cover and banner are both scanned', async () => {
    expect(await recompute('Scanned')).toEqual({
      ingestion: ArticleIngestionStatus.Scanned,
      published: true,
      blockedImages: 0,
      revokedShareLinks: true,
    });
  });
});

describe('rating dispute auto-approve gate', () => {
  const gate = (bannerIngestion: string) => {
    dbMock.dbRead.image.findMany.mockImplementation((async ({ where }: any) =>
      where.id.in.map((id: number) => ({
        ingestion: id === BANNER ? bannerIngestion : 'Scanned',
      }))) as never);
    dbMock.dbRead.imageConnection.count.mockResolvedValue(0 as never);
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ derived: NsfwLevel.PG }] as never);
    return evaluateAutoApproveGate({
      article: {
        id: ARTICLE_ID,
        status: ArticleStatus.Published,
        ingestion: ArticleIngestionStatus.Scanned,
        nsfwLevel: NsfwLevel.R,
        moderatorNsfwLevel: NsfwLevel.R,
        moderatorNsfwLevelBasis: NsfwLevel.R,
        coverId: COVER,
        bannerId: BANNER,
      },
      suggestedLevel: NsfwLevel.PG,
    });
  };

  it('will not auto-approve a lower rating while the banner is unscanned', async () => {
    expect(await gate('Pending')).toMatchObject({ eligible: false });
  });

  it('auto-approves once the banner is scanned too', async () => {
    expect(await gate('Scanned')).toMatchObject({ eligible: true });
  });
});

describe('getArticleById banner visibility', () => {
  const bannerRow = (ingestion: string, needsReview: string | null = null) => ({
    id: BANNER,
    url: 'banner-key',
    nsfwLevel: NsfwLevel.PG,
    ingestion,
    needsReview,
    meta: null,
    metadata: null,
    tags: [],
  });

  const readBanner = async (
    banner: ReturnType<typeof bannerRow>,
    viewer: { userId?: number; isModerator?: boolean }
  ) => {
    dbMock.dbRead.article.findFirst.mockResolvedValue({
      id: ARTICLE_ID,
      userId: OWNER,
      nsfwLevel: NsfwLevel.PG,
      content: '',
      tags: [],
      metadata: null,
      coverImage: null,
      bannerImage: banner,
    } as never);
    dbMock.dbRead.imageConnection.findMany.mockResolvedValue([] as never);
    const article = await getArticleById({ id: ARTICLE_ID, ...viewer });
    return article.bannerImage;
  };

  it.each([
    ['an unscanned', bannerRow('Pending')],
    ['a blocked', bannerRow('Blocked')],
    ['a still-in-review', bannerRow('Scanned', 'poi')],
  ])('hides %s banner from a reader', async (_label, banner) => {
    expect(await readBanner(banner, { userId: READER })).toBeUndefined();
  });

  it('shows the owner and a moderator their unscanned banner', async () => {
    expect(await readBanner(bannerRow('Pending'), { userId: OWNER })).toMatchObject({
      id: BANNER,
    });
    expect(
      await readBanner(bannerRow('Pending'), { userId: READER, isModerator: true })
    ).toMatchObject({ id: BANNER });
  });

  it('shows a reader a scanned banner', async () => {
    expect(await readBanner(bannerRow('Scanned'), { userId: READER })).toMatchObject({
      id: BANNER,
    });
  });

  it('gives a moderator, not a reader, a mature banner restricted by its base model', async () => {
    const restricted = { ...bannerRow('Scanned'), nsfwLevel: NsfwLevel.R, modelRestricted: true };
    expect(await readBanner(restricted, { userId: READER, isModerator: true })).toMatchObject({
      id: BANNER,
    });
    expect(await readBanner(restricted, { userId: READER })).toBeUndefined();
  });
});

describe('getArticleById and a banner its model withholds', () => {
  const read = async (
    viewer: { userId?: number; isModerator?: boolean },
    { withheld, uploadedBy = OWNER }: { withheld: boolean; uploadedBy?: number }
  ) => {
    dbMock.dbRead.article.findFirst.mockResolvedValue({
      id: ARTICLE_ID,
      userId: OWNER,
      nsfwLevel: NsfwLevel.PG,
      content: '',
      tags: [],
      metadata: null,
      coverImage: null,
      bannerImage: {
        id: BANNER,
        userId: uploadedBy,
        url: 'banner-key',
        nsfwLevel: NsfwLevel.PG,
        ingestion: 'Scanned',
        needsReview: null,
        meta: null,
        metadata: null,
        tags: [],
      },
    } as never);
    dbMock.dbRead.imageConnection.findMany.mockResolvedValue([] as never);
    // The model-withheld read answers with the banner when its model withholds it.
    dbMock.dbRead.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) =>
      withheld && strings.join('?').includes('JOIN "Post" p ON p.id = i."postId"')
        ? [{ id: BANNER }]
        : []) as never);
    return getArticleById({ id: ARTICLE_ID, ...viewer });
  };

  it('🔴 hides it from a reader, without saying it is there', async () => {
    const article = await read({ userId: READER }, { withheld: true });
    expect(article.bannerImage).toBeUndefined();
    expect(article.bannerImageWithheld).toBe(false);
  });

  it('says nothing of it to a signed-out reader', async () => {
    const article = await read({}, { withheld: true });
    expect(article.bannerImage).toBeUndefined();
    expect(article.bannerImageWithheld).toBe(false);
  });

  it("🔴 hides it from the article's owner when someone else uploaded it", async () => {
    const article = await read({ userId: OWNER }, { withheld: true, uploadedBy: READER });
    expect(article.bannerImage).toBeUndefined();
    expect(article.bannerImageWithheld).toBe(true);
  });

  // The edit form reads this: the owner's own upload is theirs to see and keep.
  it.each([
    ['a moderator', { userId: READER, isModerator: true }],
    ['the article owner, who uploaded it', { userId: OWNER }],
  ])('shows it to %s', async (_, viewer) => {
    const article = await read(viewer, { withheld: true });
    expect(article.bannerImage).toMatchObject({ id: BANNER });
    expect(article.bannerImageWithheld).toBe(false);
  });

  it('shows a reader a banner its model does not withhold', async () => {
    expect((await read({ userId: READER }, { withheld: false })).bannerImage).toMatchObject({
      id: BANNER,
    });
  });
});

describe('getArticleById on a banner-only article', () => {
  // The edit form seeds coverImage from this read and saves it back, so a banner standing in for
  // the cover here would save coverId = bannerId (refused by the unique index) or give the article
  // a cover it never had. Cards fall back to the banner in their own reads, never in this one.
  it('does not substitute the banner for the cover, which the edit form would save back', async () => {
    dbMock.dbRead.article.findFirst.mockResolvedValue({
      id: ARTICLE_ID,
      userId: OWNER,
      nsfwLevel: NsfwLevel.PG,
      content: '',
      tags: [],
      metadata: null,
      coverImage: null,
      bannerImage: {
        id: BANNER,
        url: 'banner-key',
        nsfwLevel: NsfwLevel.PG,
        ingestion: 'Scanned',
        needsReview: null,
        meta: null,
        metadata: null,
        tags: [],
      },
    } as never);
    dbMock.dbRead.imageConnection.findMany.mockResolvedValue([] as never);
    const article = await getArticleById({ id: ARTICLE_ID, userId: OWNER });
    expect(article.coverImage ?? null).toBeNull();
    expect(article.bannerImage).toMatchObject({ id: BANNER });
  });
});

// The article's own read for its author: a cover, banner or body image whose block refuses its owner
// the media (`ownerMediaAllowed`) is withheld from them. An exempt block, and a moderator, keep it.
describe("getArticleById and an author's blocked images", () => {
  const ARTICLE_ID = 1;
  const OWNER = 7;
  const MODERATOR = 9;

  const image = (id: number, blockedFor: string | null) => ({
    id,
    url: `key-${id}`,
    hash: 'blur-hash',
    userId: OWNER,
    nsfwLevel: NsfwLevel.PG,
    ingestion: blockedFor ? 'Blocked' : 'Scanned',
    blockedFor,
    needsReview: null,
    tosViolation: false,
    modelRestricted: false,
    width: 1,
    height: 1,
    minor: false,
    meta: null,
    metadata: null,
    tags: [],
  });

  const read = async (
    blockedFor: string | null,
    viewer: { userId: number; isModerator?: boolean; edit?: boolean }
  ) => {
    const cover = image(10, blockedFor);
    const banner = image(11, blockedFor);
    const body = image(12, blockedFor);
    const clean = image(13, null);
    dbMock.dbRead.article.findFirst.mockResolvedValue({
      id: ARTICLE_ID,
      userId: OWNER,
      nsfwLevel: NsfwLevel.PG,
      cover: cover.url,
      content: `<p>text</p><img src="${body.url}"><img src="${clean.url}">`,
      tags: [],
      metadata: null,
      coverImage: cover,
      bannerImage: banner,
    } as never);
    dbMock.dbRead.imageConnection.findMany.mockResolvedValue([
      { image: body },
      { image: clean },
    ] as never);
    return getArticleById({ id: ARTICLE_ID, ...viewer });
  };

  describe.each(['tos', 'moderated'])(
    'getArticleById for the author of a %s-blocked image',
    (blockedFor) => {
      it('withholds the cover and banner, telling the edit form they are kept', async () => {
        const article = await read(blockedFor, { userId: OWNER });
        expect(article).toMatchObject({
          coverImage: undefined,
          bannerImage: undefined,
          coverImageWithheld: true,
          bannerImageWithheld: true,
          cover: null,
        });
        // No key of a blocked image anywhere in the answer, its blur hash included.
        const answer = JSON.stringify(article);
        for (const key of ['key-10', 'key-11', 'key-12']) expect(answer).not.toContain(key);
      });

      it('leaves the blocked body image out of the content and its image list', async () => {
        const article = await read(blockedFor, { userId: OWNER });
        expect(article.contentImages.map((i) => i.id)).toEqual([13]);
        expect(article.content).not.toContain('key-12');
        expect(article.content).toContain('key-13');
      });

      it('keeps every one with its media for a moderator', async () => {
        const article = await read(blockedFor, { userId: MODERATOR, isModerator: true });
        expect(article.coverImage).toMatchObject({ url: 'key-10', hash: 'blur-hash' });
        expect(article.bannerImage).toMatchObject({ url: 'key-11' });
        expect(article.contentImages.map((i) => i.id)).toEqual([12, 13]);
      });
    }
  );

  describe.each(['tos', 'moderated'])(
    "the author's edit form for a %s-blocked body image",
    (blockedFor) => {
      it('holds a placeholder in its place, naming no key, so a save keeps it', async () => {
        const article = await read(blockedFor, { userId: OWNER, edit: true });
        expect(article.content).not.toContain('key-12');
        expect(article.content).toContain(WITHHELD_MEDIA_TYPE);
        expect(article.content).toContain('key-13');
      });
    }
  );

  describe('getArticleById for the author of an image under an exempt block', () => {
    it('serves the cover and the body image with their media', async () => {
      const article = await read('AiNotVerified', { userId: OWNER });
      expect(article.coverImage).toMatchObject({ url: 'key-10', hash: 'blur-hash' });
      expect(article.cover).toBe('key-10');
      expect(article.contentImages.map((i) => i.id)).toEqual([12, 13]);
    });
  });
});
