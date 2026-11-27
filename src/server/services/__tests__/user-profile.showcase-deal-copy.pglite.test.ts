import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { assertShowcaseItemsOwned } from '~/server/services/user-profile.service';

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
    INSERT INTO "ServiceDealFile" ("imageId", "scanKey") VALUES (${OWN_COPY}, 'copy');
  `);
});

beforeEach(() => {
  const raw = pgliteRaw(db);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(((
    s: TemplateStringsArray,
    ...v: unknown[]
  ) => raw.queryRaw(s, ...v)) as never);
  // The owner's rows, scanned and unblocked, as the ownership read returns them.
  vi.mocked(dbMock.dbWrite.image.findMany).mockImplementation((async (args: {
    where: { id: { in: number[] } };
  }) => args.where.id.in.map((id) => ({ id, ingestion: 'Scanned', blockedFor: null }))) as never);
});

afterAll(() => db.close());

describe('the profile showcase', () => {
  const showcase = (entityId: number, isModerator = false) =>
    assertShowcaseItemsOwned({
      userId: OWNER,
      isModerator,
      showcaseItems: [{ entityType: 'Image', entityId }],
      currentShowcaseItems: [],
    });

  it.each([false, true])(
    "refuses a deal file's preview copy, the owner's own row (moderator: %s)",
    async (isModerator) => {
      await expect(showcase(OWN_COPY, isModerator)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  );

  it("takes the owner's plain image (control)", async () => {
    await expect(showcase(OWN)).resolves.toBeUndefined();
  });
});
