import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { assertNotDealFileImages } from '~/server/services/deal-file-image';

const ENTRY_COPY = 1;
const PREVIEW_COPY = 2;
const PLAIN = 3;
const UNPOINTED_ENTRY_COPY = 4;
const UNPOINTED_PREVIEW_COPY = 5;
const REVIEW_COPY = 6;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Image" (id int PRIMARY KEY, url text NOT NULL);
    CREATE TABLE "ServiceDealFileEntry" (id serial PRIMARY KEY, "imageId" int, "scanKey" text);
    CREATE TABLE "ServiceDealFile" (id serial PRIMARY KEY, "imageId" int, "scanKey" text);
    CREATE TABLE "ServiceDealReviewImage" ("reviewId" int NOT NULL, "imageId" int NOT NULL);
    INSERT INTO "ServiceDealReviewImage" VALUES (1, ${REVIEW_COPY});
    INSERT INTO "Image" (id, url) VALUES
      (${ENTRY_COPY}, 'entry-key'), (${PREVIEW_COPY}, 'preview-key'), (${PLAIN}, 'plain-key'),
      (${UNPOINTED_ENTRY_COPY}, 'unpointed-entry-key'),
      (${UNPOINTED_PREVIEW_COPY}, 'unpointed-preview-key'), (${REVIEW_COPY}, 'review-key');
    INSERT INTO "ServiceDealFileEntry" ("imageId", "scanKey")
      VALUES (${ENTRY_COPY}, 'entry-key'), (NULL, 'unpointed-entry-key'), (NULL, NULL);
    INSERT INTO "ServiceDealFile" ("imageId", "scanKey")
      VALUES (${PREVIEW_COPY}, 'preview-key'), (NULL, 'unpointed-preview-key'), (NULL, NULL);
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
    // The key is recorded before the copy's Image row, the pointer only after it.
    ["an entry's copy whose pointer is not written yet", UNPOINTED_ENTRY_COPY],
    ["a preview's copy whose pointer is not written yet", UNPOINTED_PREVIEW_COPY],
  ])('refuses %s', async (_, id) => {
    await expect(assertNotDealFileImages([PLAIN, id], 'used here')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it("refuses a service review's copy as a use, and leaves its delete to the delete rules", async () => {
    await expect(assertNotDealFileImages([REVIEW_COPY], 'used here')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(assertNotDealFileImages([REVIEW_COPY], 'deleted')).resolves.toBeUndefined();
  });

  it('passes an image no deal file points at (control)', async () => {
    await expect(assertNotDealFileImages([PLAIN], 'used here')).resolves.toBeUndefined();
  });
});
