import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A comic's level stamp skips a blocked panel image and reports how many it skipped. The stamp's
// own SQL runs against PGlite; the recompute, activity and index after it are faked.

import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

const PROJECT = 3;

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, ingestion "ImageIngestionStatus" NOT NULL,
      "nsfwLevel" int NOT NULL, "blockedFor" text
    );
    CREATE TABLE "ComicPanel" ("imageId" int, "projectId" int, "chapterPosition" int);
    CREATE TABLE "ComicChapter" ("projectId" int, position int, "nsfwLevel" int NOT NULL DEFAULT 0);
    CREATE TABLE "ComicProject" (id int PRIMARY KEY, "nsfwLevel" int NOT NULL DEFAULT 0, "coverImageId" int, "heroImageId" int);
    CREATE TABLE "ModActivity" ("userId" int, "entityType" text, activity text, "entityId" int);
  `);
});
afterAll(() => db.close());

const runRaw = async (strings: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
  const q = 'text' in strings ? strings : Prisma.sql(strings, ...values);
  return db.query(q.text, q.values);
};

beforeEach(async () => {
  vi.clearAllMocks();
  await db.exec(`TRUNCATE "Image", "ComicPanel", "ComicChapter", "ComicProject";`);
  // 1 clean; 2, 3, 4 each marked by one leg; 5 in another chapter; 6 in another project.
  await db.exec(`
    INSERT INTO "Image" VALUES
      (1, 'Scanned', 1, NULL), (2, 'Blocked', 1, NULL), (3, 'Scanned', 32, NULL),
      (4, 'Scanned', 1, 'moderated'), (5, 'Scanned', 1, NULL), (6, 'Scanned', 1, NULL);
    INSERT INTO "ComicChapter" VALUES (3, 0, 0), (3, 1, 0), (4, 0, 0);
    INSERT INTO "ComicProject" (id) VALUES (3), (4);
    INSERT INTO "ComicPanel" VALUES (1, 3, 0), (2, 3, 0), (3, 3, 0), (4, 3, 0), (5, 3, 1), (6, 4, 0);
  `);
  dbMock.dbWrite.$queryRaw.mockImplementation(
    (async (s: TemplateStringsArray, ...v: unknown[]) => (await runRaw(s, ...v)).rows) as never
  );
  dbMock.dbWrite.$executeRaw.mockImplementation(
    (async (s: TemplateStringsArray, ...v: unknown[]) =>
      (await runRaw(s, ...v)).affectedRows ?? 0) as never
  );
});

const caller = () =>
  comicsRouter.createCaller({
    user: {
      id: 1,
      isModerator: true,
      onboarding: OnboardingSteps.Buzz,
      muted: false,
      showNsfw: true,
    },
    domain: 'red',
    acceptableOrigin: true,
    needsUpdate: false,
    tokenScope: TokenScope.Full,
    features: { comicCreator: true },
    req: undefined,
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    track: {},
    ip: '127.0.0.1',
    fingerprint: 'test',
  } as never);

const levels = async () =>
  Object.fromEntries(
    (
      await db.query<{ id: number; nsfwLevel: number }>(
        `SELECT id, "nsfwLevel" FROM "Image" ORDER BY id`
      )
    ).rows.map((r) => [r.id, r.nsfwLevel])
  );

describe("policy: a comic level stamp doesn't move a blocked panel image's level; stamping 32 is allowed", () => {
  it('a project stamp skips each marked image and reports the count', async () => {
    expect(await caller().setProjectNsfwLevel({ id: PROJECT, nsfwLevel: 4 })).toEqual({
      success: true,
      skipped: 3,
    });

    expect(await levels()).toEqual({ 1: 4, 2: 1, 3: 32, 4: 1, 5: 4, 6: 1 });
  });

  it('a chapter stamp skips each marked image in that chapter only', async () => {
    expect(
      await caller().setChapterNsfwLevel({ projectId: PROJECT, chapterPosition: 0, nsfwLevel: 4 })
    ).toEqual({ success: true, skipped: 3 });

    expect(await levels()).toEqual({ 1: 4, 2: 1, 3: 32, 4: 1, 5: 1, 6: 1 });
  });

  it('control: stamping Blocked writes every image and skips none', async () => {
    expect(await caller().setProjectNsfwLevel({ id: PROJECT, nsfwLevel: 32 })).toEqual({
      success: true,
      skipped: 0,
    });

    expect(await levels()).toEqual({ 1: 32, 2: 32, 3: 32, 4: 32, 5: 32, 6: 1 });
  });
});
