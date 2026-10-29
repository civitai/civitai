import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as RedisCaches from '~/server/redis/caches';
import type * as ImageService from '~/server/services/image.service';

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
    CREATE TABLE "CosmeticShopItem" ("id" integer PRIMARY KEY, "meta" jsonb NOT NULL DEFAULT '{}');
    CREATE TABLE "ItemDefinition" ("id" integer PRIMARY KEY, "imageUrl" text);
    INSERT INTO "Cosmetic" (id, data) VALUES (1, '{"url":"${SHOP_KEY}"}');
  `);
});

beforeEach(() => {
  createManyAndReturn.mockClear();
  enqueueImageIngestion.mockClear();
  // The shop-key lookup runs on PGlite; every other raw query in the save gets no rows.
  dbMock.dbWrite.$queryRaw.mockImplementation(((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) =>
    strings.join('').includes('unnest(')
      ? pgliteRaw(db).queryRaw(strings, ...values)
      : Promise.resolve([])) as never);
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

describe('upsertArticle', () => {
  const save = (content: string) =>
    upsertArticle({ userId: 7, title: 'A title', content } as never);
  beforeEach(() => {
    dbMock.dbWrite.$transaction.mockImplementation(((cb: (tx: unknown) => unknown) =>
      cb(dbMock.dbWrite)) as never);
  });

  it('refuses content that embeds a shop artwork key, before writing the article', async () => {
    await expect(save(`<p>${img(SHOP_KEY)}</p>`)).rejects.toThrow(/can no longer be used/);
    expect(dbMock.dbWrite.article.create).not.toHaveBeenCalled();
  });

  it('saves content whose images no shop row uses', async () => {
    await save(`<p>${img(FREE_KEY)}</p>`);
    expect(dbMock.dbWrite.article.create).toHaveBeenCalled();
  });
});
