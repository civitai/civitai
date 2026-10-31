import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as RedisCaches from '~/server/redis/caches';
import type * as ImageService from '~/server/services/image.service';
import { ARTICLE_CONTENT_IMAGE_UNAVAILABLE_MESSAGE } from '~/server/services/image-url-ownership';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { enqueueImageIngestion } = vi.hoisted(() => ({ enqueueImageIngestion: vi.fn() }));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  enqueueImageIngestion,
}));

vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  preventReplicationLag: vi.fn(async () => undefined),
  getDbWithoutLag: vi.fn(async () => dbMock.dbRead),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof RedisCaches>();
  return {
    ...actual,
    userArticleCountCache: {
      ...actual.userArticleCountCache,
      refresh: vi.fn(async () => undefined),
    },
  };
});
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSystemTags: async () => [],
}));

const { linkArticleContentImages, upsertArticle } = await import(
  '~/server/services/article.service'
);

const SHOP_KEY = '0a0b0c0d-0000-4000-8000-0000000000aa';
const FREE_KEY = '0a0b0c0d-0000-4000-8000-0000000000bb';
const SECOND_SHOP_KEY = '0a0b0c0d-0000-4000-8000-0000000000cc';
const img = (key: string) =>
  `<img src="https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${key}/original=true/a.jpeg">`;

