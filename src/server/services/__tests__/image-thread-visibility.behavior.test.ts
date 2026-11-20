import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * An image's comment thread, its challenge judge's comment and its reactions are open to a viewer
 * only when the shared single-image rule shows them the image. Image rows live in an in-process
 * Postgres; the rule's Kysely read gets the same answers as `$queryRaw`.
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

const { commentSurface } = await import('~/server/services/commentv3/surfaces');
const { getJudgeCommentForImage } = await import(
  '~/server/services/challenge-judge-review.service'
);
const { toggleReactionHandler } = await import('~/server/controllers/reaction.controller');

const OWNER = 5;
const STRANGER = 30;
const JUDGE = 40;
const CLEAN = 1;
const ACCEPTABLE_MINOR = 2;

beforeAll(async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL DEFAULT ${OWNER}, "postId" int, url text NOT NULL,
      type text NOT NULL DEFAULT 'image', "nsfwLevel" int NOT NULL DEFAULT 1,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned', "needsReview" text,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false, metadata jsonb, "blockedFor" text,
      minor boolean NOT NULL DEFAULT false, "modelRestricted" boolean NOT NULL DEFAULT false,
      "acceptableMinor" boolean NOT NULL DEFAULT false, "tosViolation" boolean NOT NULL DEFAULT false,
      "scanJobs" jsonb
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL DEFAULT ${OWNER}, "publishedAt" timestamp,
      "collectionId" int, availability "Availability" NOT NULL DEFAULT 'Public'
    );
    CREATE TABLE "CollectionContributor" (
      "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
    );
    CREATE TABLE "Article" (
      id int PRIMARY KEY, "coverId" int, "bannerId" int, status text, "publishedAt" timestamp, ingestion text
    );
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
    CREATE TABLE "Bounty" (id int PRIMARY KEY, "userId" int, availability "Availability");
    CREATE TABLE "BountyEntry" (id int PRIMARY KEY, "bountyId" int);
    CREATE TABLE "CommentV3" (
      id serial PRIMARY KEY, "entityType" text, "entityId" int, "parentId" int, "userId" int,
      content text, "deletedAt" timestamp, "createdAt" timestamp NOT NULL DEFAULT now()
    );
    INSERT INTO "Post" (id, "publishedAt") VALUES (1, now() - interval '1 day');
    INSERT INTO "Image" (id, "postId", url, "acceptableMinor") VALUES
      (${CLEAN}, 1, 'img-clean', false),
      (${ACCEPTABLE_MINOR}, 1, 'img-acceptable-minor', true);
    INSERT INTO "CommentV3" ("entityType", "entityId", "userId", content) VALUES
      ('image', ${CLEAN}, ${JUDGE}, 'judge on clean'),
      ('image', ${ACCEPTABLE_MINOR}, ${JUDGE}, 'judge on flagged');
  `);
  const raw = pgliteRaw(db);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(raw.queryRaw);
});

const signedOut = {} as never;
const as = (id: number) => ({ user: { id, isModerator: false } } as never);
const notFound = expect.objectContaining({ code: 'NOT_FOUND' });
const threadCheck = (imageId: number, ctx: never) =>
  Promise.resolve(commentSurface('image').assertVisible?.(imageId, ctx));

describe("an image's comment thread", () => {
  it('is readable on a reviewed image, signed in or out (control)', async () => {
    await expect(threadCheck(CLEAN, signedOut)).resolves.toBeUndefined();
    await expect(threadCheck(CLEAN, as(STRANGER))).resolves.toBeUndefined();
  });

  it('is not found on an acceptable-minor image, except by its owner', async () => {
    await expect(threadCheck(ACCEPTABLE_MINOR, signedOut)).rejects.toEqual(notFound);
    await expect(threadCheck(ACCEPTABLE_MINOR, as(STRANGER))).rejects.toEqual(notFound);
    await expect(threadCheck(ACCEPTABLE_MINOR, as(OWNER))).resolves.toBeUndefined();
  });
});

describe("an image's judge comment", () => {
  it('is served on a reviewed image (control)', async () => {
    await expect(getJudgeCommentForImage({ imageId: CLEAN, judgeUserId: JUDGE })).resolves.toBe(
      'judge on clean'
    );
  });

  it('is not found on an acceptable-minor image', async () => {
    await expect(
      getJudgeCommentForImage({ imageId: ACCEPTABLE_MINOR, judgeUserId: JUDGE })
    ).rejects.toEqual(notFound);
  });
});

describe('a reaction to an image', () => {
  const react = (entityId: number) =>
    toggleReactionHandler({
      ctx: as(STRANGER),
      input: { entityType: 'image', entityId, reaction: 'Like' },
    }).catch((error: unknown) => error);

  it('is refused as not found on an acceptable-minor image, before anything is written', async () => {
    expect(await react(ACCEPTABLE_MINOR)).toEqual(notFound);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('gets past the image check on a reviewed image (control)', async () => {
    // Later steps read tables this fixture lacks, so only the check's own answer is pinned.
    expect(await react(CLEAN)).not.toEqual(notFound);
  });
});
