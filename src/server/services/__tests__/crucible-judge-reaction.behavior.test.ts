import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * A judge reacts to a crucible's entries while it is judged, and an entry entered from a draft post
 * stays unpublished until the crucible ends. Image, post and entry rows live in an in-process
 * Postgres; the image rule's Kysely read gets the same answers as `$queryRaw`.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/db/kyselyDb.lazy', async () => {
  const { fakeKyselyDbLazy, answerLike } = await import('~/test-utils/kysely-raw-fake');
  const { dbMock } = await import('~/__tests__/mocks/db.mock');
  return fakeKyselyDbLazy(
    answerLike(dbMock.dbRead.$queryRaw),
    answerLike(dbMock.dbWrite.$queryRaw)
  );
});

const { toggleReactionHandler } = await import('~/server/controllers/reaction.controller');

const ENTRANT = 5;
const CREATOR = 6;
const JUDGE = 40;
const LOW_SCORE = 41;
const MISSING_IMAGE = 999;

// Crucibles
const ACTIVE = 1;
const ENDED = 2; // still Active: status lags endAt until the finalize job runs
const COMPLETED = 3;
const TAKEN_DOWN = 4;

// Images, each on its own post
const PUBLISHED_ENTRY = 10;
const SCHEDULED_ENTRY = 11; // post publishes at the active crucible's end
const SCHEDULED_NOT_ENTERED = 12;
const SCHEDULED_ENDED_ENTRY = 13;
const SCHEDULED_COMPLETED_ENTRY = 14;
const SCHEDULED_TAKEN_DOWN_ENTRY = 15;
const SCHEDULED_ACCEPTABLE_MINOR_ENTRY = 16;
const SCHEDULED_PRIVATE_ENTRY = 17;