let db: PGlite;
const createManyAndReturn = vi.fn(async ({ data }: { data: { url: string }[] }) =>
  data.map((row, i) => ({ id: i + 1, url: row.url }))
);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Cosmetic" ("id" integer PRIMARY KEY, "data" jsonb NOT NULL);
    CREATE TABLE "CosmeticShopItem" (
      "id" integer PRIMARY KEY, "cosmeticId" integer, "meta" jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE "ItemDefinition" ("id" integer PRIMARY KEY, "imageUrl" text);
    CREATE TABLE "ImageCdnShopTakedown" (url text, "shopItemId" integer, PRIMARY KEY (url, "shopItemId"));
    CREATE TABLE "Image" ("id" serial PRIMARY KEY, "userId" integer NOT NULL, "url" text NOT NULL);
    INSERT INTO "Cosmetic" (id, data) VALUES (1, '{"url":"${SHOP_KEY}"}');
    INSERT INTO "CosmeticShopItem" (id, "cosmeticId") VALUES (9, 1);
    INSERT INTO "ItemDefinition" (id, "imageUrl") VALUES (1, '${SECOND_SHOP_KEY}');
  `);
});

beforeEach(() => {
  createManyAndReturn.mockClear();
  enqueueImageIngestion.mockClear();
  // The shop-key and image-ownership lookups run on PGlite; the other raw queries get fixed answers.
  dbMock.dbWrite.$queryRaw.mockImplementation(((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    // A query passed as one Prisma.sql value has no template strings.
    const sql = Array.isArray(strings) ? strings.join('') : '';
    if (sql.includes('unnest(') || sql.includes('FROM "Image" WHERE url = ANY('))
      return pgliteRaw(db).queryRaw(strings, ...values);
    // The owner's legal-hold read: not held.
    return Promise.resolve(sql.includes(' AS held') ? [{ held: false }] : []);
  }) as never);
  dbMock.dbWrite.article.create.mockResolvedValue({ id: 1, userId: 7, content: '' } as never);
  dbMock.dbWrite.$transaction.mockImplementation(((cb: (tx: unknown) => unknown) =>
    cb({
      $queryRaw: pgliteRaw(db).queryRaw,
      image: { findMany: async () => [], createManyAndReturn },
      imageConnection: { upsert: vi.fn(), findMany: async () => [], deleteMany: vi.fn() },
    })) as never);
});

describe('linkArticleContentImages', () => {
  // Every content image is rated through its own row; one the article holds unscanned would never
  // count toward the article's level.
  it('creates and queues a scan for every content image, a shop artwork key included', async () => {
    await linkArticleContentImages({
      articleId: 1,
      content: `<p>${img(SHOP_KEY)}${img(FREE_KEY)}</p>`,
      userId: 7,
      ownerId: 7,
    });

    const created = createManyAndReturn.mock.calls[0][0].data.map((row) => row.url);
    expect(created).toEqual([SHOP_KEY, FREE_KEY]);
    const queued = enqueueImageIngestion.mock.calls.flatMap(([{ images }]) =>
      images.map((image: { url: string }) => image.url)
    );
    expect(queued).toEqual([SHOP_KEY, FREE_KEY]);
  });
});

describe('linkArticleContentImages orphan cleanup', () => {
  // An article saved before shop keys were refused can hold one as the author's own image row.
  it('never offers for deletion an orphaned image whose key shop artwork uses', async () => {
    const orphans = [
      { id: 5, url: SHOP_KEY },
      { id: 6, url: FREE_KEY },
    ];
    dbMock.dbWrite.$transaction.mockImplementation(((cb: (tx: unknown) => unknown) =>
      cb({
        $queryRaw: pgliteRaw(db).queryRaw,
        image: {
          findMany: async ({ where }: { where: { id?: unknown } }) => (where.id ? orphans : []),
          createManyAndReturn,
        },
        imageConnection: {
          upsert: vi.fn(),
          findMany: async () => orphans.map((orphan) => ({ imageId: orphan.id })),
          deleteMany: vi.fn(),
        },
        serviceOffering: { findMany: async () => [] },
      })) as never);

    const { orphanedImageIds } = await linkArticleContentImages({
      articleId: 1,
      content: '<p>both images removed</p>',
      userId: 7,
      ownerId: 7,
    });

    expect(orphanedImageIds).toEqual([6]);
  });
});

describe('upsertArticle', () => {
  const save = (content: string) =>
    upsertArticle({ userId: 7, title: 'A title', content } as never);
  beforeEach(() => {
    dbMock.dbWrite.$transaction.mockImplementation(((cb: (tx: unknown) => unknown) =>
      cb(dbMock.dbWrite)) as never);
  });

  it('refuses content that embeds a shop artwork key, before writing the article', async () => {
    // A key with an image row: only the shop artwork check, not the ownership check, can refuse it.
    dbMock.dbWrite.image.findMany.mockResolvedValue([{ url: SHOP_KEY }] as never);
    await expect(save(`<p>${img(SHOP_KEY)}</p>`)).rejects.toThrow(
      ARTICLE_CONTENT_IMAGE_UNAVAILABLE_MESSAGE
    );
    expect(dbMock.dbWrite.article.create).not.toHaveBeenCalled();
  });

  // Articles saved before the check may already hold one; they must stay editable.
  it('saves an edit that keeps a shop artwork key the stored article already holds', async () => {
    const stored = {
      id: 1,
      userId: 7,
      title: 'Stored',
      content: `<p>${img(SHOP_KEY)}</p>`,
      coverId: null,
      status: 'Published',
      publishedAt: new Date(),
      nsfwLevel: 1,
      userNsfwLevel: 1,
      lockedProperties: [],
      metadata: {},
    };
    dbMock.dbWrite.article.findUnique.mockResolvedValue(stored as never);
    dbMock.dbRead.article.findUnique.mockResolvedValue(stored as never);
    dbMock.dbWrite.article.update.mockResolvedValue({ ...stored, tags: [] } as never);

    await upsertArticle({
      id: 1,
      userId: 7,
      title: 'New title',
      content: `<p>${img(SHOP_KEY)}</p><p>more</p>`,
    } as never);
    expect(dbMock.dbWrite.article.update).toHaveBeenCalled();

    dbMock.dbWrite.article.update.mockClear();
    await expect(
      upsertArticle({
        id: 1,
        userId: 7,
        title: 'New title',
        content: `<p>${img(SHOP_KEY)}${img(SECOND_SHOP_KEY)}</p>`,
      } as never)
    ).rejects.toThrow(ARTICLE_CONTENT_IMAGE_UNAVAILABLE_MESSAGE);
    expect(dbMock.dbWrite.article.update).not.toHaveBeenCalled();
  });

  // Content can be stored with no Image row (linking failed, or scanning was off).
  it('saves an edit that keeps a stored shop artwork key with no image row', async () => {
    const stored = {
      id: 1,
      userId: 7,
      title: 'Stored',
      content: `<p>${img(SECOND_SHOP_KEY)}</p>`,
      coverId: null,
      status: 'Draft',
      publishedAt: null,
      nsfwLevel: 1,
      userNsfwLevel: 1,
      lockedProperties: [],
      metadata: {},
    };
    dbMock.dbWrite.article.findUnique.mockResolvedValue(stored as never);
    dbMock.dbRead.article.findUnique.mockResolvedValue(stored as never);
    dbMock.dbWrite.article.update.mockResolvedValue({ ...stored, tags: [] } as never);
    dbMock.dbWrite.image.findMany.mockResolvedValue([] as never);

    await upsertArticle({
      id: 1,
      userId: 7,
      title: 'New title',
      content: stored.content,
    } as never);

    expect(dbMock.dbWrite.article.update).toHaveBeenCalled();
  });

  it('saves content whose images no shop row uses', async () => {
    await save(`<p>${img(FREE_KEY)}</p>`);
    expect(dbMock.dbWrite.article.create).toHaveBeenCalled();
  });
});
