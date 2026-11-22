import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { TokenScope } from '~/shared/constants/token-scope.constants';

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
const { createCallerFactory } = await import('~/server/trpc');
const { challengeRouter } = await import('~/server/routers/challenge.router');
const { toggleReactionHandler } = await import('~/server/controllers/reaction.controller');

const OWNER = 5;
const STRANGER = 30;
const JUDGE = 40;
const CLEAN = 1;
const ACCEPTABLE_MINOR = 2;
const MINOR_MATURE = 3;
const MODERATOR = 50;

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
      id int PRIMARY KEY, "coverId" int, "bannerId" int, status text, "publishedAt" timestamp, ingestion text, availability "Availability" DEFAULT 'Public'
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
    INSERT INTO "Image" (id, "postId", url, minor, "nsfwLevel") VALUES
      (${MINOR_MATURE}, 1, 'img-minor-mature', true, 4);
    INSERT INTO "CommentV3" ("entityType", "entityId", "userId", content) VALUES
      ('image', ${CLEAN}, ${JUDGE}, 'judge on clean'),
      ('image', ${ACCEPTABLE_MINOR}, ${JUDGE}, 'judge on flagged');
  `);
  const raw = pgliteRaw(db);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(raw.queryRaw);
});

const signedOut = {} as never;
const as = (id: number, isModerator = false) => ({ user: { id, isModerator } } as never);
const notFound = expect.objectContaining({ code: 'NOT_FOUND' });
const threadCheck = (imageId: number, ctx: never) =>
  Promise.resolve(commentSurface('image').assertVisible?.(imageId, ctx));

describe("an image's comment thread", () => {
  it('is readable on a reviewed image, signed in or out (control)', async () => {
    await expect(threadCheck(CLEAN, signedOut)).resolves.toBeUndefined();
    await expect(threadCheck(CLEAN, as(STRANGER))).resolves.toBeUndefined();
  });

  it.each([
    ['acceptable-minor', ACCEPTABLE_MINOR],
    ['minor-flagged and rated past the minor content limit', MINOR_MATURE],
  ])('is not found on an image that is %s, except by its owner and moderators', async (_, id) => {
    await expect(threadCheck(id, signedOut)).rejects.toEqual(notFound);
    await expect(threadCheck(id, as(STRANGER))).rejects.toEqual(notFound);
    await expect(threadCheck(id, as(OWNER))).resolves.toBeUndefined();
    await expect(threadCheck(id, as(MODERATOR, true))).resolves.toBeUndefined();
  });
});

describe("an image's judge comment", () => {
  const judgeComment = (imageId: number, user?: { id: number; isModerator: boolean }) =>
    createCallerFactory(challengeRouter)({
      user: user && { ...user, onboarding: 15, emailVerified: new Date(0), meta: {} },
      acceptableOrigin: true,
      tokenScope: TokenScope.Full,
      features: { trpcFlagGuardPerRequest: true, challengePlatform: true },
      track: {},
      ip: '127.0.0.1',
      cache: {},
      req: { headers: {} },
      res: undefined,
    } as never).getJudgeComment({ imageId, judgeUserId: JUDGE });

  it('is served on a reviewed image (control)', async () => {
    expect(await judgeComment(CLEAN)).toBe('judge on clean');
  });

  it('reads as none on an acceptable-minor image, except to its owner and moderators', async () => {
    expect(await judgeComment(ACCEPTABLE_MINOR)).toBeNull();
    expect(await judgeComment(ACCEPTABLE_MINOR, { id: STRANGER, isModerator: false })).toBeNull();
    expect(await judgeComment(ACCEPTABLE_MINOR, { id: OWNER, isModerator: false })).toBe(
      'judge on flagged'
    );
    expect(await judgeComment(ACCEPTABLE_MINOR, { id: MODERATOR, isModerator: true })).toBe(
      'judge on flagged'
    );
  });
});

describe('a reaction to an image', () => {
  const react = (entityId: number, ctx = as(STRANGER)) =>
    toggleReactionHandler({
      ctx,
      input: { entityType: 'image', entityId, reaction: 'Like' },
    }).catch((error: unknown) => error);

  // The step after the image check is the contest lookup, which reads a table this fixture lacks:
  // failing on that table is how a case shows it got past the check.
  const pastTheCheck = expect.objectContaining({
    message: expect.stringContaining('"CollectionItem" does not exist'),
  });
  it('gets past the image check on a reviewed image (control)', async () => {
    dbMock.dbWrite.imageReaction.count.mockResolvedValue(0);
    expect(await react(CLEAN)).toEqual(pastTheCheck);
  });

  it.each([
    ['acceptable-minor', ACCEPTABLE_MINOR],
    ['minor-flagged and rated past the minor content limit', MINOR_MATURE],
  ])('is refused as not found on an image that is %s', async (_, id) => {
    dbMock.dbWrite.imageReaction.count.mockResolvedValue(0);
    expect(await react(id)).toEqual(notFound);
  });

  it('gets past the image check for its owner and for moderators', async () => {
    dbMock.dbWrite.imageReaction.count.mockResolvedValue(0);
    expect(await react(ACCEPTABLE_MINOR, as(OWNER))).toEqual(pastTheCheck);
    expect(await react(ACCEPTABLE_MINOR, as(MODERATOR, true))).toEqual(pastTheCheck);
  });

  it('can still be removed by a user who holds it', async () => {
    dbMock.dbWrite.imageReaction.count.mockResolvedValue(1);
    expect(await react(ACCEPTABLE_MINOR)).toEqual(pastTheCheck);
  });
});
