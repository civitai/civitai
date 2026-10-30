import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  dbWrite: {},
}));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({}) }));
vi.mock('../buzz', () => ({ getBuzz: vi.fn() }));
vi.mock('../notifications', () => ({ getNotifications: vi.fn() }));
vi.mock('../moderator-db', () => ({ getModeratorDb: vi.fn() }));

const { getHoldContexts } = await import('../../../routes/csam/text-holds/hold-context.server');

let db: PGlite;

const hold = (
  id: number,
  entityType: string,
  entityId: number,
  commentModelId: number | null = null
) => ({ id, entityType, entityId, commentModelId });

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(`
    CREATE TABLE "Image" ("id" INTEGER PRIMARY KEY, "url" TEXT NOT NULL, "type" TEXT NOT NULL DEFAULT 'image',
      "postId" INTEGER, "index" INTEGER, "nsfwLevel" INTEGER NOT NULL DEFAULT 1,
      "minor" BOOLEAN NOT NULL DEFAULT false, "acceptableMinor" BOOLEAN NOT NULL DEFAULT false);
    CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT, "profilePictureId" INTEGER);
    CREATE TABLE "UserProfile" ("userId" INTEGER PRIMARY KEY, "bio" TEXT, "message" TEXT, "sfwBio" TEXT,
      "sfwMessage" TEXT, "location" TEXT, "coverImageId" INTEGER, "sfwCoverImageId" INTEGER);
    CREATE TABLE "Post" ("id" INTEGER PRIMARY KEY, "title" TEXT, "publishedAt" TIMESTAMP,
      "userId" INTEGER, "modelVersionId" INTEGER);
    CREATE TABLE "Model" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'Published',
      "userId" INTEGER);
    CREATE TABLE "ModelVersion" ("id" INTEGER PRIMARY KEY, "modelId" INTEGER NOT NULL, "index" INTEGER);
    CREATE TABLE "Article" ("id" INTEGER PRIMARY KEY, "title" TEXT NOT NULL, "coverId" INTEGER);
    CREATE TABLE "CommentV3" ("id" INTEGER PRIMARY KEY, "entityType" TEXT NOT NULL,
      "entityId" INTEGER NOT NULL, "parentId" INTEGER);

    INSERT INTO "Image" ("id","url","type","nsfwLevel","minor") VALUES
      (1, 'avatar-key', 'image', 1, false), (2, 'cover-key', 'image', 4, false),
      (3, 'sfw-cover-key', 'image', 1, false), (4, 'img-parent', 'image', 2, true),
      (5, 'art-cover', 'image', 1, false);
    INSERT INTO "Image" ("id","url","type","postId","index") VALUES
      (6, 'post-clip', 'video', 90, 0), (7, 'post-still', 'image', 90, 1);
    INSERT INTO "User" VALUES (10, 'someone', 1), (11, 'plain', NULL);
    INSERT INTO "UserProfile" VALUES (10, 'a bio', 'a message', 'sfw bio', NULL, 'somewhere', 2, 3),
      (12, NULL, 'only a message', NULL, NULL, NULL, 2, 2);
    INSERT INTO "User" VALUES (12, 'covered', NULL);
    INSERT INTO "Post" VALUES (90, 'A post title', '2026-10-01', 10, NULL);
    INSERT INTO "Model" VALUES (70, 'A model name', 'Published', 10);
    INSERT INTO "Article" VALUES (50, 'An article title', 5);
    -- comments on a post, an image, a model, an article and a bounty; 105 is a reply under 100,
    -- carrying the post on its own row. 106 has no row: the comment is gone.
    INSERT INTO "CommentV3" VALUES (100, 'post', 90, NULL), (101, 'image', 4, NULL),
      (102, 'model', 70, NULL), (103, 'article', 50, NULL), (104, 'bounty', 33, NULL),
      (105, 'post', 90, 100);
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

describe('getHoldContexts: profiles', () => {
  it('gives a profile hold its avatar, covers and text, naming each image', async () => {
    const contexts = await getHoldContexts([hold(1, 'UserProfile', 10)]);
    const profile = contexts.get(1)?.profile;
    expect(profile).toMatchObject({
      bio: 'a bio',
      message: 'a message',
      sfwBio: 'sfw bio',
      sfwMessage: null,
      location: 'somewhere',
    });
    expect(profile?.images.map((i) => [i.caption, i.url, i.nsfwLevel])).toEqual([
      ['Avatar', 'avatar-key', 1],
      ['Cover', 'cover-key', 4],
      ['Cover (SFW)', 'sfw-cover-key', 1],
    ]);
  });

  it('carries the image scan minor flags onto the avatar and cover tiles', async () => {
    await db.exec(`UPDATE "Image" SET "minor" = true WHERE id = 2;
      UPDATE "Image" SET "acceptableMinor" = true WHERE id = 1;`);
    const profile = (await getHoldContexts([hold(1, 'UserProfile', 10)])).get(1)?.profile;
    expect(profile?.images.map((i) => [i.caption, i.minor, i.acceptableMinor])).toEqual([
      ['Avatar', false, true],
      ['Cover', true, false],
      ['Cover (SFW)', false, false],
    ]);
  });

  it('shows one tile when the SFW cover is the cover', async () => {
    const profile = (await getHoldContexts([hold(1, 'UserProfile', 12)])).get(1)?.profile;
    expect(profile?.images.map((i) => i.caption)).toEqual(['Cover']);
  });

  it('keeps an account with only an avatar, and drops one with nothing', async () => {
    await db.exec(`UPDATE "User" SET "profilePictureId" = 1 WHERE id = 11`);
    const contexts = await getHoldContexts([
      hold(1, 'UserProfile', 11),
      hold(2, 'UserProfile', 999),
    ]);
    expect(contexts.get(1)?.profile?.images.map((i) => i.caption)).toEqual(['Avatar']);
    expect(contexts.get(2)).toEqual({ profile: null, parent: null });
  });
});

describe('getHoldContexts: comment parents', () => {
  const parentOf = async (entityType: string, entityId: number, modelId: number | null = null) =>
    (await getHoldContexts([hold(1, entityType, entityId, modelId)])).get(1)?.parent;

  it('resolves a legacy comment to its model, with the title and media', async () => {
    const parent = await parentOf('Comment', 5, 70);
    expect(parent).toMatchObject({ type: 'model', id: 70, title: 'A model name' });
    expect(parent?.images).toEqual([]);
  });

  it('resolves a CommentV2 on a post to its title, videos and stills included', async () => {
    const parent = await parentOf('CommentV2', 100);
    expect(parent).toMatchObject({ type: 'post', id: 90, title: 'A post title', imageTotal: 2 });
    expect(parent?.images.map((i) => [i.url, i.type])).toEqual([
      ['post-clip', 'video'],
      ['post-still', 'image'],
    ]);
  });

  it('resolves a CommentV2 on an image to that image, with its minor flag', async () => {
    const parent = await parentOf('CommentV2', 101);
    expect(parent).toMatchObject({ type: 'image', id: 4, title: null, imageTotal: 1 });
    expect(parent?.images[0]).toMatchObject({ url: 'img-parent', minor: true });
  });

  it('resolves a CommentV2 on a model and on an article with its cover', async () => {
    expect(await parentOf('CommentV2', 102)).toMatchObject({
      type: 'model',
      id: 70,
      title: 'A model name',
    });
    const article = await parentOf('CommentV2', 103);
    expect(article).toMatchObject({ type: 'article', id: 50, title: 'An article title' });
    expect(article?.images.map((i) => i.url)).toEqual(['art-cover']);
  });

  it('keeps a type with no page we read as a bare reference', async () => {
    expect(await parentOf('CommentV2', 104)).toEqual({
      type: 'bounty',
      id: 33,
      title: null,
      images: [],
      imageTotal: 0,
    });
  });

  it('resolves a reply to the entity it is under', async () => {
    expect(await parentOf('CommentV2', 105)).toMatchObject({ type: 'post', id: 90 });
  });

  it('has no parent for a comment that is gone or a legacy comment without a model', async () => {
    expect(await parentOf('CommentV2', 106)).toBeNull();
    expect(await parentOf('Comment', 5, null)).toBeNull();
  });

  it('answers a mixed page in one pass', async () => {
    const contexts = await getHoldContexts([
      hold(1, 'CommentV2', 100),
      hold(2, 'CommentV2', 101),
      hold(3, 'UserProfile', 10),
      hold(4, 'Post', 90),
    ]);
    expect([...contexts.keys()].sort()).toEqual([1, 2, 3]);
  });
});
