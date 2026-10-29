import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as ImageService from '~/server/services/image.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  enqueueImageIngestion: vi.fn(),
}));

const { linkArticleContentImages } = await import('~/server/services/article.service');

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
  dbMock.dbWrite.$transaction.mockImplementation(((cb: (tx: unknown) => unknown) =>
    cb({
      $queryRaw: pgliteRaw(db).queryRaw,
      image: { findMany: async () => [], createManyAndReturn },
      imageConnection: { upsert: vi.fn(), findMany: async () => [], deleteMany: vi.fn() },
    })) as never);
});

describe('linkArticleContentImages', () => {
  it('creates no image row for a key shop artwork uses, and still creates the others', async () => {
    await linkArticleContentImages({
      articleId: 1,
      content: `<p>${img(SHOP_KEY)}${img(FREE_KEY)}</p>`,
      userId: 7,
      ownerId: 7,
    });

    expect(createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(createManyAndReturn.mock.calls[0][0].data.map((row) => row.url)).toEqual([FREE_KEY]);
  });
});
