import { serverCopyTablesSql } from '@civitai/db-queries/test/image-uses';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { updateCreatorShopSettings } from '~/server/services/creator-shop.service';

const OWNER = 1;
const OTHER = 2;
const OWN = 10;
const OWN_COPY = 11;
const OTHERS = 12;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, settings jsonb NOT NULL DEFAULT '{}');
    INSERT INTO "User" (id) VALUES (${OWNER});
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL, url text NOT NULL);
    ${serverCopyTablesSql};
    INSERT INTO "Image" VALUES (${OWN}, ${OWNER}, 'own'), (${OWN_COPY}, ${OWNER}, 'copy'),
      (${OTHERS}, ${OTHER}, 'others');
    INSERT INTO "ServiceDealFileEntry" ("imageId", "scanKey") VALUES (${OWN_COPY}, 'copy');
  `);
});

beforeEach(() => {
  const raw = pgliteRaw(db);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(((
    s: TemplateStringsArray,
    ...v: unknown[]
  ) => raw.queryRaw(s, ...v)) as never);
  vi.mocked(dbMock.dbWrite.$queryRawUnsafe).mockImplementation(
    (async (text: string, ...v: unknown[]) => (await db.query(text, v)).rows) as never
  );
  vi.mocked(dbMock.dbWrite.$executeRawUnsafe).mockImplementation(
    (async (text: string, ...v: unknown[]) => (await db.query(text, v)).affectedRows ?? 0) as never
  );
  vi.mocked(dbMock.dbWrite.image.findFirst).mockImplementation(
    (async ({ where }: { where: { id: number; userId: number } }) =>
      (
        await db.query(`SELECT id FROM "Image" WHERE id = $1 AND "userId" = $2`, [
          where.id,
          where.userId,
        ])
      ).rows[0] ?? null) as never
  );
  // The settings merge runs on the same database.
  vi.mocked(dbMock.dbWrite.$transaction).mockImplementation(((
    run: (tx: typeof dbMock.dbWrite) => unknown
  ) => run(dbMock.dbWrite)) as never);
});

afterAll(() => db.close());

describe("the shop's cover image", () => {
  const setCover = (coverImageId: number) =>
    updateCreatorShopSettings({ userId: OWNER, coverImageId });

  it("refuses a deal file's scan copy, though the shop owner owns it", async () => {
    await expect(setCover(OWN_COPY)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it("refuses another user's image", async () => {
    await expect(setCover(OTHERS)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it("takes the shop owner's own image (control)", async () => {
    await expect(setCover(OWN)).resolves.toBeDefined();
  });
});
