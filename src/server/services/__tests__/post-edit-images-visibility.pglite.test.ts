import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as Caches from '~/server/redis/caches';
import type * as TagService from '~/server/services/tag.service';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import type { SessionUser } from '~/types/session';

// getPostEditImages' own `where`, run by Prisma against real Postgres (PGlite). The editor's
// heavy select is not under test, so only the ids come back from the database.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  getDbWithoutLag: vi.fn(async () => dbMock.dbRead),
}));
vi.mock('~/server/services/tag.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TagService>()),
  getVotableImageTags: vi.fn(async () => []),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  return {
    ...actual,
    thumbnailCache: { ...actual.thumbnailCache, fetch: vi.fn(async () => ({})) },
  };
});

const { getPostEditImages } = await import('~/server/services/post.service');

const OWNER = 10;
const POST = 1000;
const CLEAN = 1;
const HELD_CSAM = 2;
const HELD_MINOR = 3;
const OTHER_REVIEW = 4;
const MATURE = 5;
const UNRATED = 6;
const OTHER_UNRATED = 7;
const HELD_UNRATED = 8;

const owner = { id: OWNER } as SessionUser;
const moderator = { id: 99, isModerator: true } as SessionUser;

let harness: Awaited<ReturnType<typeof startPglitePrisma>>;
beforeAll(async () => {
  harness = await startPglitePrisma(`
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, "nsfwLevel" int NOT NULL DEFAULT 1,
      "needsReview" text
    );
  `);
  await harness.pg.exec(`
    INSERT INTO "Image" (id, "userId", "postId", "nsfwLevel", "needsReview") VALUES
      (${CLEAN}, ${OWNER}, ${POST}, 1, NULL),
      (${HELD_CSAM}, ${OWNER}, ${POST}, 1, 'csam'),
      (${HELD_MINOR}, ${OWNER}, ${POST}, 1, 'minor'),
      (${OTHER_REVIEW}, ${OWNER}, ${POST}, 1, 'poi'),
      (${MATURE}, ${OWNER}, ${POST}, 16, NULL),
      (${UNRATED}, ${OWNER}, ${POST}, 0, NULL),
      (${OTHER_UNRATED}, 11, ${POST}, 0, NULL),
      (${HELD_UNRATED}, ${OWNER}, ${POST}, 0, 'csam');
  `);
  dbMock.dbRead.image.findMany.mockImplementation((async (args: { where: object }) =>
    (await harness.prisma.image.findMany({ where: args.where, select: { id: true } })).map(
      (row) => ({ ...row, index: row.id, tools: [], techniques: [] })
    )) as never);
});
afterAll(() => harness.stop());

const editorIds = async (user: SessionUser, servableLevels = allBrowsingLevelsFlag) =>
  (await getPostEditImages({ id: POST, user, servableLevels })).map((i) => i.id);

describe('getPostEditImages: images held for review', () => {
  it('leaves held images out of the owner’s editor and keeps every other image', async () => {
    expect(await editorIds(owner)).toEqual([CLEAN, OTHER_REVIEW, MATURE, UNRATED, OTHER_UNRATED]);
  });

  it('keeps them for a moderator', async () => {
    expect(await editorIds(moderator)).toEqual([
      CLEAN,
      HELD_CSAM,
      HELD_MINOR,
      OTHER_REVIEW,
      MATURE,
      UNRATED,
      OTHER_UNRATED,
      HELD_UNRATED,
    ]);
  });
});

describe('getPostEditImages: the request level cap', () => {
  it('a capped request gets no image above the cap, and no unrated one but the owner’s own', async () => {
    expect(await editorIds(owner, sfwBrowsingLevelsFlag)).toEqual([CLEAN, OTHER_REVIEW, UNRATED]);
  });

  it('holds a moderator to the cap as well, unrated images of others included', async () => {
    expect(await editorIds(moderator, sfwBrowsingLevelsFlag)).toEqual([
      CLEAN,
      HELD_CSAM,
      HELD_MINOR,
      OTHER_REVIEW,
    ]);
  });
});
