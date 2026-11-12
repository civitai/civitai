import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { rowChangesBeforeLock } from '~/server/services/__tests__/model-row-lock.fake';

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

const { mockCreateNotification, mockCreatorHidden } = vi.hoisted(() => ({
  mockCreateNotification: vi.fn(),
  mockCreatorHidden: vi.fn(),
}));
vi.mock('~/server/services/creator-gallery-hidden-users.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  bustModelGallerySettings: vi.fn(async () => undefined),
  getCreatorGalleryHiddenUserIds: mockCreatorHidden,
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createNotification: mockCreateNotification,
}));

const { updateGallerySettingsHandler } = await import('../model.controller');
const { modelNotifications } = await import('~/server/notifications/model.notifications');

/**
 * Pinning a post to a version gallery tells its author, once per version and post. The post
 * filter runs against real Postgres.
 */

const MODEL = 1;
const OWNER = 5;
const VERSION = 10;
const VERSION_2 = 11;
const AUTHOR = 7;
const pg = new PGlite();

// A post by `userId` with one image per id, each made with VERSION unless `resources` says otherwise.
async function post(
  id: number,
  userId: number,
  {
    publishedAt = "now() - interval '1 day'",
    images = [id + 1000],
    resources = [VERSION],
    extra = '',
  }: { publishedAt?: string; images?: number[]; resources?: number[]; extra?: string } = {}
) {
  await pg.exec(`INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (${id}, ${userId}, ${publishedAt});
    ${extra}`);
  for (const image of images) {
    await pg.exec(`INSERT INTO "Image" (id, "postId") VALUES (${image}, ${id})`);
    for (const r of resources)
      await pg.exec(`INSERT INTO "ImageResourceNew" VALUES (${image}, ${r})`);
  }
}

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE "Model" (id int PRIMARY KEY, status text NOT NULL);
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL, "publishedAt" timestamp, "modelVersionId" int,
      "tosViolation" boolean NOT NULL DEFAULT false, availability text NOT NULL DEFAULT 'Public'
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "postId" int, "tosViolation" boolean NOT NULL DEFAULT false,
      "needsReview" text
    );
    CREATE TABLE "ImageResourceNew" ("imageId" int, "modelVersionId" int);
    CREATE TABLE "UserEngagement" ("userId" int, "targetUserId" int, type text);
    INSERT INTO "Model" VALUES (${MODEL}, 'Published'), (2, 'Published'), (3, 'Draft');
    INSERT INTO "ModelVersion" VALUES (${VERSION}, ${MODEL}), (${VERSION_2}, ${MODEL}), (20, 2), (30, 3);
    INSERT INTO "UserEngagement" VALUES
      (8, ${OWNER}, 'Block'), (12, ${OWNER}, 'Hide'), (${OWNER}, 13, 'Block');
  `);
  for (let p = 100; p < 120; p++) await post(p, AUTHOR, { resources: [VERSION, VERSION_2] });
  await post(200, OWNER);
  await post(201, AUTHOR, { publishedAt: 'NULL' });
  await post(202, 8);
  await post(203, 9); // hidden by the owner across their galleries
  await post(204, AUTHOR, { publishedAt: "now() + interval '1 day'" });
  await post(205, 12);
  await post(206, 13);
  await post(207, AUTHOR, { images: [1207, 2207] }); // two images, one hidden in a test below
  await post(208, AUTHOR, { images: [] });
  await post(209, AUTHOR, { resources: [20] }); // made with another model's version
  await post(210, AUTHOR, {
    resources: [],
    extra: `UPDATE "Post" SET "modelVersionId" = ${VERSION} WHERE id = 210;`,
  });
  await post(211, AUTHOR, { extra: `UPDATE "Post" SET "tosViolation" = true WHERE id = 211;` });
  await post(212, AUTHOR, { extra: `UPDATE "Post" SET availability = 'Private' WHERE id = 212;` });
  await post(213, AUTHOR, { images: [1213] });
  await pg.exec(`UPDATE "Image" SET "needsReview" = 'minor' WHERE id = 1213`);
  await post(214, AUTHOR);
  await pg.exec(`UPDATE "Image" SET "tosViolation" = true WHERE id = 1214`);
});
afterAll(() => pg.close());

beforeEach(() => {
  vi.clearAllMocks();
  mockCreatorHidden.mockResolvedValue([9]);
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = Prisma.sql(strings, ...values);
    return (await pg.query(sql.text, sql.values)).rows;
  }) as never);
  dbMock.dbWrite.model.update.mockImplementation((async ({ data }: { data: object }) => ({
    id: MODEL,
    userId: OWNER,
    name: 'Neon Dreams',
    ...data,
  })) as never);
});

type Settings = {
  pinnedPosts?: Record<string, number[]>;
  hiddenImages?: Record<string, number[]>;
  hiddenUsers?: number[];
};

function save(
  { before = {}, after }: { before?: Record<string, number[]>; after: Settings },
  actor = { id: OWNER, isModerator: false }
) {
  rowChangesBeforeLock(
    { id: MODEL, userId: OWNER, minor: false, sfwOnly: false, meta: null },
    {
      id: MODEL,
      userId: OWNER,
      minor: false,
      sfwOnly: false,
      meta: null,
      gallerySettings: { pinnedPosts: before },
    }
  );
  return updateGallerySettingsHandler({
    input: {
      id: MODEL,
      gallerySettings: {
        hiddenImages: after.hiddenImages ?? {},
        hiddenUsers: (after.hiddenUsers ?? []).map((id) => ({ id, username: null })),
        hiddenTags: [],
        level: 1,
        pinnedPosts: after.pinnedPosts ?? {},
      },
    },
    ctx: { user: { ...actor, username: 'pixelsmith' } } as never,
  } as never);
}

const sentTo = () =>
  mockCreateNotification.mock.calls.map(([n]) => ({ userId: n.userId, key: n.key }));

describe('updateGallerySettingsHandler — notifies the author of a newly pinned post', () => {
  it('sends the author one notification keyed on version and post', async () => {
    await save({ before: { [VERSION]: [100] }, after: { pinnedPosts: { [VERSION]: [100, 101] } } });

    expect(sentTo()).toEqual([{ userId: AUTHOR, key: `model-gallery-post-pinned:${VERSION}:101` }]);
    const [n] = mockCreateNotification.mock.calls[0];
    expect(modelNotifications['model-gallery-post-pinned'].prepareMessage(n)).toEqual({
      message: 'pixelsmith pinned your post to the Neon Dreams gallery',
      url: `/models/${MODEL}/neon-dreams?modelVersionId=${VERSION}`,
    });
  });

  it('an unpin sends nothing, and the key is stable per version and post', async () => {
    await save({ before: { [VERSION]: [100] }, after: { pinnedPosts: { [VERSION]: [] } } });
    expect(sentTo()).toEqual([]);
    await save({ before: { [VERSION]: [] }, after: { pinnedPosts: { [VERSION]: [100] } } });
    expect(sentTo()).toEqual([{ userId: AUTHOR, key: `model-gallery-post-pinned:${VERSION}:100` }]);
  });

  it.each([
    ['the owner’s own post', {}, 200],
    ['an unpublished post', {}, 201],
    ['a post scheduled for later', {}, 204],
    ['an author who blocked the owner', {}, 202],
    ['an author who hid the owner', {}, 205],
    ['an author the owner blocked', {}, 206],
    ['an author the owner hid across their galleries', {}, 203],
    ['an author hidden in this model’s gallery', { hiddenUsers: [AUTHOR] }, 104],
    ['a post whose images are all hidden here', { hiddenImages: { [VERSION]: [1105] } }, 105],
    ['a post with no images', {}, 208],
    ['a post made with another model’s version', {}, 209],
    ['a post removed for a ToS violation', {}, 211],
    ['a private post', {}, 212],
    ['a post whose only image awaits review', {}, 213],
    ['a post whose only image was removed for a ToS violation', {}, 214],
  ] as const)('skips %s', async (_case, extra, postId) => {
    await save({ after: { ...(extra as Settings), pinnedPosts: { [VERSION]: [postId] } } });
    expect(sentTo()).toEqual([]);
  });

  it('still sends when only some of the post’s images are hidden here', async () => {
    await save({
      after: { hiddenImages: { [VERSION]: [1207] }, pinnedPosts: { [VERSION]: [207] } },
    });
    expect(sentTo()).toEqual([{ userId: AUTHOR, key: `model-gallery-post-pinned:${VERSION}:207` }]);
  });

  it('counts a post created on the version even when its images name no resource', async () => {
    await save({ after: { pinnedPosts: { [VERSION]: [210] } } });
    expect(sentTo()).toEqual([{ userId: AUTHOR, key: `model-gallery-post-pinned:${VERSION}:210` }]);
  });

  it('ignores version keys that are not this model’s, so invented keys cannot multiply sends', async () => {
    await save({ after: { pinnedPosts: { 20: [209], 999: [102], [VERSION]: [103] } } });
    expect(sentTo()).toEqual([{ userId: AUTHOR, key: `model-gallery-post-pinned:${VERSION}:103` }]);
  });

  it('sends nothing for a model that is not published', async () => {
    await pg.exec(`UPDATE "Model" SET status = 'Draft' WHERE id = ${MODEL}`);
    onTestFinished(async () => {
      await pg.exec(`UPDATE "Model" SET status = 'Published' WHERE id = ${MODEL}`);
    });
    await save({ after: { pinnedPosts: { [VERSION]: [100] } } });
    expect(sentTo()).toEqual([]);
  });

  it('hidden images are scoped to their version', async () => {
    await save({
      after: {
        hiddenImages: { [VERSION_2]: [1106] },
        pinnedPosts: { [VERSION]: [106], [VERSION_2]: [106] },
      },
    });
    expect(sentTo()).toEqual([{ userId: AUTHOR, key: `model-gallery-post-pinned:${VERSION}:106` }]);
  });

  it('a moderator pinning on someone else’s model notifies nobody', async () => {
    await save({ after: { pinnedPosts: { [VERSION]: [100] } } }, { id: 99, isModerator: true });
    expect(sentTo()).toEqual([]);
  });

  it('a save sends at most 20, one per distinct post and version', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => 100 + i);
    await save({
      after: { pinnedPosts: { [VERSION]: [100, ...twenty], [VERSION_2]: twenty } },
    });
    expect(sentTo()).toHaveLength(20);
    expect(new Set(sentTo().map((s) => s.key)).size).toBe(20);
  });

  it('a notification failure does not fail the save', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValue(new Error('db down') as never);
    await expect(save({ after: { pinnedPosts: { [VERSION]: [100] } } })).resolves.toMatchObject({
      id: MODEL,
    });
  });
});
