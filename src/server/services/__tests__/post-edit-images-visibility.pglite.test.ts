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
// heavy select is not under test: the ids and block fields come back, with a stand-in url.

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
const OTHERS_HELD = 9;
const BLOCKED_POST = 2000;
const BLOCKED_POST_CLEAN = 20;
const MOD_BLOCKED = 21;
const SCAN_BLOCKED = 22;
const METADATA_HOLD = 23;
const RATED_BLOCKED = 24;

const owner = { id: OWNER } as SessionUser;
const moderator = { id: 99, isModerator: true } as SessionUser;

let harness: Awaited<ReturnType<typeof startPglitePrisma>>;
beforeAll(async () => {
  harness = await startPglitePrisma(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, "nsfwLevel" int NOT NULL DEFAULT 1,
      "needsReview" text, ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
      "blockedFor" text
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
      (${HELD_UNRATED}, ${OWNER}, ${POST}, 0, 'csam'),
      (${OTHERS_HELD}, 11, ${POST}, 1, 'minor');
    INSERT INTO "Image" (id, "userId", "postId", "nsfwLevel", ingestion, "blockedFor") VALUES
      (${BLOCKED_POST_CLEAN}, ${OWNER}, ${BLOCKED_POST}, 1, 'Scanned', NULL),
      (${MOD_BLOCKED}, ${OWNER}, ${BLOCKED_POST}, 32, 'Blocked', 'moderated'),
      (${SCAN_BLOCKED}, ${OWNER}, ${BLOCKED_POST}, 1, 'Blocked', NULL),
      (${METADATA_HOLD}, ${OWNER}, ${BLOCKED_POST}, 1, 'Blocked', 'AiNotVerified'),
      (${RATED_BLOCKED}, ${OWNER}, ${BLOCKED_POST}, 32, 'Scanned', NULL);
  `);
  dbMock.dbRead.image.findMany.mockImplementation((async (args: { where: object }) =>
    (
      await harness.prisma.image.findMany({
        where: args.where,
        select: { id: true, nsfwLevel: true, ingestion: true, blockedFor: true },
      })
    ).map((row) => ({
      ...row,
      url: `media-${row.id}`,
      hash: 'blur-hash',
      meta: { prompt: 'p', image: `https://image.example/source-${row.id}.png` },
      metadata: null,
      index: row.id,
      tools: [],
      techniques: [],
    }))) as never);
});
afterAll(() => harness.stop());

// A session, or a full-access key: the request carries the owner's view.
const editorIds = async (
  user: SessionUser,
  servableLevels = allBrowsingLevelsFlag,
  ownerSeesHeld = true
) =>
  (
    await getPostEditImages({
      id: POST,
      user,
      servableLevels,
      ownerSeesHeld,
      asModerator: !!user.isModerator,
    })
  ).map((i) => i.id);

describe('getPostEditImages: images held for review', () => {
  it('shows the owner their own held images, and leaves out a held image of another user', async () => {
    expect(await editorIds(owner)).toEqual([
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

  it("leaves the owner's held images out without the owner's view (a scoped key or app token)", async () => {
    expect(await editorIds(owner, allBrowsingLevelsFlag, false)).toEqual([
      CLEAN,
      OTHER_REVIEW,
      MATURE,
      UNRATED,
      OTHER_UNRATED,
    ]);
  });

  it("shows a signed-in editor their own held image, and none of another uploader's", async () => {
    const other = { id: 11 } as SessionUser;
    expect(await editorIds(other)).toEqual([
      CLEAN,
      OTHER_REVIEW,
      MATURE,
      UNRATED,
      OTHER_UNRATED,
      OTHERS_HELD,
    ]);
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
      OTHERS_HELD,
    ]);
  });
});

describe('getPostEditImages: the request level cap', () => {
  it('a capped request gets no image above the cap, and no unrated one but the owner’s own', async () => {
    expect(await editorIds(owner, sfwBrowsingLevelsFlag)).toEqual([
      CLEAN,
      HELD_CSAM,
      HELD_MINOR,
      OTHER_REVIEW,
      UNRATED,
      HELD_UNRATED,
    ]);
  });

  it('holds a moderator to the cap as well, unrated images of others included', async () => {
    expect(await editorIds(moderator, sfwBrowsingLevelsFlag)).toEqual([
      CLEAN,
      HELD_CSAM,
      HELD_MINOR,
      OTHER_REVIEW,
      OTHERS_HELD,
    ]);
  });
});

describe('getPostEditImages: blocked images', () => {
  // `asModerator` is `actsAsModerator(ctx)`: a session or a full-access key.
  const blockedPostRows = async (user: SessionUser, asModerator = !!user.isModerator) =>
    (
      await getPostEditImages({
        id: BLOCKED_POST,
        user,
        servableLevels: allBrowsingLevelsFlag,
        ownerSeesHeld: true,
        asModerator,
      })
    ).map(({ id, url, hash, thumbnailUrl, blockedFor, ingestion, meta }) => ({
      id,
      url,
      hash,
      thumbnailUrl,
      blockedFor,
      ingestion,
      sourceImage: (meta as { image?: string } | null)?.image ?? null,
    }));

  // civitai/civitai#10505: the owner keeps the row and its block notice, not the media.
  it('keeps a blocked image for its owner as a notice row with no media', async () => {
    expect(await blockedPostRows(owner)).toEqual([
      expect.objectContaining({
        id: BLOCKED_POST_CLEAN,
        url: `media-${BLOCKED_POST_CLEAN}`,
        hash: 'blur-hash',
      }),
      {
        id: MOD_BLOCKED,
        url: null,
        hash: null,
        thumbnailUrl: null,
        blockedFor: 'moderated',
        ingestion: 'Blocked',
        sourceImage: null,
      },
      {
        id: SCAN_BLOCKED,
        url: null,
        hash: null,
        thumbnailUrl: null,
        blockedFor: null,
        ingestion: 'Blocked',
        sourceImage: null,
      },
      expect.objectContaining({ id: METADATA_HOLD, url: `media-${METADATA_HOLD}` }),
      expect.objectContaining({ id: RATED_BLOCKED, url: `media-${RATED_BLOCKED}` }),
    ]);
  });

  it('serves every one with its media to a moderator', async () => {
    expect((await blockedPostRows(moderator)).map(({ id, url }) => [id, url])).toEqual(
      [BLOCKED_POST_CLEAN, MOD_BLOCKED, SCAN_BLOCKED, METADATA_HOLD, RATED_BLOCKED].map((id) => [
        id,
        `media-${id}`,
      ])
    );
  });

  it('gives a moderator on a scoped key no media of a blocked image', async () => {
    expect((await blockedPostRows(moderator, false)).map(({ id, url }) => [id, url])).toEqual([
      [BLOCKED_POST_CLEAN, `media-${BLOCKED_POST_CLEAN}`],
      [MOD_BLOCKED, null],
      [SCAN_BLOCKED, null],
      [METADATA_HOLD, `media-${METADATA_HOLD}`],
      [RATED_BLOCKED, `media-${RATED_BLOCKED}`],
    ]);
  });
});