beforeAll(async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
    CREATE TYPE "CrucibleStatus" AS ENUM ('Pending', 'Active', 'Completed', 'Cancelled');
    CREATE TABLE "ServiceDealReviewImage" ("reviewId" int NOT NULL, "imageId" int NOT NULL);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL DEFAULT ${ENTRANT}, "postId" int, url text NOT NULL DEFAULT 'img',
      type text NOT NULL DEFAULT 'image', "nsfwLevel" int NOT NULL DEFAULT 1,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned', "needsReview" text,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false, metadata jsonb, "blockedFor" text,
      minor boolean NOT NULL DEFAULT false, "modelRestricted" boolean NOT NULL DEFAULT false,
      "acceptableMinor" boolean NOT NULL DEFAULT false, "tosViolation" boolean NOT NULL DEFAULT false,
      "scanJobs" jsonb
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL DEFAULT ${ENTRANT}, "publishedAt" timestamp,
      "collectionId" int, availability "Availability" NOT NULL DEFAULT 'Public'
    );
    CREATE TABLE "CollectionContributor" (
      "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
    );
    CREATE TABLE "Article" (
      id int PRIMARY KEY, "coverId" int, "bannerId" int, status text, "publishedAt" timestamp, ingestion text, availability "Availability" DEFAULT 'Public', "userId" int
    );
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
    CREATE TABLE "Bounty" (id int PRIMARY KEY, "userId" int, availability "Availability");
    CREATE TABLE "BountyEntry" (id int PRIMARY KEY, "bountyId" int);
    CREATE TABLE "Crucible" (
      id int PRIMARY KEY, "userId" int NOT NULL DEFAULT ${CREATOR}, status "CrucibleStatus" NOT NULL,
      "endAt" timestamp, "nsfwLevel" int NOT NULL DEFAULT 1, "takenDownAt" timestamp
    );
    CREATE TABLE "CrucibleEntry" (
      id serial PRIMARY KEY, "crucibleId" int NOT NULL, "userId" int NOT NULL, "imageId" int
    );
    INSERT INTO "Crucible" (id, status, "endAt", "takenDownAt") VALUES
      (${ACTIVE}, 'Active', now() + interval '1 day', NULL),
      (${ENDED}, 'Active', now() - interval '1 hour', NULL),
      (${COMPLETED}, 'Completed', now() + interval '1 day', NULL),
      (${TAKEN_DOWN}, 'Active', now() + interval '1 day', now() - interval '1 hour');
    INSERT INTO "Post" (id, "publishedAt") VALUES
      (${PUBLISHED_ENTRY}, now() - interval '1 day'),
      (${SCHEDULED_ENTRY}, now() + interval '1 day'),
      (${SCHEDULED_NOT_ENTERED}, now() + interval '1 day'),
      (${SCHEDULED_ENDED_ENTRY}, now() + interval '1 day'),
      (${SCHEDULED_COMPLETED_ENTRY}, now() + interval '1 day'),
      (${SCHEDULED_TAKEN_DOWN_ENTRY}, now() + interval '1 day'),
      (${SCHEDULED_ACCEPTABLE_MINOR_ENTRY}, now() + interval '1 day');
    INSERT INTO "Post" (id, "publishedAt", availability) VALUES
      (${SCHEDULED_PRIVATE_ENTRY}, now() + interval '1 day', 'Private');
    INSERT INTO "Image" (id, "postId", "acceptableMinor") VALUES
      (${PUBLISHED_ENTRY}, ${PUBLISHED_ENTRY}, false),
      (${SCHEDULED_ENTRY}, ${SCHEDULED_ENTRY}, false),
      (${SCHEDULED_NOT_ENTERED}, ${SCHEDULED_NOT_ENTERED}, false),
      (${SCHEDULED_ENDED_ENTRY}, ${SCHEDULED_ENDED_ENTRY}, false),
      (${SCHEDULED_COMPLETED_ENTRY}, ${SCHEDULED_COMPLETED_ENTRY}, false),
      (${SCHEDULED_TAKEN_DOWN_ENTRY}, ${SCHEDULED_TAKEN_DOWN_ENTRY}, false),
      (${SCHEDULED_ACCEPTABLE_MINOR_ENTRY}, ${SCHEDULED_ACCEPTABLE_MINOR_ENTRY}, true),
      (${SCHEDULED_PRIVATE_ENTRY}, ${SCHEDULED_PRIVATE_ENTRY}, false);
    INSERT INTO "CrucibleEntry" ("crucibleId", "userId", "imageId") VALUES
      (${ACTIVE}, ${ENTRANT}, ${PUBLISHED_ENTRY}),
      (${ACTIVE}, ${ENTRANT}, ${SCHEDULED_ENTRY}),
      (${ENDED}, ${ENTRANT}, ${SCHEDULED_ENDED_ENTRY}),
      (${COMPLETED}, ${ENTRANT}, ${SCHEDULED_COMPLETED_ENTRY}),
      (${TAKEN_DOWN}, ${ENTRANT}, ${SCHEDULED_TAKEN_DOWN_ENTRY}),
      (${ACTIVE}, ${ENTRANT}, ${SCHEDULED_ACCEPTABLE_MINOR_ENTRY}),
      (${ACTIVE}, ${ENTRANT}, ${SCHEDULED_PRIVATE_ENTRY});
  `);
  const raw = pgliteRaw(db);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(raw.queryRaw);
});

const scannedCover = { ingestion: 'Scanned', nsfwLevel: 1, needsReview: null, tosViolation: false };
const crucibleRows: Record<number, { userId: number; takenDownAt: Date | null }> = {
  [ACTIVE]: { userId: CREATOR, takenDownAt: null },
  [ENDED]: { userId: CREATOR, takenDownAt: null },
  [COMPLETED]: { userId: CREATOR, takenDownAt: null },
  [TAKEN_DOWN]: { userId: CREATOR, takenDownAt: new Date(0) },
};

beforeEach(() => {
  dbMock.dbWrite.imageReaction.count.mockResolvedValue(0);
  // The judge score gate reads the user's creator score.
  (dbMock.dbRead.user.findUnique as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    ({ where }: { where: { id: number } }) =>
      Promise.resolve({ meta: { scores: { total: where.id === LOW_SCORE ? 10 : 10_000 } } })
  );
  // The crucible page's own visibility rule.
  (dbMock.dbRead.crucible.findUnique as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    ({ where }: { where: { id: number } }) => {
      const row = crucibleRows[where.id];
      return Promise.resolve(
        row && {
          ...row,
          nsfwLevel: 1,
          textNsfw: false,
          ingestion: 'Scanned',
          image: scannedCover,
        }
      );
    }
  );
});

const as = (id: number) =>
  ({ user: { id, isModerator: false }, features: { isGreen: false } } as never);
const react = (entityId: number, userId = JUDGE) =>
  toggleReactionHandler({
    ctx: as(userId),
    input: { entityType: 'image', entityId, reaction: 'Like' },
  }).catch((error: unknown) => error);

// The step after the image check is the contest lookup, which reads a table this fixture lacks:
// failing on that table is how a case shows it got past the check.
const pastTheCheck = expect.objectContaining({
  message: expect.stringContaining('"CollectionItem" does not exist'),
});

/** The answer an id that names no image gets, so a refusal tells a prober nothing more. */
const asMissing = async () => {
  const missing = (await react(MISSING_IMAGE)) as { code: string; message: string };
  expect(missing).toEqual(expect.objectContaining({ code: 'NOT_FOUND' }));
  return expect.objectContaining({ code: missing.code, message: missing.message });
};

describe('a reaction to a crucible entry while it is judged', () => {
  it('gets past the image check on an entry whose post is published (control)', async () => {
    expect(await react(PUBLISHED_ENTRY)).toEqual(pastTheCheck);
  });

  it('gets past the image check for a judge on an entry whose post publishes at the crucible end', async () => {
    expect(await react(SCHEDULED_ENTRY)).toEqual(pastTheCheck);
  });

  it('is refused as a missing image to a user below the judge score', async () => {
    expect(await react(SCHEDULED_ENTRY, LOW_SCORE)).toEqual(await asMissing());
  });

  it('is refused as a missing image on an unpublished image that is no active crucible entry', async () => {
    expect(await react(SCHEDULED_NOT_ENTERED)).toEqual(await asMissing());
  });

  it.each([
    ['a crucible past its end, before it is finalized', SCHEDULED_ENDED_ENTRY],
    ['a completed crucible', SCHEDULED_COMPLETED_ENTRY],
    ['a taken-down crucible', SCHEDULED_TAKEN_DOWN_ENTRY],
  ])('is refused as a missing image on an unpublished entry of %s', async (_, id) => {
    expect(await react(id)).toEqual(await asMissing());
  });

  it.each([
    ['acceptable-minor', SCHEDULED_ACCEPTABLE_MINOR_ENTRY],
    ['on a private post', SCHEDULED_PRIVATE_ENTRY],
  ])('keeps every other image rule: refused on an unpublished entry that is %s', async (_, id) => {
    expect(await react(id)).toEqual(await asMissing());
  });
});
