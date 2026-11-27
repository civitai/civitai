import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { assertCoverImagesValid } from '~/server/services/model-cover.service';

const MODEL = 1;
const OWNER = 7;
const OWN = 10;
const OWN_COPY = 11;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL, url text NOT NULL);
    CREATE TABLE "ServiceDealFileEntry" (id serial PRIMARY KEY, "imageId" int, "scanKey" text);
    CREATE TABLE "ServiceDealFile" (id serial PRIMARY KEY, "imageId" int, "scanKey" text);
    INSERT INTO "Image" VALUES (${OWN}, ${OWNER}, 'own'), (${OWN_COPY}, ${OWNER}, 'copy');
    INSERT INTO "ServiceDealFileEntry" ("scanKey") VALUES ('copy');
  `);
});

beforeEach(() => {
  const raw = pgliteRaw(db);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(((
    s: TemplateStringsArray,
    ...v: unknown[]
  ) => raw.queryRaw(s, ...v)) as never);
  // Both read as the owner's published images on the model, as a copy would if it ever got a post.
  vi.mocked(dbMock.dbRead.image.findMany).mockImplementation((async (args: {
    where: { id: { in: number[] } };
  }) => args.where.id.in.map((id) => ({ id, nsfwLevel: 1 }))) as never);
});

afterAll(() => db.close());

describe("a model's covers", () => {
  it.each(['coverImageId', 'sfwCoverImageId'] as const)(
    "refuse a deal file's copy as %s, the owner's own row",
    async (column) => {
      await expect(
        assertCoverImagesValid({ modelId: MODEL, ownerId: OWNER, [column]: OWN_COPY })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  );

  it.each(['coverImageId', 'sfwCoverImageId'] as const)(
    "take the owner's plain image as %s (control)",
    async (column) => {
      await expect(
        assertCoverImagesValid({ modelId: MODEL, ownerId: OWNER, [column]: OWN })
      ).resolves.toBeUndefined();
    }
  );
});
