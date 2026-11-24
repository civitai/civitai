import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';

// A thumbs-up from any review surface puts the model in the reviewer's Liked Models collection,
// against real Postgres (PGlite) for the review, collection and collection-item rows. The add
// keeps toggleBookmarked's visibility gate (assertCollectionItemsVisibleToViewer). Rules: #10268.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { createResourceReview, deleteResourceReview, updateResourceReview, upsertResourceReview } =
  await import('~/server/services/resourceReview.service');
const { getUserBookmarkedModels, toggleBookmarked } = await import(
  '~/server/services/user.service'
);

const OWNER = 7;
const LIKER = 42;
const MODEL = 10;
const VERSION = 20;
const OTHER_VERSION = 21;
const OTHER_MODEL = 11;
const OTHER_MODEL_VERSION = 30;
const PRIVATE_MODEL = 12;
const MODERATOR = 99;

let harness: Awaited<ReturnType<typeof startPglitePrisma>>;

beforeAll(async () => {
  harness = await startPglitePrisma(`
    CREATE TYPE "UserEngagementType" AS ENUM ('Follow', 'Hide', 'Block');
    CREATE TABLE "User" (id int PRIMARY KEY, username text);
    CREATE TABLE "UserEngagement" ("userId" int, "targetUserId" int, type "UserEngagementType");
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int, "needsReview" text, "blockedFor" text);
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
      images jsonb NOT NULL DEFAULT '[]', details jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE "HeldResourceReview" (
      id int PRIMARY KEY, "modelId" int, "modelVersionId" int, "userId" int, rating int,
      recommended boolean, details text, exclude boolean, nsfw boolean, "tosViolation" boolean,
      metadata jsonb, "createdAt" timestamp(3), "updatedAt" timestamp(3), "holdReasons" text[]
    );
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
    INSERT INTO "Model" (id, "userId", availability) VALUES
      (${MODEL}, ${OWNER}, 'Public'), (${OTHER_MODEL}, ${OWNER}, 'Public'),
      (${PRIVATE_MODEL}, ${OWNER}, 'Private');
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
    const names = await harness.pg.query<{ name: string }>(
      `SELECT name FROM "Collection" WHERE type = 'Model'`
    );
    expect(names.rows).toEqual([{ name: 'Liked Models' }]);
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

  it('a thumbs-down edit in the post editor removes the model', async () => {
    const { id } = await thumbs(true);
    await upsertResourceReview({
      id,
      modelId: MODEL,
      modelVersionId: VERSION,
      rating: 1,
      recommended: false,
      userId: LIKER,
    });
    expect(await likedModels()).toEqual([]);
  });

  it('keeps the model while another of its versions is still liked', async () => {
    const { id } = await thumbs(true);
    await thumbs(true, OTHER_VERSION);
    await updateResourceReview({ id, recommended: false, rating: 1, userId: LIKER });
    expect(await likedModels()).toEqual([MODEL]);
  });

  it('deleting the only thumbs-up removes the model', async () => {
    const { id } = await thumbs(true);
    await deleteResourceReview({ id });
    expect(await likedModels()).toEqual([]);
  });

  it('moving a liked review to another model moves it in Liked Models too', async () => {
    const { id } = await thumbs(true);
    await upsertResourceReview({
      id,
      modelId: OTHER_MODEL,
      modelVersionId: OTHER_MODEL_VERSION,
      rating: 5,
      recommended: true,
      userId: LIKER,
    });
    expect(await likedModels()).toEqual([OTHER_MODEL]);
  });

  it('a thumbs-up the collection refuses still saves the review', async () => {
    const review = await createResourceReview({
      modelId: PRIVATE_MODEL,
      modelVersionId: VERSION,
      rating: 5,
      recommended: true,
      userId: LIKER,
    });
    expect(review.recommended).toBe(true);
    expect(await likedModels()).toEqual([]);
  });

  it("a moderator's edit adds to the author's collection only what the author could add", async () => {
    const { id } = await createResourceReview({
      modelId: PRIVATE_MODEL,
      modelVersionId: VERSION,
      rating: 1,
      recommended: false,
      userId: LIKER,
    });
    await updateResourceReview({ id, recommended: true, userId: MODERATOR, isModerator: true });
    expect(await likedModels()).toEqual([]);
  });

  describe('a model the user saved to Liked Models themselves', () => {
    const save = () =>
      toggleBookmarked({ type: 'Model', entityId: MODEL, userId: LIKER, setTo: true });

    it('stays when they give it a thumbs-down', async () => {
      await save();
      await thumbs(false);
      expect(await likedModels()).toEqual([MODEL]);
    });

    it('stays when they edit or delete that thumbs-down', async () => {
      await save();
      const { id } = await thumbs(false);
      await updateResourceReview({ id, details: 'Not for me', userId: LIKER });
      await deleteResourceReview({ id });
      expect(await likedModels()).toEqual([MODEL]);
    });
  });

  it("a moderator's post-editor edit adds only what the author could add", async () => {
    const { id } = await createResourceReview({
      modelId: PRIVATE_MODEL,
      modelVersionId: VERSION,
      rating: 1,
      recommended: false,
      userId: LIKER,
    });
    await upsertResourceReview({
      id,
      modelId: PRIVATE_MODEL,
      modelVersionId: VERSION,
      rating: 5,
      recommended: true,
      userId: MODERATOR,
      isModerator: true,
    });
    expect(await likedModels()).toEqual([]);
  });

  it('deleting one of two liked versions keeps the model', async () => {
    const { id } = await thumbs(true);
    await thumbs(true, OTHER_VERSION);
    await deleteResourceReview({ id });
    expect(await likedModels()).toEqual([MODEL]);
  });

  it('editing a liked review does not re-add a model the user took out by hand', async () => {
    const { id } = await thumbs(true);
    await toggleBookmarked({ type: 'Model', entityId: MODEL, userId: LIKER, setTo: false });
    await updateResourceReview({ id, details: 'Still great', userId: LIKER });
    expect(await likedModels()).toEqual([]);
  });
});
