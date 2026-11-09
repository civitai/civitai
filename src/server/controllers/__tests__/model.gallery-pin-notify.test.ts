import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { rowChangesBeforeLock } from '~/server/services/__tests__/model-row-lock.fake';

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

const { mockCreateNotification, mockCreatorHidden } = vi.hoisted(() => ({
  mockCreateNotification: vi.fn(),
  mockCreatorHidden: vi.fn(),
}));
vi.mock('~/server/services/creator-gallery-hidden-users.service', () => ({
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
const AUTHOR = 7;
const pg = new PGlite();

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int NOT NULL, "publishedAt" timestamp);
    CREATE TABLE "Image" (id int PRIMARY KEY, "postId" int NOT NULL);
    CREATE TABLE "UserEngagement" ("userId" int, "targetUserId" int, type text);
  `);
  // Posts 100-119 by AUTHOR, published, one image each (id = post id + 1000).
  for (let p = 100; p < 120; p++) {
    await pg.query(`INSERT INTO "Post" VALUES ($1, $2, now() - interval '1 day')`, [p, AUTHOR]);
    await pg.query(`INSERT INTO "Image" VALUES ($1, $2)`, [p + 1000, p]);
  }
  await pg.exec(`
    INSERT INTO "Post" VALUES (200, ${OWNER}, now() - interval '1 day'); -- the owner's own post
    INSERT INTO "Image" VALUES (1200, 200);
    INSERT INTO "Post" VALUES (201, ${AUTHOR}, NULL);                       -- unpublished
    INSERT INTO "Image" VALUES (1201, 201);
    INSERT INTO "Post" VALUES (202, 8, now() - interval '1 day');          -- author 8 blocked the owner
    INSERT INTO "Image" VALUES (1202, 202);
    INSERT INTO "UserEngagement" VALUES (8, ${OWNER}, 'Block');
    INSERT INTO "Post" VALUES (203, 9, now() - interval '1 day');          -- author 9 is hidden creator-wide
    INSERT INTO "Image" VALUES (1203, 203);
  `);
});
afterAll(() => pg.close());

beforeEach(() => {
  vi.clearAllMocks();
  mockCreatorHidden.mockResolvedValue([9]);
  dbMock.dbRead.$queryRaw.mockImplementation((async (
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

  it('an unpin sends nothing; a re-pin carries the first pin’s key, which the worker never re-delivers', async () => {
    await save({ before: { [VERSION]: [100] }, after: { pinnedPosts: { [VERSION]: [] } } });
    expect(sentTo()).toEqual([]);
    await save({ before: { [VERSION]: [] }, after: { pinnedPosts: { [VERSION]: [100] } } });
    expect(sentTo()).toEqual([{ userId: AUTHOR, key: `model-gallery-post-pinned:${VERSION}:100` }]);
  });

  it.each([
    ['the owner’s own post', {}, 200],
    ['an unpublished post', {}, 201],
    ['an author in a block with the owner', {}, 202],
    ['an author the owner hid across their galleries', {}, 203],
    ['an author hidden in this model’s gallery', { hiddenUsers: [AUTHOR] }, 104],
    ['a post whose images are all hidden here', { hiddenImages: { [VERSION]: [1105] } }, 105],
  ] as const)('skips %s', async (_case, extra, postId) => {
    await save({ after: { ...extra, pinnedPosts: { [VERSION]: [postId] } } });
    expect(sentTo()).toEqual([]);
  });

  it('a moderator pinning on someone else’s model notifies nobody', async () => {
    await save({ after: { pinnedPosts: { [VERSION]: [100] } } }, { id: 99, isModerator: true });
    expect(sentTo()).toEqual([]);
  });

  it('a save pinning the full 20 sends at most one per post', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => 100 + i);
    await save({ after: { pinnedPosts: { [VERSION]: twenty } } });
    expect(sentTo()).toHaveLength(20);
    expect(new Set(sentTo().map((s) => s.key)).size).toBe(20);
  });

  it('a notification failure does not fail the save', async () => {
    dbMock.dbRead.$queryRaw.mockRejectedValue(new Error('replica down') as never);
    await expect(save({ after: { pinnedPosts: { [VERSION]: [100] } } })).resolves.toMatchObject({
      id: MODEL,
    });
  });
});
