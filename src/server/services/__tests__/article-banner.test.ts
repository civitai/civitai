import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
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
