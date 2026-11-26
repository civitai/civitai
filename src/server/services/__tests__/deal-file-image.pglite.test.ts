import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { assertNotDealFileImages } from '~/server/services/deal-file-image';

const ENTRY_COPY = 1;
const PREVIEW_COPY = 2;
const PLAIN = 3;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "ServiceDealFileEntry" (id serial PRIMARY KEY, "imageId" int);
    CREATE TABLE "ServiceDealFile" (id serial PRIMARY KEY, "imageId" int);
    INSERT INTO "ServiceDealFileEntry" ("imageId") VALUES (${ENTRY_COPY}), (NULL);
    INSERT INTO "ServiceDealFile" ("imageId") VALUES (${PREVIEW_COPY}), (NULL);
  `);
  const raw = pgliteRaw(db);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(((
    s: TemplateStringsArray,
    ...v: unknown[]
  ) => raw.queryRaw(s, ...v)) as never);
});

afterAll(() => db.close());

describe('assertNotDealFileImages', () => {
  it.each([
    ["a Final or Attachment entry's copy", ENTRY_COPY],
    ["a preview's copy", PREVIEW_COPY],
  ])('refuses %s', async (_, id) => {
    await expect(assertNotDealFileImages([PLAIN, id], 'used here')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('passes an image no deal file points at (control)', async () => {
    await expect(assertNotDealFileImages([PLAIN], 'used here')).resolves.toBeUndefined();
  });
});
