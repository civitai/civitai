import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';

// A thumbs-up from any review surface puts the model in the reviewer's Liked Models collection,
// against real Postgres (PGlite) for the review, collection and collection-item rows.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { createResourceReview, updateResourceReview, upsertResourceReview } = await import(
  '~/server/services/resourceReview.service'
);
const { getUserBookmarkedModels } = await import('~/server/services/user.service');

const OWNER = 7;
const LIKER = 42;
const MODEL = 10;
const VERSION = 20;
const OTHER_VERSION = 21;

let harness: Awaited<ReturnType<typeof startPglitePrisma>>;

beforeAll(async () => {
  harness = await startPglitePrisma(`
    CREATE TYPE "UserEngagementType" AS ENUM ('Follow', 'Hide', 'Block');
    CREATE TABLE "User" (id int PRIMARY KEY, username text);
    CREATE TABLE "UserEngagement" ("userId" int, "targetUserId" int, type "UserEngagementType");
    CREATE TYPE "CollectionType" AS ENUM ('Model', 'Article', 'Post', 'Image', 'Model3D');
    CREATE TYPE "CollectionMode" AS ENUM ('Contest', 'Bookmark');
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int NOT NULL, status text DEFAULT 'Published', "deletedAt" timestamp,
      availability text DEFAULT 'Public', mode text
    );
    CREATE TABLE "ResourceReview" (
      id serial PRIMARY KEY, "modelId" int NOT NULL, "modelVersionId" int NOT NULL, "userId" int NOT NULL,
      rating int NOT NULL, recommended boolean NOT NULL DEFAULT true, details text,
      "createdAt" timestamp(3) NOT NULL DEFAULT now(), "updatedAt" timestamp(3) NOT NULL DEFAULT now(),
      exclude boolean NOT NULL DEFAULT false, nsfw boolean NOT NULL DEFAULT false, "postId" int,
      "tosViolation" boolean NOT NULL DEFAULT false, metadata jsonb, "releasedAt" timestamp(3),
      UNIQUE ("modelVersionId", "userId")
    );
    CREATE TYPE "CollectionWriteConfiguration" AS ENUM ('Private', 'Public', 'Review');
    CREATE TYPE "CollectionReadConfiguration" AS ENUM ('Private', 'Public', 'Unlisted');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Private', 'Unsearchable');
    CREATE TYPE "CollectionItemStatus" AS ENUM ('ACCEPTED', 'REVIEW', 'REJECTED');
    CREATE TABLE "Collection" (
      id serial PRIMARY KEY, "userId" int NOT NULL, name text NOT NULL, description text,
      type "CollectionType", mode "CollectionMode", "createdAt" timestamp(3) DEFAULT now(),
      "updatedAt" timestamp(3), nsfw boolean DEFAULT false, "imageId" int,
      write "CollectionWriteConfiguration" NOT NULL DEFAULT 'Private',
      read "CollectionReadConfiguration" NOT NULL DEFAULT 'Private',
      metadata jsonb NOT NULL DEFAULT '{}', availability "Availability" NOT NULL DEFAULT 'Public',
      "nsfwLevel" int NOT NULL DEFAULT 0
    );
    CREATE TABLE "CollectionItem" (
      id serial PRIMARY KEY, "collectionId" int NOT NULL, "modelId" int, "addedById" int,
      "createdAt" timestamp(3) DEFAULT now(), "updatedAt" timestamp(3),
      status "CollectionItemStatus" NOT NULL DEFAULT 'ACCEPTED'
    );
    CREATE UNIQUE INDEX "CollectionItem_model" ON "CollectionItem" ("collectionId", "modelId")
      WHERE "modelId" IS NOT NULL;
  `);
  const { prisma } = harness;
  // The services' own where and data against real tables; a returned row is narrowed to the
  // columns this schema has, which is all the callers read.
  const route = (client: 'dbRead' | 'dbWrite', table: string, method: string, select?: object) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delegate = (prisma as any)[table];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dbMock[client] as any)[table][method].mockImplementation((args: object) =>
      delegate[method](select ? { ...args, select } : args)
    );
  };
  const review = {
    id: true,
    modelId: true,
    modelVersionId: true,
    userId: true,
    recommended: true,
    details: true,
    rating: true,
    nsfw: true,
    postId: true,
    createdAt: true,
    exclude: true,
  };
  route('dbWrite', 'resourceReview', 'create', review);
  route('dbWrite', 'resourceReview', 'update', review);
  route('dbWrite', 'resourceReview', 'findUnique');
  route('dbWrite', 'resourceReview', 'findFirst');
  route('dbWrite', 'collection', 'findFirst', { id: true, type: true });
  route('dbWrite', 'collection', 'create', { id: true, type: true });
  route('dbRead', 'collection', 'findMany', { id: true, type: true });
  route('dbWrite', 'collectionItem', 'findFirst', { id: true });
  route('dbWrite', 'collectionItem', 'createMany');
  route('dbWrite', 'collectionItem', 'deleteMany');
  route('dbRead', 'collectionItem', 'findMany');
  for (const client of ['dbRead', 'dbWrite'] as const)
    dbMock[client].$queryRaw.mockImplementation(((...args: Parameters<typeof prisma.$queryRaw>) =>
      prisma.$queryRaw(...args)) as never);
});
afterAll(() => harness.stop());

beforeEach(async () => {
  await harness.pg.exec(`
    DELETE FROM "CollectionItem"; DELETE FROM "Collection"; DELETE FROM "ResourceReview";
    DELETE FROM "Model";
    INSERT INTO "Model" (id, "userId") VALUES (${MODEL}, ${OWNER});
  `);
});

const likedModels = () => getUserBookmarkedModels({ userId: LIKER });
const thumbs = (recommended: boolean, modelVersionId = VERSION) =>
  createResourceReview({
    modelId: MODEL,
    modelVersionId,
    rating: recommended ? 5 : 1,
    recommended,
    userId: LIKER,
  });

describe('Liked Models from a review thumbs-up', () => {
  it('a thumbs-up on the version card adds the model', async () => {
    await thumbs(true);
    expect(await likedModels()).toEqual([MODEL]);
  });

  it('a thumbs-down adds nothing', async () => {
    await thumbs(false);
    expect(await likedModels()).toEqual([]);
  });

  it('a thumbs-up from the post editor adds the model', async () => {
    await upsertResourceReview({
      modelId: MODEL,
      modelVersionId: VERSION,
      rating: 5,
      recommended: true,
      userId: LIKER,
    });
    expect(await likedModels()).toEqual([MODEL]);
  });

  it('turning a thumbs-down into a thumbs-up adds the model', async () => {
    const { id } = await thumbs(false);
    await updateResourceReview({ id, recommended: true, rating: 5, userId: LIKER });
    expect(await likedModels()).toEqual([MODEL]);
  });

  it('turning the only thumbs-up into a thumbs-down removes the model', async () => {
    const { id } = await thumbs(true);
    await updateResourceReview({ id, recommended: false, rating: 1, userId: LIKER });
    expect(await likedModels()).toEqual([]);
  });

  it('keeps the model while another of its versions is still liked', async () => {
    const { id } = await thumbs(true);
    await thumbs(true, OTHER_VERSION);
    await updateResourceReview({ id, recommended: false, rating: 1, userId: LIKER });
    expect(await likedModels()).toEqual([MODEL]);
  });

  it('a second thumbs-up on another version leaves one entry', async () => {
    await thumbs(true);
    await thumbs(true, OTHER_VERSION);
    expect(await likedModels()).toEqual([MODEL]);
  });
});
